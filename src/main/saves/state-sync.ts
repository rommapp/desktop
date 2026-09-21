// Sending a run's savestates to RomM.
//
// The electron-facing half of the state mirror: what to send is decided in
// states.ts, which stays free of Electron imports so it can be unit tested,
// and this is the part that reads the files and makes the request.

import { type Session } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { isSignedOut } from "../auth/status.ts";
import { apiRequest } from "./http.ts";
import { stateUploadBody } from "./multipart.ts";
import {
  MAX_STATE_BYTES,
  planStates,
  readStateDir,
  stateAssetName,
  THUMBNAIL_SUFFIX,
  type StateEntry,
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
export async function pushStates(
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
