// Getting the backlog to the server.
//
// Nothing here can fail a launch, and nothing here is worth retrying inside one
// attempt: the emulator has already exited, the player has already moved on, and
// the queue is what makes a failure temporary. So this sends what it can, drops
// what the server has judged, and leaves the rest where it was.

import { type Session } from "electron";
import { type DesktopConfig } from "../../shared/types.ts";
import { playQueuePath } from "../config.ts";
import { ensureDeviceId } from "../saves/device.ts";
import { apiRequest } from "../saves/http.ts";
import { dequeue, pruneQueue } from "./queue.ts";
import {
  forAccount,
  inBatches,
  shouldRetry,
  toEntries,
  userIdFrom,
} from "./session.ts";

const INGEST_PATH = "/api/play-sessions";

/** What RomM's own frontend asks to find out who it is talking for. */
const ME_PATH = "/api/users/me";

interface ReportOptions {
  config: DesktopConfig;
  session: Session;
  signal: AbortSignal;
}

/**
 * Send everything queued, in batches the server accepts.
 *
 * Stops at the first batch that did not reach the server: a second attempt over
 * the same dead network is the same answer, and what it would cost is the quit
 * path waiting on it.
 */
async function flushPlaySessions(options: ReportOptions): Promise<void> {
  const { config, session, signal } = options;
  // Deliberately not gated on `trackPlaySessions`. That setting decides whether
  // a launch is recorded; turning it off is not a reason to strand the sessions
  // recorded while it was on, which the user was told would still be sent.
  const { serverUrl } = config;
  if (!serverUrl) return;

  const backlog = await pruneQueue(playQueuePath());
  if (backlog.length === 0) return;
  // Never infer record ownership from the account doing the flushing. A
  // paired launch can finish after another account has already signed in.
  const userId = await currentUserId({ config, session, signal });
  if (userId === null) return;
  const queued = forAccount(backlog, serverUrl, userId);
  if (queued.length === 0) return;

  // The same id the saves sync as, so RomM attributes both to one machine and
  // dedupes a resent session against the row it already has.
  const deviceId = await ensureDeviceId({ config, session, signal });
  // Without one, nothing is sent. The server would take the session and store it
  // against no machine, which cannot be corrected afterwards and moves the
  // dedupe key: a later resend carrying a real id would not match the row
  // already there. Waiting costs a flush, and the queue is what waiting is for.
  if (deviceId === null) return;

  for (const batch of inBatches(queued)) {
    const response = await apiRequest({
      serverUrl,
      session,
      path: INGEST_PATH,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: deviceId,
        sessions: toEntries(batch),
      }),
      signal,
    });
    if (!response) return;
    if (shouldRetry(response.status)) return;
    // Taken or judged: either way the server has seen it and would say the same
    // thing again.
    await dequeue(playQueuePath(), batch);
  }
}

/** Who the server says this session belongs to, or null when it would not say. */
export async function currentUserId({
  config,
  session,
  signal,
}: ReportOptions): Promise<number | null> {
  const response = await apiRequest({
    serverUrl: config.serverUrl ?? "",
    session,
    path: ME_PATH,
    method: "GET",
    signal,
  });
  if (!response || response.status >= 300) return null;
  return userIdFrom(response.body);
}

/**
 * Report the backlog, and swallow whatever went wrong doing it.
 *
 * Every caller is past the point of being able to act on a failure: the emulator
 * has exited, or the window has just finished loading. The queue is what carries
 * the answer forward, so the only thing a failure changes is that the records
 * are still in it.
 */
export async function reportPlaySessions(
  options: ReportOptions,
): Promise<void> {
  try {
    await flushPlaySessions(options);
  } catch {
    // Offline, refused, cancelled, a body that was not what it should be.
  }
}
