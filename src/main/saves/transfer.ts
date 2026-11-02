// The requests a save travels by.
//
// Split out of sync.ts because there are two kinds of save now and they share
// every request but none of the bookkeeping. A RetroArch launch owns one file
// and compares it by the md5 of its bytes. A standalone emulator's launch owns
// a set of files under its own save folder, which travels as one zip and is
// compared by the digest of the entries rather than of the archive, so it
// cannot reuse a download that verifies the bytes it wrote.
//
// So the transfers live here, each taking everything it needs as an argument
// and keeping no state, and what to do with them stays with the caller that
// knows which kind of save it is holding. sync.ts is still the RetroArch file's
// three stages; standalone/saves.ts is the set's two.
//
// Like everything else on the save path, nothing here throws for a save that
// did not move. The one exception is the launch's own cancel, which is
// re-thrown so it reads as a cancel rather than as a server that went quiet.

import { type Session } from "electron";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isSignedOut } from "../auth/status.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl } from "../safety.ts";
import { apiRequest } from "./http.ts";
import { saveUploadBody } from "./multipart.ts";
import {
  buildNegotiatePayload,
  MAX_SAVE_BYTES,
  selectOperation,
  storedSave,
  type LocalSave,
  type SyncOperation,
} from "./plan.ts";

export type UploadResult =
  /** `saveId` is the row the server stored these bytes in. */
  | { kind: "ok"; saveId: number }
  /** The slot moved on since this device last saw it. */
  | { kind: "conflict" }
  /** The version this run opened is not there any more, so there is nothing to
   *  write over and the next send opens another. */
  | { kind: "gone" }
  | { kind: "failed"; detail: string };

/** What an upload failure reads as in a log line. */
export function describeUpload(result: UploadResult): string {
  return result.kind === "failed" ? result.detail : "upload refused";
}

export type Negotiation =
  | { kind: "ok"; sessionId: number; operation: SyncOperation | null }
  /** The server does not know this device any more. */
  | { kind: "unknown-device" }
  /** No answer: offline, refused, or a body that is not what it should be. */
  | { kind: "unreachable" };

/**
 * Ask what the server has, for this one ROM.
 *
 * `rom_ids` scopes the answer to the ROM being launched, so the response is
 * about this game rather than the user's whole library, and `saves` carries at
 * most the one local save. Both are read-only scopes: a ROM left out is outside
 * this negotiation, never a deletion.
 *
 * `emulator` names what wrote the save being offered and `accepts` decides
 * which of the server's the launch will take. A standalone emulator's save is
 * a set of files laid out the way that emulator reads them, so a save another
 * one wrote is not a version of it, however recently it landed in the same
 * slot.
 */
export async function negotiate(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  romId: number;
  local: LocalSave | null;
  signal: AbortSignal;
  /** The emulator this launch's save belongs to, or null for a save that is
   *  nobody's in particular, which is what a RetroArch file is. */
  emulator?: string | null;
  /** The emulators whose saves this launch can read, which the server uses to
   *  leave anyone else's out of the pairing. Omitted for a launch that reads
   *  whatever is in the slot. */
  emulators?: readonly string[];
  /** Whether an operation about a save written by this emulator is this
   *  launch's to act on. Defaults to taking every one of them. */
  accepts?: (emulator: string | null) => boolean;
}): Promise<Negotiation> {
  const { serverUrl, session, deviceId, romId, local, signal } = options;

  const response = await apiRequest({
    serverUrl,
    session,
    path: "/api/sync/negotiate",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_id: deviceId,
      ...buildNegotiatePayload(romId, local, {
        emulator: options.emulator ?? null,
        emulators: options.emulators,
      }),
    }),
    signal,
  });
  if (!response) return { kind: "unreachable" };
  if (response.status === 404) return { kind: "unknown-device" };
  if (response.status >= 300) return { kind: "unreachable" };

  const body = response.body as {
    session_id?: unknown;
    operations?: unknown;
  } | null;
  const sessionId = body?.session_id;
  if (typeof sessionId !== "number" || !Array.isArray(body?.operations)) {
    return { kind: "unreachable" };
  }

  return {
    kind: "ok",
    sessionId,
    operation: selectOperation(body.operations, romId, options.accepts),
  };
}

/**
 * Send one save, either into a slot or as an archival save.
 *
 * `overwrite` is always false. That is the invariant, not a default: a save
 * already in the slot that this device has not seen is never replaced, and the
 * server answers 409 to say so rather than letting this overwrite it.
 */
export async function uploadSave(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  romId: number;
  fileName: string;
  bytes: Uint8Array;
  slot: string | null;
  signal: AbortSignal;
  /** Filed under this emulator's name, for a save only it can read. Left out
   *  for a bare file, which is stored where every client looks. */
  emulator?: string | null;
}): Promise<UploadResult> {
  const { serverUrl, session, deviceId, romId, fileName, bytes, slot, signal } =
    options;

  const params = new URLSearchParams({
    rom_id: String(romId),
    device_id: deviceId,
    overwrite: "false",
  });
  if (options.emulator) params.set("emulator", options.emulator);
  if (slot) {
    params.set("slot", slot);
    // Without this a slotted upload mints a version the server never reaps,
    // which is how a slot grows without bound. An archival save has no slot to
    // rotate, so it is left out.
    params.set("autocleanup", "true");
  }

  const body = saveUploadBody(fileName, bytes);
  const response = await apiRequest({
    serverUrl,
    session,
    path: `/api/saves?${params.toString()}`,
    method: "POST",
    headers: { "content-type": body.contentType },
    body: body.body,
    signal,
  });
  if (!response) return { kind: "failed", detail: "no answer from the server" };
  if (response.status === 409) return { kind: "conflict" };
  // Named, because it is the one upload failure with a cause a reader can act
  // on. The save stays on disk and the next launch of this game offers it again.
  if (isSignedOut(response.status)) {
    return { kind: "failed", detail: "signed out of RomM" };
  }
  if (response.status >= 300) {
    return { kind: "failed", detail: `server returned ${response.status}` };
  }
  // A status on its own is not proof the save landed, and this answer is load
  // bearing: the pull archives the local bytes and then writes over them on the
  // strength of an "ok" here, so anything that can forge one can cost the only
  // copy of a save. The endpoint answers with the save it stored, so that is
  // what gets checked for.
  const saveId = storedSave(response.body);
  if (saveId === null) {
    return { kind: "failed", detail: "the server did not answer with a save" };
  }
  return { kind: "ok", saveId };
}

/**
 * Write these bytes over a version this run already opened.
 *
 * The slot is a history, and `POST /api/saves` adds to it: the server stamps
 * every slotted upload with the time it arrived, so a name is never reused and
 * each send is another version. That is right once per launch and wrong every
 * ten seconds after it, which is what a run that reports its save as it plays
 * would otherwise do. So the first send of a run opens the version and the rest
 * of it writes here, the way a browser session updates the save it opened
 * (`saveSave` in RomM's `frontend/src/views/Player/EmulatorJS/utils.ts`).
 *
 * Only ever a version this device opened in this run. The endpoint has no
 * conflict guard of its own, because the caller is supposed to be the client
 * that made the row; pointing it at someone else's version would overwrite
 * progress this device never saw.
 */
export async function updateSaveVersion(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  saveId: number;
  fileName: string;
  bytes: Uint8Array;
  signal: AbortSignal;
}): Promise<UploadResult> {
  const { serverUrl, session, deviceId, saveId, fileName, bytes, signal } =
    options;

  const body = saveUploadBody(fileName, bytes);
  const response = await apiRequest({
    serverUrl,
    session,
    path: `/api/saves/${saveId}?device_id=${encodeURIComponent(deviceId)}`,
    method: "PUT",
    headers: { "content-type": body.contentType },
    body: body.body,
    signal,
  });
  if (!response) return { kind: "failed", detail: "no answer from the server" };
  // Deleted from the save list, or rotated out of the slot while this run held
  // it. Either way the bytes still have somewhere to go: a new version.
  if (response.status === 404) return { kind: "gone" };
  if (isSignedOut(response.status)) {
    return { kind: "failed", detail: "signed out of RomM" };
  }
  if (response.status >= 300) {
    return { kind: "failed", detail: `server returned ${response.status}` };
  }
  const stored = storedSave(response.body);
  if (stored === null) {
    return { kind: "failed", detail: "the server did not answer with a save" };
  }
  return { kind: "ok", saveId: stored };
}

/**
 * Fetch a save's bytes to a path of the caller's choosing.
 *
 * Nothing is verified and nothing is renamed: what proves a transfer arrived
 * whole differs by the kind of save, and the caller is the only side that knows
 * which it asked for. So this writes the file and says whether it got there,
 * and the destination is somewhere a failure can be thrown away from.
 */
export async function fetchSaveContent(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  saveId: number;
  destination: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const { serverUrl, session, deviceId, saveId, destination, signal } = options;

  // `optimistic=false` keeps the server from recording this device as synced on
  // the way out. The baseline is recorded afterwards, by confirming a transfer
  // that actually arrived.
  const path = `/api/saves/${saveId}/content?device_id=${encodeURIComponent(
    deviceId,
  )}&optimistic=false`;
  let url: URL;
  try {
    url = resolveDownloadUrl(serverUrl, path);
  } catch {
    return false;
  }

  try {
    // The launcher creates the directory this launch uses, but a save pull is
    // not always the first thing to touch it and a download into a directory
    // that does not exist fails in a way that reads as "the server was down".
    await mkdir(dirname(destination), { recursive: true });
    await downloadFromServer({
      url,
      session,
      destination,
      signal,
      maxBytes: MAX_SAVE_BYTES,
      // A save is kilobytes where a ROM is gigabytes, and the launch already
      // reports that it is syncing. A byte count per tenth of a second would be
      // noise with nothing to attach it to.
      onProgress: () => {},
    });
    return true;
  } catch (error) {
    await rm(destination, { force: true });
    // A cancel is the launch's own and has to reach it. Anything else is one
    // save that did not move, which is not this code's call to make fatal.
    if (signal.aborted) throw error;
    return false;
  }
}

/**
 * Tell the server a save landed, which is what records this device's baseline
 * for it.
 *
 * A failure here costs the baseline and nothing else: the file is already on
 * disk, where the emulator will find it, and the next negotiation simply has no
 * history to compare against.
 */
export async function confirmDownload(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  saveId: number;
  signal: AbortSignal;
}): Promise<void> {
  const { serverUrl, session, deviceId, saveId, signal } = options;
  await apiRequest({
    serverUrl,
    session,
    path: `/api/saves/${saveId}/downloaded`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId }),
    signal,
  }).catch(() => undefined);
}

/** Where a half-written download sits until it is complete. Leading dot, so it
 *  is never mistaken for the save itself by anything listing the directory. */
export function tempNameFor(fileName: string): string {
  return `.${fileName}.part`;
}
