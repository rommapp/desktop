// The play sessions that have not reached the server yet.
//
// A session is finished the moment the emulator exits, and that is exactly when
// the shell is least able to report it: the player may be on a train, the server
// may be down, and the app may be about to quit. Holding the record in memory
// until a request succeeds loses it in all three cases, and a play session is
// not something that can be reconstructed afterwards.
//
// So every finished session is written to disk before anything is sent, and only
// removed once the server has answered about it. That makes delivery at least
// once rather than exactly once, which is sound here and only here: RomM dedupes
// an ingest on (user, device, rom, start_time), so a record sent twice is
// counted once, and a record whose response was lost is safe to send again.
//
// Free of Electron imports: the path comes from the caller, so this can be
// tested against a temporary directory.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inTurn } from "../saves/lock.ts";
import { identityOf, type PlaySessionRecord } from "./session.ts";

export const QUEUE_FILE = "play-sessions.json";

/**
 * How much backlog is kept.
 *
 * A machine that never reaches its server would otherwise grow this file for as
 * long as it is played on. Both bounds drop the oldest first, because the recent
 * sessions are the ones whose loss a player would notice: `last_played` and the
 * ROM's status are driven by the newest session in the batch.
 */
export const MAX_QUEUED = 500;
export const MAX_QUEUED_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is PlaySessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PlaySessionRecord>;
  return (
    typeof candidate.romId === "number" &&
    Number.isInteger(candidate.romId) &&
    (candidate.saveSlot === null || typeof candidate.saveSlot === "string") &&
    typeof candidate.startTime === "string" &&
    typeof candidate.endTime === "string" &&
    typeof candidate.durationMs === "number" &&
    Number.isFinite(candidate.durationMs) &&
    candidate.durationMs >= 0 &&
    Number.isFinite(Date.parse(candidate.startTime)) &&
    Number.isFinite(Date.parse(candidate.endTime))
  );
}

/** Everything queued, oldest first. A file that is missing, truncated or full of
 *  something else reads as an empty queue: there is nothing to recover from it
 *  and refusing to start would cost the sessions that follow as well. */
export async function readQueue(path: string): Promise<PlaySessionRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

async function writeQueue(
  path: string,
  records: readonly PlaySessionRecord[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Write-then-rename, as the config does: a crash mid-write must not leave a
  // truncated file where the backlog was.
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(records, null, 2), "utf8");
  await rename(temp, path);
}

/** Drop what is past either bound, oldest first. */
export function prune(
  records: readonly PlaySessionRecord[],
  now: number,
): PlaySessionRecord[] {
  const fresh = records.filter(
    (record) => now - Date.parse(record.startTime) <= MAX_QUEUED_AGE_MS,
  );
  return fresh.length > MAX_QUEUED
    ? fresh.slice(fresh.length - MAX_QUEUED)
    : fresh;
}

/**
 * Add a session to the backlog, and hand back everything now waiting.
 *
 * The caller gets the whole queue rather than just this record because the
 * flush that follows should carry the backlog too: the moment one session ends
 * is the moment the shell has a reachable server in front of it, and waiting for
 * a later launch to deliver an earlier one is how a backlog becomes permanent.
 */
export function enqueue(
  path: string,
  record: PlaySessionRecord,
  now: number = Date.now(),
): Promise<PlaySessionRecord[]> {
  // Two emulators can exit at once, and both would otherwise read this file,
  // add their own row, and write back a copy missing the other's.
  return inTurn(path, async () => {
    const queued = prune([...(await readQueue(path)), record], now);
    await writeQueue(path, queued);
    return queued;
  });
}

/**
 * Forget the sessions the server has taken.
 *
 * Matched on identity rather than by index: a launch that ended while the flush
 * was in flight has already added a row, and removing by position would drop
 * that one instead.
 */
export function dequeue(
  path: string,
  delivered: readonly PlaySessionRecord[],
): Promise<void> {
  if (delivered.length === 0) return Promise.resolve();
  const gone = new Set(delivered.map(identityOf));
  return inTurn(path, async () => {
    const remaining = (await readQueue(path)).filter(
      (record) => !gone.has(identityOf(record)),
    );
    await writeQueue(path, remaining);
  });
}
