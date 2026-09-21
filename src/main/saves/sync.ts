// Moving a save between the server and the emulator.
//
// A native launch is the one place where the shell owns a save file RomM also
// has a copy of, so it is the one place the two can disagree. What to do about a
// disagreement is decided in plan.ts; this is the part that asks and the part
// that moves bytes, and the rule that shapes all of it is that nothing here may
// lose a save.
//
// Three entry points. `pullSave` runs before the emulator starts: it asks what
// the server has and writes it to disk when the server's copy should win.
// `pushSave` runs after the emulator exits and sends what changed. `watchSave`
// covers the hours in between, offering what the emulator writes as it writes
// it, so a launch does not rest on a single reading taken at one moment.
//
// Like the firmware mirror, none of this can fail a launch. A server that cannot
// be reached, a user without the right scope, a device the server has forgotten
// and a body that is not the shape it should be all end the same way: no save
// moves, and the game starts anyway.

import { type Session } from "electron";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type DesktopConfig, type SaveSyncOutcome } from "../../shared/types.ts";
import { isSignedOut } from "../auth/status.ts";
import { toEntries, type PlaySessionRecord } from "../play/session.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl } from "../safety.ts";
import { ensureDeviceId, forgetDeviceId } from "./device.ts";
import { hashFile, md5Hex } from "./hash.ts";
import { apiRequest } from "./http.ts";
import { inTurn } from "./lock.ts";
import { saveUploadBody } from "./multipart.ts";
import {
  archiveName,
  AUTOSAVE_SLOT,
  buildNegotiatePayload,
  MAX_SAVE_BYTES,
  planPull,
  planPush,
  planTick,
  selectOperation,
  storedSave,
  type Allowance,
  type LocalSave,
  type SaveStamp,
  type SyncOperation,
} from "./plan.ts";

/** Where a half-written download sits until it is complete. Leading dot, so it
 *  is never mistaken for the save itself by anything listing the directory. */
function tempNameFor(fileName: string): string {
  return `.${fileName}.part`;
}

/** Whether a launch should sync at all. */
export function saveSyncEnabled(config: DesktopConfig): boolean {
  return Boolean(config.syncSaves && config.serverUrl);
}

/**
 * What the save on disk is right now, or null when there is nothing there.
 *
 * The modification time is carried alongside the digest because the negotiation
 * is decided on it, and it has to be the time of the bytes being described: a
 * stat taken separately from the hash could describe a different version of the
 * file, which on a device with no sync history is the difference between an
 * upload and a download.
 */
async function readLocal(
  path: string,
): Promise<{ stamp: SaveStamp; updatedAt: Date } | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  return {
    stamp: { hash: await hashFile(path), size: info.size },
    updatedAt: info.mtime,
  };
}

type Negotiation =
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
 */
async function negotiate(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  romId: number;
  local: LocalSave | null;
  signal: AbortSignal;
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
      ...buildNegotiatePayload(romId, local),
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
    operation: selectOperation(body.operations, romId),
  };
}

type UploadResult =
  | { kind: "ok" }
  /** The slot moved on since this device last saw it. */
  | { kind: "conflict" }
  | { kind: "failed"; detail: string };

/**
 * Send one save, either into the autosave slot or as an archival save.
 *
 * `overwrite` is always false. That is the invariant, not a default: a save
 * already in the slot that this device has not seen is never replaced, and the
 * server answers 409 to say so rather than letting this overwrite it.
 */
async function upload(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  romId: number;
  fileName: string;
  bytes: Uint8Array;
  slot: string | null;
  signal: AbortSignal;
}): Promise<UploadResult> {
  const { serverUrl, session, deviceId, romId, fileName, bytes, slot, signal } =
    options;

  const params = new URLSearchParams({
    rom_id: String(romId),
    device_id: deviceId,
    overwrite: "false",
  });
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
  if (!storedSave(response.body)) {
    return { kind: "failed", detail: "the server did not answer with a save" };
  }
  return { kind: "ok" };
}

/**
 * Write the server's save over the local one.
 *
 * Downloaded to a temporary name and renamed only once the bytes have been
 * checked against the digest the negotiation reported. The rename is what makes
 * this destructive, so it is the last thing that happens and it does not happen
 * on a transfer that cannot be confirmed: a truncated response would otherwise
 * replace a working save with half of one.
 */
async function download(options: {
  serverUrl: string;
  session: Session;
  deviceId: string;
  saveId: number;
  target: string;
  expectedHash: string | null;
  signal: AbortSignal;
}): Promise<boolean> {
  const { serverUrl, session, deviceId, saveId, target, expectedHash, signal } =
    options;

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

  const temp = join(dirname(target), tempNameFor(basename(target)));
  try {
    // The launcher creates the directory this launch uses, but a save pull is
    // not always the first thing to touch it and a download into a directory
    // that does not exist fails in a way that reads as "the server was down".
    await mkdir(dirname(target), { recursive: true });
    await downloadFromServer({
      url,
      session,
      destination: temp,
      signal,
      maxBytes: MAX_SAVE_BYTES,
      // A save is kilobytes where a ROM is gigabytes, and the launch already
      // reports that it is syncing. A byte count per tenth of a second would be
      // noise with nothing to attach it to.
      onProgress: () => {},
    });

    if (expectedHash !== null && (await hashFile(temp)) !== expectedHash) {
      await rm(temp, { force: true });
      return false;
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    // A cancel is the launch's own and has to reach it. Anything else is one
    // save that did not move, which is not this code's call to make fatal.
    if (signal.aborted) throw error;
    return false;
  }

  // Tell the server the save landed, which is what records this device's
  // baseline for it. A failure here costs the baseline and nothing else: the
  // file is already on disk, where the emulator will find it, and the next
  // negotiation simply has no history to compare against.
  await apiRequest({
    serverUrl,
    session,
    path: `/api/saves/${saveId}/downloaded`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId }),
    signal,
  }).catch(() => undefined);

  return true;
}

export interface PullOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  /** The exact SRAM file the emulator will be told to use. */
  saveFile: string;
  signal: AbortSignal;
}

export interface PullResult {
  /** What the push after exit is allowed to do. */
  allowance: Allowance;
  /** What was on disk when the emulator started. */
  before: SaveStamp | null;
  deviceId: string | null;
  sessionId: number | null;
  /** What to tell the renderer, or null when nothing moved. */
  outcome: SaveSyncOutcome | null;
}

/**
 * Bring the server's save down before the emulator starts.
 *
 * Runs before the spawn and blocks it, which is the only time the local file can
 * be replaced without racing the emulator for it. Aborting the launch aborts
 * the transfers, and the abort is re-thrown rather than swallowed, so a cancel
 * reads as a cancel rather than as a save that failed to sync.
 */
export function pullSave(options: PullOptions): Promise<PullResult> {
  // The game's save file is the resource, not the game. The launch this one is
  // most likely to be queued behind is the previous launch of the same game,
  // still uploading what the player just did: renaming the server's copy over
  // the file underneath that upload is how the wrong bytes end up on both ends.
  return inTurn(options.saveFile, () => runPull(options));
}

async function runPull({
  config,
  session,
  romId,
  saveFile,
  signal,
}: PullOptions): Promise<PullResult> {
  const local = await readLocal(saveFile);
  const idle: PullResult = {
    allowance: "unreachable",
    before: local?.stamp ?? null,
    deviceId: null,
    sessionId: null,
    outcome: null,
  };

  const serverUrl = config.serverUrl;
  if (!serverUrl) return idle;

  let deviceId = await ensureDeviceId({ config, session, signal });
  if (!deviceId) return idle;

  const ask = (id: string) =>
    negotiate({
      serverUrl,
      session,
      deviceId: id,
      romId,
      local: local && {
        fileName: basename(saveFile),
        contentHash: local.stamp.hash,
        updatedAt: local.updatedAt,
        sizeBytes: local.stamp.size,
      },
      signal,
    });

  let negotiation = await ask(deviceId);

  // The device row is gone: deleted from the device list, or a database that
  // was restored without it. Registering again is the recovery, and it happens
  // once: an id that is rejected twice is not a stale id.
  if (negotiation.kind === "unknown-device") {
    await forgetDeviceId();
    // The config in hand still holds the id the server just refused, so the one
    // passed in has to be cleared too or registration would be skipped.
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
  const plan = planPull(operation, local?.stamp ?? null);
  // Recomputed here rather than reused, because the emulator is about to start
  // against whatever is on disk now, and that is what the push has to compare
  // against.
  let before = local?.stamp ?? null;
  let outcome: SaveSyncOutcome | null = null;

  if (plan.archiveFirst && local) {
    // The server's copy is about to be written over bytes whose content it does
    // not already hold. Unless those bytes go somewhere first, the pull does not
    // happen: this is the case a device with no sync history can reach on a
    // timestamp alone, and losing the only copy of a save is not a recoverable
    // outcome to be optimistic about.
    const bytes = await readFile(saveFile).catch(() => null);
    const archived = bytes
      ? await upload({
          serverUrl,
          session,
          deviceId,
          romId,
          fileName: archiveName(basename(saveFile), new Date()),
          bytes,
          slot: null,
          signal,
        })
      : null;
    if (!archived || archived.kind !== "ok") {
      // Nothing was pulled, so the local copy is still the one on disk and the
      // push after exit is still free to send it.
      return {
        allowance: plan.allowance,
        before,
        deviceId,
        sessionId,
        outcome,
      };
    }
  }

  if (plan.pull && operation?.save_id != null) {
    const pulled = await download({
      serverUrl,
      session,
      deviceId,
      saveId: operation.save_id,
      target: saveFile,
      expectedHash: operation.server_content_hash,
      signal,
    });
    if (pulled) {
      before = (await readLocal(saveFile))?.stamp ?? null;
      outcome = { action: "downloaded", slot: operation.slot };
    }
  }

  return { allowance: plan.allowance, before, deviceId, sessionId, outcome };
}

export interface PushOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  saveFile: string;
  deviceId: string;
  /** What was on disk when the emulator started. */
  before: SaveStamp | null;
  allowance: Allowance;
  signal: AbortSignal;
}

/**
 * Send what the emulator left behind, if it left anything new.
 *
 * Detached: the launch reports the emulator's exit immediately rather than
 * waiting for an upload, so this resolves on its own and its result is pushed to
 * the renderer as a separate status. Returns null when there is nothing worth
 * reporting, which is the common case, because most launches end with the
 * emulator having written nothing.
 */
export function pushSave(
  options: PushOptions,
): Promise<SaveSyncOutcome | null> {
  // The same turn the pull takes, for the same reason and against the same
  // launch: this reads the file to decide whether to send it and then sends
  // what it read, and a relaunch pulling in between would make those two
  // different files.
  return inTurn(options.saveFile, () => runPush(options)).then(
    (result) => result.outcome,
  );
}

interface PushResult {
  outcome: SaveSyncOutcome | null;
  /** What the server holds because of this push, when it sent anything. The
   *  watcher carries it forward as its baseline. */
  sent: SaveStamp | null;
}

async function runPush({
  config,
  session,
  romId,
  saveFile,
  deviceId,
  before,
  allowance,
  signal,
}: PushOptions): Promise<PushResult> {
  const idle: PushResult = { outcome: null, sent: null };

  const serverUrl = config.serverUrl;
  if (!serverUrl) return idle;

  // Read once, so the digest that decides whether to send and the bytes that are
  // sent are the same bytes. Hashing and then re-reading could describe two
  // versions of a file that has only one of them on disk.
  const bytes = await readFile(saveFile).catch(() => null);
  const after: SaveStamp | null = bytes
    ? { hash: md5Hex(bytes), size: bytes.length }
    : null;

  // Said out loud, both of them, because declining makes no request: the
  // server's log is silent too, and from outside "the save did not sync" and
  // "there was no new save" look identical.
  if (!bytes || !after) {
    console.info(`[saves] rom ${romId}: no save on disk at ${saveFile}`);
    return idle;
  }

  const action = planPush(before, after, allowance);
  if (action === "none") {
    console.info(
      `[saves] rom ${romId}: nothing to send, ${
        allowance === "unreachable"
          ? "the negotiation never happened"
          : "the save is unchanged"
      }`,
    );
    return idle;
  }

  // A conflict already had its answer decided before the emulator ran: the
  // server's slot holds progress this device has not seen, so the local bytes
  // are archived rather than offered to it.
  const wantSlot = action === "push";
  const archive = () =>
    upload({
      serverUrl,
      session,
      deviceId,
      romId,
      fileName: archiveName(basename(saveFile), new Date()),
      bytes,
      slot: null,
      signal,
    });

  // An archival save is paired with nothing, but the server holds these bytes
  // once it lands either way, and that is what `sent` means: not "the slot now
  // reads this" but "there is no point offering this again".
  const filed = async (): Promise<PushResult> => {
    const archived = await archive();
    return archived.kind === "ok"
      ? { outcome: { action: "archived" }, sent: after }
      : {
          outcome: { action: "failed", detail: describe(archived) },
          sent: null,
        };
  };

  if (!wantSlot) return filed();

  const uploaded = await upload({
    serverUrl,
    session,
    deviceId,
    romId,
    fileName: basename(saveFile),
    bytes,
    slot: AUTOSAVE_SLOT,
    signal,
  });
  if (uploaded.kind === "ok") {
    return {
      outcome: { action: "uploaded", slot: AUTOSAVE_SLOT },
      sent: after,
    };
  }
  if (uploaded.kind === "conflict") {
    // The slot moved on between the negotiation and now, or this device's
    // baseline is older than what is in it. Retrying the same upload would be
    // refused identically, so the local bytes go up as an archival save, which
    // is paired with nothing and therefore replaces nothing.
    return filed();
  }
  return {
    outcome: { action: "failed", detail: describe(uploaded) },
    sent: null,
  };
}

function describe(result: UploadResult): string {
  return result.kind === "failed" ? result.detail : "upload refused";
}

/**
 * How often the save file is looked at while the emulator runs.
 *
 * Matched to the interval the shell asks RetroArch for, since that is what
 * decides when there is anything new to see. Two agreeing readings are needed
 * before a save is offered, so one lands on the server an interval after the
 * emulator writes it.
 */
export const SAVE_WATCH_INTERVAL_MS = 10_000;

export interface WatchOptions extends PushOptions {
  /** Told about each save this sends, so the renderer can say so while the game
   *  is still running. */
  onSent?: (outcome: SaveSyncOutcome) => void;
  intervalMs?: number;
}

export interface SaveWatch {
  /** Stop looking, and wait for anything in flight to finish. */
  stop(): Promise<void>;
  /** What the server holds now, which is what the push after the exit has to
   *  compare against. */
  baseline(): SaveStamp | null;
  /** The saves sent while the emulator ran. */
  sent(): readonly SaveSyncOutcome[];
}

/**
 * Send what the emulator writes while it is still running.
 *
 * The push at the other end of a launch is one reading of one file at one
 * moment, and everything has to line up for it: the emulator has to have
 * flushed its save, and the process the shell spawned has to be the one that
 * ends when the game does. A launcher script, a Flatpak wrapper and an emulator
 * that hands the content to an instance already running all break the second
 * half of that; a crash or a kill breaks the first.
 *
 * So this is the browser player's answer in the shape a shell can manage.
 * EmulatorJS forces a flush every second and uploads what changed
 * (`pollSaveFiles` in RomM's `frontend/src/views/Player/EmulatorJS/utils.ts`);
 * here the flush is RetroArch's own, asked for with autosave_interval, and this
 * watches the file it writes.
 *
 * It decides nothing the push does not: the same planPush against the same
 * allowance, with the baseline moving forward as saves land. Like everything
 * else here, it cannot fail a launch.
 */
export function watchSave(options: WatchOptions): SaveWatch {
  const {
    saveFile,
    before,
    signal,
    intervalMs = SAVE_WATCH_INTERVAL_MS,
    onSent,
  } = options;

  let baseline = before;
  let previous = before;
  /** The bytes already offered, so a refusal is not retried every interval. The
   *  push after the exit is the retry, and it runs whatever happens here. */
  let offered: string | null = null;
  const sent: SaveSyncOutcome[] = [];
  let stopped = false;
  // Ticks are chained rather than concurrent: an upload can outlast an
  // interval, and two pushes of one file would race for the same slot.
  let settled: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped || signal.aborted) return;

    const reading = (await readLocal(saveFile))?.stamp ?? null;
    const worthOffering = planTick(previous, reading, baseline);
    previous = reading;
    if (!worthOffering || !reading || reading.hash === offered) return;
    offered = reading.hash;

    const { outcome, sent: stored } = await inTurn(saveFile, () =>
      runPush({ ...options, before: baseline }),
    );
    if (!outcome || outcome.action === "failed") return;
    // The push reads the file itself, so what it sent is what moves the
    // baseline; the reading above only decided that it was worth asking.
    baseline = stored ?? reading;
    sent.push(outcome);
    onSent?.(outcome);
  };

  const timer = setInterval(() => {
    settled = settled.then(tick).catch(() => undefined);
  }, intervalMs);
  // A game runs for hours, and this timer is not a reason to keep the process
  // alive on its own.
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await settled;
    },
    baseline: () => baseline,
    sent: () => sent,
  };
}

/**
 * Close the sync session, so it is not left open for good.
 *
 * Best effort by design: the saves have already moved or not, and a session that
 * fails to close is a stale row rather than a lost save. The counts are what
 * this client did, reported here rather than on each upload -- the upload
 * endpoint also has a counter, and feeding both would count every save twice.
 *
 * The play session that produced these saves rides along, because this endpoint
 * is the only one that pairs the two: a session ingested here is stored against
 * the sync session, so the server can say which play wrote the save it received.
 * Reported as taken only on a 2xx, which is what lets the caller drop it from
 * the queue; anything else leaves it there for the ordinary flush.
 */
export async function completeSync(options: {
  serverUrl: string;
  session: Session;
  sessionId: number;
  completed: number;
  failed: number;
  signal: AbortSignal;
  play?: readonly PlaySessionRecord[];
}): Promise<{ playAccepted: boolean }> {
  const { serverUrl, session, sessionId, completed, failed, signal, play } =
    options;
  const response = await apiRequest({
    serverUrl,
    session,
    path: `/api/sync/sessions/${sessionId}/complete`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operations_completed: completed,
      operations_failed: failed,
      ...(play?.length ? { play_sessions: toEntries(play) } : {}),
    }),
    signal,
  }).catch(() => undefined);

  return {
    playAccepted: Boolean(play?.length && response && response.status < 300),
  };
}
