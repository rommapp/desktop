// Moving a standalone emulator's save set between the server and its own
// folder.
//
// The same two stages as saves/sync.ts against a different unit: there the
// shell owns one file, here a set of files under a folder the emulator owns,
// decided by RomM's save target (set.ts) and carried as one zip.
//
// Four rules the file path does not have:
//
// - An incomplete listing syncs nothing. Half a set in the slot is one
//   another device restores over a whole one.
// - A restore replaces the set rather than merging into it, since a set is
//   compared whole. What it displaces is on the server first (`archiveFirst`)
//   and only files the target names are removed.
// - A slot emptied on the server is not acted on: deleting a set is a game's
//   whole folder. The push is held back for that run instead.
// - No watching during the run; a tick would re-hash the whole set.
//
// Like everything on the save path, nothing here may fail a launch, and the
// only thing that leaves is the launch's own cancel.

import { type Session } from "electron";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
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
      // Both ends of the same question: the server leaves other emulators'
      // saves out of the pairing, and one that reaches here anyway is still
      // not this launch's to act on.
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

  // Not acted on: one `.srm` is a file, this is a game's whole folder. The
  // push is held back instead, so the run does not undo the deletion.
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
    if (restored === "partial") {
      // Part this machine's and part the server's, with nothing on disk to
      // say which is which. The emulator still boots it, because refusing to
      // launch over a save is worse than launching on a mixed one, but what
      // it writes from here is not a version to offer anybody else.
      console.warn(
        `[standalone] rom ${romId}: the restore stopped part way, so ${saveRoot} is partly this machine's and partly the server's; nothing is sent this run`,
      );
      allowance = "unreachable";
    } else if (restored === "restored") {
      outcome = { action: "downloaded", slot: operation.slot };
      // The push has to compare against the set the emulator will boot. A
      // folder that will not read back leaves it nothing to compare, and
      // re-sending what just arrived is the one wrong answer here.
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
 * Why this destination is not one to write, or null when it is.
 *
 * `isWithin` compares the names, which is not the same question: a save root
 * holding a `BLUS30001` symlink keeps every member of that folder lexically
 * inside it while every write lands wherever the link points. The listing
 * skips such a link rather than following it, so nothing above would have
 * noticed. So each step from the root down is checked for being one, the leaf
 * included, and a link anywhere on the way refuses the restore outright
 * rather than being resolved and allowed.
 */
async function unsafeDestination(
  saveRoot: string,
  destination: string,
): Promise<string | null> {
  if (!isWithin(saveRoot, destination)) return `resolves outside ${saveRoot}`;
  const steps = relative(saveRoot, destination).split(sep).filter(Boolean);
  let walked = saveRoot;
  for (const step of steps) {
    walked = join(walked, step);
    const info = await lstat(walked).catch(() => null);
    // Not there yet is the ordinary case: the restore creates it.
    if (info?.isSymbolicLink()) return `sits under a link at ${walked}`;
  }
  return null;
}

/**
 * What a restore did to the folder.
 *
 * The third case is the one that matters. A restore that failed before it
 * wrote anything leaves the set the emulator was going to boot anyway; one
 * that failed after is a set that is partly the server's and partly this
 * machine's, and nothing on disk says which files are which. That mixture is
 * not this run's to offer to the slot, so the caller sends nothing.
 */
type RestoreOutcome = "restored" | "untouched" | "partial";

/**
 * Write the server's archive over this game's set.
 *
 * Verified before anything is written, by the digest of the entries rather
 * than of the bytes: that is what the server reports for a zip save. Members
 * are written before the displaced files are removed, so a failure part way
 * leaves too many files rather than too few.
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
}): Promise<RestoreOutcome> {
  const { romId, saveRoot, target, signal } = options;
  // Somewhere outside the emulator's folder: a half-written archive left in
  // the save tree is a file the next listing would read as part of the set.
  const scratch = await mkdtemp(join(tmpdir(), "romm-save-")).catch(() => null);
  if (!scratch) return "untouched";
  const archivePath = join(scratch, "set.zip");
  // Flipped the moment the folder stops being what the emulator would have
  // booted without this.
  let written = false;

  try {
    const fetched = await fetchSaveContent({
      serverUrl: options.serverUrl,
      session: options.session,
      deviceId: options.deviceId,
      saveId: options.saveId,
      destination: archivePath,
      signal,
    });
    if (!fetched) return "untouched";

    const archive = await readFile(archivePath).catch(() => null);
    if (!archive) return "untouched";

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
      return "untouched";
    }

    if (
      options.expectedHash !== null &&
      zipContentHash(members) !== options.expectedHash
    ) {
      console.warn(
        `[standalone] rom ${romId}: the save archive that arrived is not the one the server described, so nothing is written`,
      );
      return "untouched";
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
      return "untouched";
    }

    // The names were checked as names; this checks the paths they became,
    // following any link on the way down. All of them before any is written:
    // half a restored set is worse than none.
    const writing = plan.write.map((member) => ({
      member,
      destination: join(saveRoot, member.name),
    }));
    for (const entry of writing) {
      const refusal = await unsafeDestination(saveRoot, entry.destination);
      if (refusal) {
        console.warn(
          `[standalone] rom ${romId}: ${entry.member.name} ${refusal}, so nothing is restored`,
        );
        return "untouched";
      }
    }

    // From here the folder is being changed, so a failure is a mixture
    // rather than a no-op and the caller has to be told so.
    written = true;
    for (const { member, destination } of writing) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, member.contents);
    }

    // What the archive did not replace. Left in place it would keep the two
    // sides from ever agreeing again, and the bytes are on the server already.
    // A removal that fails is not swallowed: the leftover would read as a
    // local change on the next negotiation and be offered back as progress.
    for (const path of staleAfterRestore(options.replacing, plan.write)) {
      const stale = join(saveRoot, path);
      if (!isWithin(saveRoot, stale)) continue;
      await rm(stale, { force: true });
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
    return "restored";
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn(`[standalone] rom ${romId}: the save restore failed`, error);
    return written ? "partial" : "untouched";
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface SetPushOptions extends SetSyncOptions {
  deviceId: string;
  before: SaveStamp | null;
  allowance: Allowance;
}

/** Send what the emulator left in its own folder. Detached from the exit: an
 *  upload is never what a player waits on. */
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
