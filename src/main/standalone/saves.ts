// Moving a standalone emulator's save set between the server and its own
// folder.
//
// The same two stages as saves/sync.ts, against a different unit. There the
// shell owns one file, names it to the emulator and reads it back; here it
// owns a set of files under a folder the emulator owns, decided by RomM's save
// target (set.ts), carried as one zip and compared by the digest of the
// entries, which is what RomM hashes a zip save by.
//
// What that changes, beyond the zipping:
//
// - An incomplete listing syncs nothing. Half a set offered to the slot is a
//   set another device would restore over a whole one, which is the only way
//   this path can lose a save that exists nowhere else.
// - A restore replaces the set rather than merging into it, because a set is
//   compared whole: one file left behind that the server's copy does not hold
//   is a difference every negotiation after it reads as a local change. The
//   bytes it displaces are already on the server by then, which is what
//   `planPull`'s `archiveFirst` is for, and only files this game's target
//   names are ever removed.
// - A slot the server says was emptied is not acted on. Deleting one `.srm`
//   is a file; deleting a set is a game's whole folder on the strength of a
//   row, and the push is held back for that run instead so the deletion is
//   not immediately undone.
// - There is no watching while the game runs. A tick would mean re-reading and
//   re-hashing the whole set, and a memory card folder is not a file to hash
//   every few seconds. The push after the exit is the whole of what a set run
//   has to say.
//
// Like everything on the save path, nothing here may fail a launch, and the
// only thing that leaves is the launch's own cancel.

import { type Session } from "electron";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DesktopConfig,
  type SaveSyncOutcome,
} from "../../shared/types.ts";
import { isWithin } from "../safety.ts";
import { zipContentHash } from "../saves/hash.ts";
import { ensureDeviceId, forgetDeviceId } from "../saves/device.ts";
import { inTurn } from "../saves/lock.ts";
import {
  AUTOSAVE_SLOT,
  planPull,
  planPush,
  type Allowance,
  type SaveStamp,
} from "../saves/plan.ts";
import {
  confirmDownload,
  describeUpload,
  fetchSaveContent,
  negotiate,
  uploadSave,
} from "../saves/transfer.ts";
import { readZipFiles, writeZip, ZipError } from "../zip.ts";
import {
  archiveSetName,
  assembleSet,
  planRestore,
  SET_LIMITS,
  setFileName,
  staleAfterRestore,
  type LocalSet,
  type SaveTarget,
  type SetMember,
} from "./set.ts";
import { listTree } from "./tree.ts";

/**
 * Read this game's set out of the emulator's save folder.
 *
 * The listing and the file reads are the only part of this that is IO; what
 * makes a set, and what makes a folder unreadable as one, is in set.ts where
 * a test can reach it.
 */
async function readSet(
  saveRoot: string,
  target: SaveTarget,
): Promise<LocalSet | null> {
  return assembleSet(await listTree(saveRoot), target, (path) =>
    readFile(join(saveRoot, path)).catch(() => null),
  );
}

/** What the set is, as the negotiation and the push compare it. Null for an
 *  empty one, which is this game having no save here rather than having an
 *  empty save: the two negotiate differently. */
function stampOf(local: LocalSet | null): SaveStamp | null {
  return local && local.members.length > 0 ? local.stamp : null;
}

/** The bytes a set travels as, or null when the archive cannot be built. */
function packSet(members: readonly SetMember[]): Buffer | null {
  try {
    return writeZip(members);
  } catch (error) {
    console.warn("[standalone] could not build the save archive", error);
    return null;
  }
}

export interface SetPullResult {
  /** What the push after exit may do. */
  allowance: Allowance;
  /** The set as it stood when the emulator started. */
  before: SaveStamp | null;
  deviceId: string | null;
  sessionId: number | null;
  outcome: SaveSyncOutcome | null;
}

export interface SetSyncOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  emulatorId: string;
  /** The emulator's save folder for this platform, already joined. */
  saveRoot: string;
  target: SaveTarget;
  /** The ROM's name without its extension, which the archive is named for. */
  base: string;
  signal: AbortSignal;
}

/**
 * Bring the server's set down before the emulator starts.
 *
 * Blocking, like the file pull: this is the only moment the emulator's folder
 * can be written without racing the emulator for it.
 */
export function pullSet(options: SetSyncOptions): Promise<SetPullResult> {
  // The folder is the resource. A relaunch of the same game, still pushing
  // what the player just did, is what this most often queues behind.
  return inTurn(options.saveRoot, () => runPullSet(options));
}

async function runPullSet(options: SetSyncOptions): Promise<SetPullResult> {
  const { config, session, romId, emulatorId, saveRoot, target, signal } =
    options;
  const local = await readSet(saveRoot, target);
  const idle: SetPullResult = {
    allowance: "unreachable",
    before: stampOf(local),
    deviceId: null,
    sessionId: null,
    outcome: null,
  };

  const serverUrl = config.serverUrl;
  if (!serverUrl) return idle;
  if (!local) {
    console.info(
      `[standalone] rom ${romId}: ${saveRoot} could not be read whole, so nothing is synced from it`,
    );
    return idle;
  }

  let deviceId = await ensureDeviceId({ config, session, signal });
  if (!deviceId) return idle;

  const fileName = setFileName(options.base);
  const ask = (id: string) =>
    negotiate({
      serverUrl,
      session,
      deviceId: id,
      romId,
      local: stampOf(local)
        ? {
            fileName,
            contentHash: local.stamp.hash,
            updatedAt: local.updatedAt,
            sizeBytes: local.stamp.size,
          }
        : null,
      signal,
      emulator: emulatorId,
      // Both ends of the same question. The server leaves every other
      // emulator's saves out of the pairing, and an operation about one that
      // reaches here anyway is not this launch's to act on: a set is laid out
      // the way one emulator reads it, and nobody else can.
      emulators: [emulatorId],
      accepts: (emulator) => emulator?.toLowerCase() === emulatorId,
    });

  let negotiation = await ask(deviceId);
  // The device row is gone: deleted from the device list, or a database that
  // was restored without it. Registering again is the recovery, and it happens
  // once: an id that is rejected twice is not a stale id.
  if (negotiation.kind === "unknown-device") {
    await forgetDeviceId();
    const renewed = await ensureDeviceId({
      config: { ...config, deviceId: null },
      session,
      signal,
    });
    if (!renewed) return idle;
    deviceId = renewed;
    negotiation = await ask(deviceId);
  }
  if (negotiation.kind !== "ok") return idle;

  const { sessionId, operation } = negotiation;
  const plan = planPull(operation, stampOf(local));
  console.info(
    `[standalone] rom ${romId}: server says ${operation?.action ?? "nothing"}` +
      ` about ${emulatorId}'s ${local.members.length} save files, ` +
      `this run may ${plan.allowance}`,
  );

  // A deletion is not acted on here. One `.srm` is a file; this is a game's
  // whole folder on the strength of a row, and the set sync has not earned
  // that yet. The push is held back instead, so the run does not simply offer
  // the set back and undo the deletion.
  if (plan.removeLocal) {
    console.info(
      `[standalone] rom ${romId}: the slot was emptied on the server; the local save set is left alone and nothing is sent this run`,
    );
    return {
      allowance: "unreachable",
      before: stampOf(local),
      deviceId,
      sessionId,
      outcome: null,
    };
  }

  if (plan.archiveFirst) {
    // The server's copy is about to replace these files. Unless they go
    // somewhere first the restore does not happen: a device with no sync
    // history can be handed a download on a timestamp alone.
    const bytes = packSet(local.members);
    const archived = bytes
      ? await uploadSave({
          serverUrl,
          session,
          deviceId,
          romId,
          fileName: archiveSetName(options.base, new Date()),
          bytes,
          slot: null,
          emulator: emulatorId,
          signal,
        })
      : null;
    if (!archived || archived.kind !== "ok") {
      console.warn(
        `[standalone] rom ${romId}: could not file the save set this download would replace, so it is not downloaded`,
      );
      return {
        allowance: plan.allowance,
        before: stampOf(local),
        deviceId,
        sessionId,
        outcome: null,
      };
    }
  }

  let before = stampOf(local);
  let allowance = plan.allowance;
  let outcome: SaveSyncOutcome | null = null;
  if (plan.pull && operation?.save_id != null) {
    const restored = await restoreSet({
      serverUrl,
      session,
      deviceId,
      saveId: operation.save_id,
      expectedHash: operation.server_content_hash,
      romId,
      saveRoot,
      target,
      replacing: local.paths,
      signal,
    });
    if (restored) {
      outcome = { action: "downloaded", slot: operation.slot };
      // What the push compares against has to be the set the emulator is
      // about to boot. A folder that cannot be read back is one this run has
      // no opinion about, and re-sending what just arrived is the one wrong
      // answer available here.
      const settled = await readSet(saveRoot, target);
      if (settled) {
        before = stampOf(settled);
      } else {
        console.warn(
          `[standalone] rom ${romId}: ${saveRoot} could not be read back after the restore, so this run sends nothing`,
        );
        allowance = "unreachable";
      }
    }
  }

  return { allowance, before, deviceId, sessionId, outcome };
}

/**
 * Write the server's archive over this game's set.
 *
 * Verified before anything is written, and by the digest of the entries rather
 * than of the bytes: that is what the server reports for a zip save, and a
 * truncated transfer that happened to unpack would otherwise replace a working
 * save with part of one.
 *
 * Members are written before the displaced files are removed, so a failure
 * part way through leaves too many files rather than too few.
 */
async function restoreSet(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  saveId: number;
  expectedHash: string | null;
  romId: number;
  saveRoot: string;
  target: SaveTarget;
  /** The set on disk, which is what the archive replaces. */
  replacing: readonly string[];
  signal: AbortSignal;
}): Promise<boolean> {
  const { romId, saveRoot, target, signal } = options;
  // Somewhere outside the emulator's folder: a half-written archive left in
  // the save tree is a file the next listing would read as part of the set.
  const scratch = await mkdtemp(join(tmpdir(), "romm-save-")).catch(() => null);
  if (!scratch) return false;
  const archivePath = join(scratch, "set.zip");

  try {
    const fetched = await fetchSaveContent({
      serverUrl: options.serverUrl,
      session: options.session,
      deviceId: options.deviceId,
      saveId: options.saveId,
      destination: archivePath,
      signal,
    });
    if (!fetched) return false;

    const archive = await readFile(archivePath).catch(() => null);
    if (!archive) return false;

    let members: SetMember[];
    try {
      members = readZipFiles(archive, {
        maxEntries: SET_LIMITS.maxFiles,
        maxTotalBytes: SET_LIMITS.maxBytes,
      }).map((file) => ({
        name: file.name,
        contents: file.contents,
        modifiedAt: file.modifiedAt,
      }));
    } catch (error) {
      console.warn(
        `[standalone] rom ${romId}: the server's save archive could not be read, ${
          error instanceof ZipError ? error.message : "it is not an archive"
        }`,
      );
      return false;
    }

    if (
      options.expectedHash !== null &&
      zipContentHash(members) !== options.expectedHash
    ) {
      console.warn(
        `[standalone] rom ${romId}: the save archive that arrived is not the one the server described, so nothing is written`,
      );
      return false;
    }

    const plan = planRestore(members, target);
    for (const refusal of plan.refused) {
      console.warn(
        `[standalone] rom ${romId}: left ${refusal.name} out of the restore, ${refusal.why}`,
      );
    }
    if (plan.write.length === 0) {
      console.warn(
        `[standalone] rom ${romId}: the server's archive named none of this game's save files`,
      );
      return false;
    }

    // The names were checked as names; this checks the paths they became,
    // which is the thing that actually has to stay inside the folder. All of
    // them before any of them is written: half a restored set on disk is
    // worse than none, and there is nothing to be gained by finding out late.
    const writing = plan.write.map((member) => ({
      member,
      destination: join(saveRoot, member.name),
    }));
    const escaping = writing.find(
      (entry) => !isWithin(saveRoot, entry.destination),
    );
    if (escaping) {
      console.warn(
        `[standalone] rom ${romId}: ${escaping.member.name} resolves outside ${saveRoot}, so nothing is restored`,
      );
      return false;
    }
    for (const { member, destination } of writing) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, member.contents);
    }

    // What the archive did not replace. Left in place it would keep the two
    // sides from ever agreeing again, and the bytes are on the server already.
    for (const path of staleAfterRestore(options.replacing, plan.write)) {
      const stale = join(saveRoot, path);
      if (!isWithin(saveRoot, stale)) continue;
      await rm(stale, { force: true }).catch(() => undefined);
    }

    console.info(
      `[standalone] rom ${romId}: restored ${plan.write.length} save files into ${saveRoot}`,
    );
    await confirmDownload({
      serverUrl: options.serverUrl,
      session: options.session,
      deviceId: options.deviceId,
      saveId: options.saveId,
      signal,
    });
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn(`[standalone] rom ${romId}: the save restore failed`, error);
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface SetPushOptions extends SetSyncOptions {
  deviceId: string;
  before: SaveStamp | null;
  allowance: Allowance;
}

/**
 * Send what the emulator left in its own folder.
 *
 * Detached from the exit, like the file push: the window comes back when the
 * emulator does, and an upload is never what a player waits on.
 */
export function pushSet(
  options: SetPushOptions,
): Promise<SaveSyncOutcome | null> {
  return inTurn(options.saveRoot, () => runPushSet(options));
}

async function runPushSet(
  options: SetPushOptions,
): Promise<SaveSyncOutcome | null> {
  const { config, session, romId, emulatorId, saveRoot, target, signal } =
    options;
  const serverUrl = config.serverUrl;
  if (!serverUrl) return null;

  const local = await readSet(saveRoot, target);
  if (!local) {
    console.info(
      `[standalone] rom ${romId}: ${saveRoot} could not be read whole after the run, so nothing is sent`,
    );
    return null;
  }

  const after = stampOf(local);
  const action = planPush(options.before, after, options.allowance);
  if (action === "none" || !after) {
    console.info(
      `[standalone] rom ${romId}: nothing to send, ${
        options.allowance === "unreachable"
          ? "the negotiation never happened"
          : after
            ? "the save set is unchanged"
            : "the run left no save files"
      }`,
    );
    return null;
  }

  const bytes = packSet(local.members);
  if (!bytes) {
    return { action: "failed", detail: "could not build the archive" };
  }

  const send = (slot: string | null, fileName: string) =>
    uploadSave({
      serverUrl,
      session,
      deviceId: options.deviceId,
      romId,
      fileName,
      bytes,
      slot,
      emulator: emulatorId,
      signal,
    });

  // A conflict already had its answer decided before the emulator ran: the
  // server's slot holds progress this device has not seen, so this run's set
  // is filed beside it rather than offered to it.
  const file = async (): Promise<SaveSyncOutcome> => {
    const archived = await send(null, archiveSetName(options.base, new Date()));
    if (archived.kind === "ok") {
      console.info(
        `[standalone] rom ${romId}: filed ${local.members.length} save files as an archival save`,
      );
      return { action: "archived" };
    }
    console.warn(
      `[standalone] rom ${romId}: could not file an archival save set, ${describeUpload(archived)}`,
    );
    return { action: "failed", detail: describeUpload(archived) };
  };

  if (action === "archive") return file();

  // One version per launch would be the rule if a set were watched as it was
  // written. It is not, so this is the only send of the run and it opens the
  // version rather than writing over one.
  const uploaded = await send(AUTOSAVE_SLOT, setFileName(options.base));
  if (uploaded.kind === "ok") {
    console.info(
      `[standalone] rom ${romId}: opened version ${uploaded.saveId} in the ` +
        `${AUTOSAVE_SLOT} slot with ${local.members.length} save files (${after.size} bytes)`,
    );
    return { action: "uploaded", slot: AUTOSAVE_SLOT };
  }
  if (uploaded.kind === "conflict") {
    console.info(
      `[standalone] rom ${romId}: the ${AUTOSAVE_SLOT} slot moved on, filing this run's save set instead`,
    );
    return file();
  }
  console.warn(
    `[standalone] rom ${romId}: the save set was refused, ${describeUpload(uploaded)}`,
  );
  return { action: "failed", detail: describeUpload(uploaded) };
}
