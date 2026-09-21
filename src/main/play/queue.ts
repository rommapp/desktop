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
 * What the file holds: the sessions waiting, and who each server's waiting
 * sessions belong to.
 *
 * The owner is here rather than in the config because it is the queue's own
 * bookkeeping, and here rather than on each record because it has to be
 * recorded before there is anything to stamp -- the point of it is to know, on
 * the first flush after an account change, that what is queued was not this
 * account's. Keyed by server, so repointing the shell and coming back does not
 * read as a different person.
 */
interface QueueFile {
  owners: Record<string, number>;
  sessions: PlaySessionRecord[];
}

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
    typeof candidate.serverUrl === "string" &&
    candidate.serverUrl.length > 0 &&
    (candidate.saveSlot === null || typeof candidate.saveSlot === "string") &&
    typeof candidate.startTime === "string" &&
    typeof candidate.endTime === "string" &&
    typeof candidate.durationMs === "number" &&
    Number.isFinite(candidate.durationMs) &&
    candidate.durationMs >= 0 &&
    Number.isFinite(Date.parse(candidate.startTime)) &&
    Number.isFinite(Date.parse(candidate.endTime)) &&
    // The server validates this for the whole request, so one row that does not
    // move forward would take its batch of a hundred down with it.
    Date.parse(candidate.endTime) > Date.parse(candidate.startTime)
  );
}

/** A file that is missing, truncated or full of something else reads as empty:
 *  there is nothing to recover from it and refusing to start would cost the
 *  sessions that follow as well. */
async function readFileState(path: string): Promise<QueueFile> {
  const empty: QueueFile = { owners: {}, sessions: [] };
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return empty;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const { owners, sessions } = parsed as Partial<QueueFile>;
    return {
      owners: isOwners(owners) ? owners : {},
      sessions: Array.isArray(sessions) ? sessions.filter(isRecord) : [],
    };
  } catch {
    return empty;
  }
}

function isOwners(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every(
    (id) => typeof id === "number" && Number.isInteger(id),
  );
}

/** Everything queued, oldest first. */
export async function readQueue(path: string): Promise<PlaySessionRecord[]> {
  return (await readFileState(path)).sessions;
}

async function writeQueue(path: string, next: QueueFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Write-then-rename, as the config does: a crash mid-write must not leave a
  // truncated file where the backlog was.
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2), "utf8");
  await rename(temp, path);
}

/** Which account this server's queued sessions were recorded under, if the
 *  shell has ever been able to ask. */
export async function ownerOf(
  path: string,
  serverUrl: string,
): Promise<number | undefined> {
  return (await readFileState(path)).owners[serverUrl];
}

/**
 * Record who this server's queue belongs to, discarding it if that has changed.
 *
 * A session is attributed to whoever is signed in when it is delivered, not to
 * whoever played it, so a backlog outliving its account would land on the next
 * one. There is no way to hand it to the right person after the fact, so it goes
 * -- losing a play record is the lesser of the two, and the only one that is not
 * also someone else's business.
 *
 * `seen` is what the caller read before it went and asked who was signed in, and
 * only those records are discarded. An exit landing during that question queues
 * a record belonging to the account now answering, and sweeping the server's
 * rows as they stand would take it too. `dequeue` matches on identity for the
 * same reason.
 *
 * Returns how many were discarded, so the caller can tell an ordinary flush from
 * one that found the queue belonged to somebody else.
 */
export function claimQueue(
  path: string,
  serverUrl: string,
  userId: number,
  seen: readonly PlaySessionRecord[],
): Promise<number> {
  return inTurn(path, async () => {
    const state = await readFileState(path);
    const known = state.owners[serverUrl];
    if (known === userId) return 0;

    // Nothing recorded yet means nothing to contradict, so the queue is adopted
    // rather than thrown away: discarding here would cost the sessions of
    // someone who has simply never been online since installing.
    const gone =
      known === undefined ? new Set<string>() : new Set(seen.map(identityOf));
    const kept = state.sessions.filter(
      (record) => !gone.has(identityOf(record)),
    );
    await writeQueue(path, {
      owners: { ...state.owners, [serverUrl]: userId },
      sessions: kept,
    });
    return state.sessions.length - kept.length;
  });
}

/**
 * Drop everything the backlog has outgrown, and persist it.
 *
 * Called on delivery as well as on arrival, because `enqueue` is the only other
 * place that prunes and a machine that has stopped being played on never
 * reaches it. Without this the age bound would hold for a shell in use and not
 * for the one it was written for.
 */
export function pruneQueue(
  path: string,
  now: number = Date.now(),
): Promise<PlaySessionRecord[]> {
  return inTurn(path, async () => {
    const state = await readFileState(path);
    const kept = prune(state.sessions, now);
    if (kept.length !== state.sessions.length) {
      await writeQueue(path, { ...state, sessions: kept });
    }
    return kept;
  });
}

/**
 * Drop what is past either bound, oldest first.
 *
 * Both bounds judge age by `startTime`, which is not the order the records sit
 * in: they are appended as emulators exit, and two games running at once exit in
 * whichever order they are quit. A long session started this morning can
 * therefore sit behind a short one started this afternoon, so the cap sorts
 * before it slices rather than trusting position for age.
 */
export function prune(
  records: readonly PlaySessionRecord[],
  now: number,
): PlaySessionRecord[] {
  const fresh = records.filter(
    (record) => now - Date.parse(record.startTime) <= MAX_QUEUED_AGE_MS,
  );
  if (fresh.length <= MAX_QUEUED) return fresh;
  const byStart = [...fresh].sort(
    (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
  );
  return byStart.slice(byStart.length - MAX_QUEUED);
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
    const state = await readFileState(path);
    const queued = prune([...state.sessions, record], now);
    await writeQueue(path, { ...state, sessions: queued });
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
    const state = await readFileState(path);
    await writeQueue(path, {
      ...state,
      sessions: state.sessions.filter(
        (record) => !gone.has(identityOf(record)),
      ),
    });
  });
}
