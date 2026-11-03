// Moving PCSX2's and Dolphin's savestates between their own folder and RomM.
//
// The decisions are in states.ts, which stays free of Electron so it can be
// tested; this reads the folder, makes the requests and writes the files.
//
// Two things differ from the RetroArch mirror beside it, and both follow from
// the folder being the emulator's rather than the launch's:
//
// - The name is read, not chosen. RomM's streaming side already files these
//   emulators' states under their own names with a capture stamp, so a push
//   sends that and a restore strips the stamp back off.
// - Every capture is its own row. There is no stable per-slot name to update,
//   so a slot accrues history. That is what RomM does for a streamed session
//   too, and the push only sends what the run actually wrote.
//
// Nothing here can fail a launch, as everywhere else on this path.

import { type Session } from "electron";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { apiRequest } from "../saves/http.ts";
import { inTurn } from "../saves/lock.ts";
import { readPushedFile, rememberPushedRows } from "../saves/pushed.ts";
import {
  MAX_STATE_BYTES,
  MAX_THUMBNAIL_BYTES,
  readStateList,
  type PushedRow,
} from "../saves/states.ts";
import { fetchStateAsset, uploadState } from "../saves/state-sync.ts";
import { extractZipEntry } from "../zip.ts";
import {
  displacedStandaloneName,
  planStandaloneRestore,
  planStandaloneStates,
  pushedSlotKey,
  stampStateName,
  STATE_SCREENSHOT_ENTRY,
  stateScreenshotName,
  statesEmbedScreenshots,
  type StateFile,
  type StateTarget,
} from "./states.ts";

export interface StandaloneStateOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  emulatorId: string;
  /** The emulator's own state folder for this platform, already joined. */
  stateRoot: string;
  /** What RomM says this game is, or null when it could not say. */
  target: StateTarget | null;
  /** A directory of the shell's own, for the record of what this machine
   *  pushed. Not the emulator's folder: the record is the shell's bookkeeping
   *  and has no business sitting among the user's states. */
  recordDir: string;
  signal: AbortSignal;
}

/** The files directly in a state folder. Flat on purpose: both emulators put
 *  their states there and nowhere below it, so a walk would only find other
 *  things to mistake for one. */
export async function readStateFolder(root: string): Promise<StateFile[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const files = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(root, name)).catch(() => null);
      return info?.isFile()
        ? { name, size: info.size, modifiedAt: info.mtimeMs }
        : null;
    }),
  );
  return files.filter((file): file is StateFile => file !== null);
}

/** The picture PCSX2 keeps inside a state, or nothing when there is none to
 *  find. A state with no thumbnail still syncs; it just has no picture. */
function embeddedScreenshot(
  emulatorId: string,
  bytes: Buffer,
): Buffer | null {
  if (!statesEmbedScreenshots(emulatorId)) return null;
  try {
    // Bounded inside the reader rather than after it: the entry's declared
    // size is what gets allocated, so a limit applied to the result is a
    // limit applied too late.
    return extractZipEntry(bytes, STATE_SCREENSHOT_ENTRY, MAX_THUMBNAIL_BYTES);
  } catch {
    // A state with no frame in it, or one this cannot read, still syncs.
    return null;
  }
}

/**
 * Send the states this run wrote.
 *
 * Detached from the exit like every other push, and bounded by what the run
 * changed: a folder of ten slots that nobody touched sends nothing.
 */
export function pushStandaloneStates(
  options: StandaloneStateOptions & { before: readonly StateFile[] },
): Promise<{ uploaded: number; failed: number }> {
  return inTurn(options.stateRoot, () => runPushStates(options));
}

async function runPushStates(
  options: StandaloneStateOptions & { before: readonly StateFile[] },
): Promise<{ uploaded: number; failed: number }> {
  const { config, session, romId, emulatorId, stateRoot, signal } = options;
  const serverUrl = config.serverUrl;
  const result = { uploaded: 0, failed: 0 };
  if (!serverUrl) return result;

  const plan = planStandaloneStates({
    emulatorId,
    before: options.before,
    after: await readStateFolder(stateRoot),
    target: options.target,
    maxBytes: MAX_STATE_BYTES,
  });
  for (const over of plan.tooLarge) {
    console.warn(
      `[standalone] rom ${romId}: ${over.name} is ${over.size} bytes, past the ${MAX_STATE_BYTES} ceiling, so it is not sent`,
    );
  }
  if (plan.foreign > 0) {
    // Worth saying out loud: the folder is shared, and a run that wrote
    // another game's state means the target does not name what it should.
    console.warn(
      `[standalone] rom ${romId}: the run wrote ${plan.foreign} state files RomM's target does not name, which are left alone`,
    );
  }
  if (plan.send.length === 0) return result;

  const landed: Record<string, PushedRow> = {};
  for (const { file, slot } of plan.send) {
    if (signal.aborted) break;
    const bytes = await readFile(join(stateRoot, file.name)).catch(() => null);
    if (!bytes) {
      result.failed += 1;
      continue;
    }
    // Stamped at the moment it is sent, which is what gives a slot a history
    // rather than one row that every run overwrites.
    const fileName = stampStateName(emulatorId, file.name, new Date());
    const picture = embeddedScreenshot(emulatorId, bytes);
    const sent = await uploadState({
      serverUrl,
      session,
      romId,
      emulator: emulatorId,
      fileName,
      bytes,
      mtimeMs: file.modifiedAt,
      screenshot: picture
        ? { fileName: stateScreenshotName(fileName), bytes: picture }
        : null,
      signal,
    });
    if (sent.ok) {
      result.uploaded += 1;
      // What this push left, so the next launch does not archive the slot and
      // fetch these same bytes back: RomM's stamp on the row is later than the
      // file's, so freshness alone would.
      if (sent.row) landed[pushedSlotKey(slot)] = sent.row;
      console.info(
        `[standalone] rom ${romId}: sent slot ${slot} as ${fileName} (${file.size} bytes${picture ? ", with its own frame" : ""})`,
      );
    } else {
      result.failed += 1;
      console.warn(
        `[standalone] rom ${romId}: could not send slot ${slot}, ${sent.detail}`,
      );
    }
  }
  if (Object.keys(landed).length > 0) {
    await rememberPushedRows(options.recordDir, landed);
  }
  return result;
}

/**
 * Bring back the states RomM holds that this launch could load.
 *
 * Before the emulator starts, like the save set: a state written under a
 * running emulator is one it may never read, and one written over a slot it
 * has open is worse.
 */
export function restoreStandaloneStates(
  options: StandaloneStateOptions,
): Promise<number> {
  return inTurn(options.stateRoot, () => runRestoreStates(options));
}

async function runRestoreStates(
  options: StandaloneStateOptions,
): Promise<number> {
  const { config, session, romId, emulatorId, stateRoot, signal } = options;
  const serverUrl = config.serverUrl;
  if (!serverUrl || !options.target) return 0;

  const response = await apiRequest({
    serverUrl,
    session,
    path: `/api/states?rom_id=${romId}`,
    method: "GET",
    signal,
  }).catch(() => null);
  if (!response || response.status >= 300) return 0;

  const onDisk = await readStateFolder(stateRoot);
  const plan = planStandaloneRestore({
    emulatorId,
    rows: readStateList(response.body),
    onDisk,
    target: options.target,
    pushed: await readPushedFile(options.recordDir),
  });
  if (plan.length === 0) return 0;

  let restored = 0;
  for (const entry of plan) {
    if (signal.aborted) break;

    // The slot keeps what it has unless its own bytes are safely in RomM
    // first, the same rule the RetroArch restore follows.
    if (entry.displacing) {
      const kept = await archiveDisplaced({
        serverUrl,
        session,
        romId,
        emulatorId,
        stateRoot,
        file: entry.displacing,
        signal,
      });
      if (!kept) {
        console.warn(
          `[standalone] rom ${romId}: could not file the state in slot ${entry.slot} that this would replace, so it is left alone`,
        );
        continue;
      }
    }

    const landed = await fetchStateAsset({
      serverUrl,
      session,
      directory: stateRoot,
      path: `/api/states/${entry.row.id}/content`,
      fileName: entry.fileName,
      size: entry.row.size,
      maxBytes: MAX_STATE_BYTES,
      signal,
    });
    if (!landed) {
      console.warn(
        `[standalone] rom ${romId}: could not restore slot ${entry.slot} from ${entry.row.fileName}`,
      );
      continue;
    }
    restored += 1;
    console.info(
      `[standalone] rom ${romId}: restored slot ${entry.slot} into ${entry.fileName} (${entry.row.size} bytes)`,
    );
  }
  return restored;
}

/**
 * Put the bytes a restore is about to replace somewhere they survive.
 *
 * Filed under a name no slot pattern matches, so this copy is never picked by
 * a later restore: it is stamped now, which would otherwise make it the newest
 * thing RomM held for the slot and send it straight back next launch.
 */
async function archiveDisplaced(options: {
  serverUrl: string;
  session: Session;
  romId: number;
  emulatorId: string;
  stateRoot: string;
  file: StateFile;
  signal: AbortSignal;
}): Promise<boolean> {
  const { serverUrl, session, romId, emulatorId, stateRoot, file } = options;
  if (file.size > MAX_STATE_BYTES) return false;
  const bytes = await readFile(join(stateRoot, file.name)).catch(() => null);
  if (!bytes) return false;

  const sent = await uploadState({
    serverUrl,
    session,
    romId,
    emulator: emulatorId,
    fileName: displacedStandaloneName(file.name, new Date()),
    bytes,
    mtimeMs: file.modifiedAt,
    screenshot: null,
    signal: options.signal,
  });
  return sent.ok;
}
