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
import { dequeue, readQueue } from "./queue.ts";
import {
  inBatches,
  playTrackingEnabled,
  shouldRetry,
  toEntries,
} from "./session.ts";

const INGEST_PATH = "/api/play-sessions";

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
  // The second half is the narrowing the first cannot express; they ask the
  // same question.
  if (!playTrackingEnabled(config) || !config.serverUrl) return;

  const queued = await readQueue(playQueuePath());
  if (queued.length === 0) return;

  // The same id the saves sync as, so RomM attributes both to one machine and
  // dedupes a resent session against the row it already has.
  const deviceId = await ensureDeviceId({ config, session, signal });

  for (const batch of inBatches(queued)) {
    const response = await apiRequest({
      serverUrl: config.serverUrl,
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
