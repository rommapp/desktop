// Moving a run's savestates to and from RomM.
//
// The electron-facing half of the state mirror: what to send and what to bring
// back is decided in states.ts, which stays free of Electron imports so it can
// be unit tested, and this is the part that reads the files, makes the requests
// and writes into the state directory.

import { type Session } from "electron";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { isSignedOut } from "../auth/status.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl } from "../safety.ts";
import { apiRequest } from "./http.ts";
import { inTurn } from "./lock.ts";
import { stateUploadBody } from "./multipart.ts";
import {
  displacedStateName,
  MAX_STATE_BYTES,
  MAX_THUMBNAIL_BYTES,
  planStateRestore,
  planStates,
  readStateDir,
  readStateList,
  stateAssetName,
  THUMBNAIL_SUFFIX,
  type StateEntry,
  type StateRestore,
} from "./states.ts";

/** Send one state, with its picture when the emulator took one. */
async function upload(options: {
  serverUrl: string;
  session: Session;
  romId: number;
  emulator: string | null;
  fileName: string;
  bytes: Uint8Array;
  screenshot: { fileName: string; bytes: Uint8Array } | null;
  signal: AbortSignal;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { serverUrl, session, romId, emulator, signal } = options;

  const params = new URLSearchParams({ rom_id: String(romId) });
  // Left out rather than sent empty: it names the directory RomM files the
  // state under, and a blank one is not the same as not saying.
  if (emulator) params.set("emulator", emulator);

  const body = stateUploadBody(
    options.fileName,
    options.bytes,
    options.screenshot,
  );
  const response = await apiRequest({
    serverUrl,
    session,
    path: `/api/states?${params.toString()}`,
    method: "POST",
    headers: { "content-type": body.contentType },
    body: body.body,
    signal,
  });
  if (!response) return { ok: false, detail: "no answer from the server" };
  if (isSignedOut(response.status)) {
    return { ok: false, detail: "signed out of RomM" };
  }
  if (response.status >= 300) {
    return { ok: false, detail: `server returned ${response.status}` };
  }
  return { ok: true };
}

export interface PushStatesOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  /** The directory the launch pinned the emulator's states to. */
  stateDir: string;
  /** The name this game's files carry inside it. */
  base: string;
  /** How this machine reads in the state's name. */
  host: string;
  /** What played it, for the directory RomM files these under. */
  emulator: string | null;
  /** The directory as it was before the emulator started. */
  before: readonly StateEntry[];
  signal: AbortSignal;
}

/**
 * Send the states this run wrote.
 *
 * Runs after the exit has already been reported, like the save push, and like
 * everything else here it cannot fail a launch: a server that will not answer
 * costs the mirror one run, and the next run that touches the same slot offers
 * it again. Returns how many landed, for the log line that is the only trace
 * this leaves.
 */
export function pushStates(
  options: PushStatesOptions,
): Promise<{ uploaded: number; failed: number }> {
  // The state directory is the resource, not the run. This push is detached
  // from the exit that started it, so pressing Play again straight away has the
  // next launch restoring slots into the directory this one is still reading.
  return inTurn(options.stateDir, () => runPush(options));
}

async function runPush(
  options: PushStatesOptions,
): Promise<{ uploaded: number; failed: number }> {
  const { config, session, romId, stateDir, base, host, before, signal } =
    options;
  const serverUrl = config.serverUrl;
  if (!serverUrl) return { uploaded: 0, failed: 0 };

  const after = await readStateDir(stateDir);
  const { send, tooLarge } = planStates({ before, after });

  for (const entry of tooLarge) {
    console.warn(
      `[states] rom ${romId}: ${entry.name} is ${entry.size} bytes, over the ${MAX_STATE_BYTES} this sends`,
    );
  }
  if (send.length === 0) {
    // Which of the two it was, because "no new states" for a run that wrote
    // one too large to send is the log answering a question nobody asked.
    console.info(
      tooLarge.length > 0
        ? `[states] rom ${romId}: nothing sent, every state this run wrote was too large`
        : `[states] rom ${romId}: this run wrote no new states`,
    );
    return { uploaded: 0, failed: tooLarge.length };
  }

  const pictures = new Set(after.map((entry) => entry.name));
  let uploaded = 0;
  // A state too large to send did not make it either, so it counts here.
  let failed = tooLarge.length;

  for (const { entry, slot } of send) {
    if (signal.aborted) break;

    const bytes = await readFile(join(stateDir, entry.name)).catch(() => null);
    if (!bytes) {
      // Written while this run was reading the directory and gone again by the
      // time it got here, which is the emulator's business rather than a fault.
      failed += 1;
      continue;
    }

    const fileName = stateAssetName(base, host, slot);
    // RomM binds a thumbnail to its state by stem, so the picture goes up as
    // the state's own name with .png on the end.
    const thumbnail = `${entry.name}${THUMBNAIL_SUFFIX}`;
    const picture = pictures.has(thumbnail)
      ? await readFile(join(stateDir, thumbnail)).catch(() => null)
      : null;

    const result = await upload({
      serverUrl,
      session,
      romId,
      emulator: options.emulator,
      fileName,
      bytes,
      screenshot: picture
        ? { fileName: `${fileName}${THUMBNAIL_SUFFIX}`, bytes: picture }
        : null,
      signal,
    });
    if (result.ok) {
      uploaded += 1;
      console.info(
        `[states] rom ${romId}: sent ${slot} as ${fileName} (${entry.size} bytes)`,
      );
    } else {
      failed += 1;
      console.warn(
        `[states] rom ${romId}: could not send ${slot}, ${result.detail}`,
      );
    }
  }

  return { uploaded, failed };
}

/** Whether a filesystem error is the file simply not being there, as opposed
 *  to being there and unreadable. The two mean opposite things to a restore. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Where a half-written transfer sits until it is complete. Leading dot, so
 *  nothing listing the directory reads it as a slot: `stateSlot` would call
 *  `.Game.state3.part` nothing at all, and the emulator ignores it too. */
function tempNameFor(fileName: string): string {
  return `.${fileName}.part`;
}

/**
 * Fetch one asset into the state directory under `fileName`.
 *
 * Written to a temporary name and renamed, so a transfer that dies leaves the
 * slot holding what it held rather than a truncated state the emulator would
 * try to load.
 *
 * `size` is the length the row declared, and where there is one it is both the
 * ceiling as the bytes arrive and the test once they have: a truncated 2xx is a
 * plausible thing for a proxy to produce, and a short state is as unloadable as
 * a wrong one. Null is for an asset RomM does not report a length for, where
 * `maxBytes` is all there is to hold the transfer to.
 */
async function fetchAsset(options: {
  serverUrl: string;
  session: Session;
  directory: string;
  path: string;
  fileName: string;
  size: number | null;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<boolean> {
  const { serverUrl, session, directory, fileName, size, signal } = options;
  let url: URL;
  try {
    url = resolveDownloadUrl(serverUrl, options.path);
  } catch {
    return false;
  }

  const target = join(directory, fileName);
  const temp = join(directory, tempNameFor(fileName));
  try {
    await mkdir(directory, { recursive: true });
    await downloadFromServer({
      url,
      session,
      destination: temp,
      signal,
      maxBytes: size ?? options.maxBytes,
      // A state is megabytes where a ROM is gigabytes, and the launch already
      // reports that it is syncing. There is nothing to attach a byte count to.
      onProgress: () => {},
    });
    const written = await stat(temp).catch(() => null);
    const complete =
      written && (size === null ? written.size > 0 : written.size === size);
    if (!complete) {
      await rm(temp, { force: true });
      return false;
    }
    await rename(temp, target);
    return true;
  } catch (error) {
    await rm(temp, { force: true });
    // A cancel is the launch's own and has to reach it. Anything else is one
    // state that did not move, which is not this code's call to make fatal.
    if (signal.aborted) throw error;
    return false;
  }
}

/**
 * Put the right picture beside a restored slot, or no picture at all.
 *
 * RetroArch shows the thumbnail it took next to the slot in its own load menu,
 * so leaving the displaced state's picture there would have the player pick a
 * frame and load something else. Removing it is therefore part of the restore
 * and not a nicety: a slot with no picture is honest, and a slot with the wrong
 * one is not.
 */
async function restoreThumbnail(options: {
  serverUrl: string;
  session: Session;
  directory: string;
  restore: StateRestore;
  signal: AbortSignal;
}): Promise<void> {
  const { serverUrl, session, directory, restore, signal } = options;
  const fileName = `${restore.fileName}${THUMBNAIL_SUFFIX}`;
  const screenshotId = restore.state.screenshotId;

  if (screenshotId !== null) {
    const fetched = await fetchAsset({
      serverUrl,
      session,
      directory,
      path: `/api/screenshots/${screenshotId}/content`,
      fileName,
      // The state row carries the picture's id but not its length, so there is
      // nothing to test the transfer against and the ceiling is all it is held
      // to. A wrong picture is a wrong picture either way, and the line below
      // is what a failed one falls back to.
      size: null,
      maxBytes: MAX_THUMBNAIL_BYTES,
      signal,
    });
    // Not caught: fetchAsset answers false for every failure of its own and
    // throws only on a cancel, which is the launch's and has to reach it.
    if (fetched) return;
  }
  await rm(join(directory, fileName), { force: true }).catch(() => {});
}

export interface PullStatesOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  /** The directory the launch pinned the emulator's states to. */
  stateDir: string;
  /** The name this game's files carry inside it, for the asset name a
   *  displaced state goes up under. */
  base: string;
  /** The names this launch's states could go by locally, best first, for a
   *  slot the directory holds nothing to read a name off. */
  localBases: readonly string[];
  /** How this machine reads in the state's name. */
  host: string;
  /** What is about to play it, which is the whole of what it can load. */
  emulator: string | null;
  signal: AbortSignal;
}

/**
 * Bring RomM's compatible states down before the emulator starts.
 *
 * Runs before the spawn and blocks it, like the save pull: the slots have to be
 * settled before anything can load one, and a state written underneath a
 * running emulator is a state it has already read past.
 *
 * Nothing here can fail a launch. A server that will not answer, a user without
 * the scope to read states, a body that is not the list it should be and a
 * transfer that dies all end the same way: the slots hold what they held, and
 * the game starts.
 */
export function pullStates(
  options: PullStatesOptions,
): Promise<{ restored: number }> {
  return inTurn(options.stateDir, () => runPull(options));
}

async function runPull(
  options: PullStatesOptions,
): Promise<{ restored: number }> {
  const { config, session, romId, stateDir, emulator, signal } = options;
  const serverUrl = config.serverUrl;
  if (!serverUrl) return { restored: 0 };

  const response = await apiRequest({
    serverUrl,
    session,
    path: `/api/states?rom_id=${romId}`,
    method: "GET",
    signal,
  });
  if (!response || response.status >= 300) return { restored: 0 };

  const local = await readStateDir(stateDir);
  // What a transfer that died last time left behind. Before this run's own
  // rather than after, so a launch cancelled mid-state is swept by the next one
  // instead of a sweep having to tell a dead transfer from a live one.
  await sweepOrphanedTemporaries(stateDir);
  const plan = planStateRestore({
    remote: readStateList(response.body),
    local,
    emulator,
    bases: options.localBases,
  });
  if (plan.length === 0) return { restored: 0 };

  let restored = 0;
  for (const restore of plan) {
    if (signal.aborted) break;
    const { state, slot, displaces } = restore;

    // The slot keeps what it has unless its own bytes are safely in RomM.
    if (displaces && !(await archive(options, serverUrl, displaces, slot))) {
      continue;
    }

    const landed = await fetchAsset({
      serverUrl,
      session,
      directory: stateDir,
      path: `/api/states/${state.id}/content`,
      fileName: restore.fileName,
      size: state.size,
      maxBytes: MAX_STATE_BYTES,
      signal,
    });
    if (!landed) {
      console.warn(
        `[states] rom ${romId}: could not restore ${slot} from ${state.fileName}`,
      );
      continue;
    }
    await restoreThumbnail({
      serverUrl,
      session,
      directory: stateDir,
      restore,
      signal,
    });
    restored += 1;
    console.info(
      `[states] rom ${romId}: restored ${slot} from ${state.fileName} into ${restore.fileName} (${state.size} bytes)`,
    );
  }

  return { restored };
}

/**
 * Delete what an earlier transfer that died left behind.
 *
 * A launch cancelled partway through a state leaves one, and nothing else would
 * look at it again unless that same slot happens to be restored another day.
 * Safe to sweep whole rather than by name because the caller holds the
 * directory's turn, so no transfer is in flight beside it.
 */
async function sweepOrphanedTemporaries(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(".") || !name.endsWith(".part")) continue;
    await rm(join(directory, name), { force: true }).catch(() => {});
  }
}

/**
 * Send the state a restore is about to write over, under an archive name.
 *
 * The same rule the save pull follows: the server's copy is written over bytes
 * it may not already hold, so those bytes go up first and the restore is
 * abandoned if they do not land.
 *
 * `displacedStateName` and not this machine's name for the slot, which would
 * file the backup as the slot's newest state and have the next launch restore
 * the bytes this one just replaced. See its own comment.
 */
async function archive(
  options: PullStatesOptions,
  serverUrl: string,
  displaced: StateEntry,
  slot: string,
): Promise<boolean> {
  const { session, romId, stateDir, base, host, emulator, signal } = options;
  if (displaced.size > MAX_STATE_BYTES) {
    console.warn(
      `[states] rom ${romId}: leaving ${slot} as it is, its own state is too large to send first`,
    );
    return false;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(stateDir, displaced.name));
  } catch (error) {
    // Gone between the reading and here leaves nothing to lose, so the restore
    // carries on. Every other failure is bytes that exist and could not be
    // read, and writing over those is the one thing this function is here to
    // prevent -- a permission the emulator has and the shell does not would
    // otherwise cost a state on every launch, silently.
    if (isMissing(error)) return true;
    console.warn(
      `[states] rom ${romId}: leaving ${slot} as it is, its own state could not be read, ${String(error)}`,
    );
    return false;
  }

  const fileName = displacedStateName(base, host, slot, new Date());
  const picture = await readFile(
    join(stateDir, `${displaced.name}${THUMBNAIL_SUFFIX}`),
  ).catch(() => null);
  const result = await upload({
    serverUrl,
    session,
    romId,
    emulator,
    fileName,
    bytes,
    screenshot: picture
      ? { fileName: `${fileName}${THUMBNAIL_SUFFIX}`, bytes: picture }
      : null,
    signal,
  });
  if (!result.ok) {
    console.warn(
      `[states] rom ${romId}: leaving ${slot} as it is, its own state would not go up first, ${result.detail}`,
    );
  }
  return result.ok;
}
