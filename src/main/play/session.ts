// How long the emulator actually ran, and what RomM is told about it.
//
// The shell is the only thing that knows this. RomM can see that a ROM was
// downloaded; it cannot see that the player then spent forty minutes in it, and
// a native launch is otherwise invisible to the playtime the server keeps. So
// the launch times itself between the spawn and the exit, and what comes out is
// one row for RomM's play session list.
//
// Kept free of Electron and Node imports, and of the clock, so the decisions
// here -- what counts as a play session, how long it lasted, what the server is
// sent -- can be tested without one.

/** A launch being timed, from the moment the emulator was spawned. */
export interface OpenPlaySession {
  romId: number;
  /** The save slot this launch played through, when it synced one. */
  saveSlot: string | null;
  /** Wall clock at the spawn, which is what the server is told. */
  startedAt: number;
  /** Monotonic reading at the spawn, which is what the duration is measured
   *  against. */
  startedTick: number;
}

/** One finished play session, as it is queued and as it is sent. */
export interface PlaySessionRecord {
  romId: number;
  saveSlot: string | null;
  /** ISO 8601 in UTC. Also half of the identity the server dedupes on, so it is
   *  stored rather than recomputed: a retry has to carry the same value the
   *  first attempt did. */
  startTime: string;
  endTime: string;
  durationMs: number;
}

/** The two clocks a session is timed against, injected so a test can hold them
 *  still. `now` is wall clock, `tick` monotonic. */
export interface Clocks {
  now: () => number;
  tick: () => number;
}

export const systemClocks: Clocks = {
  now: () => Date.now(),
  tick: () => performance.now(),
};

/**
 * Shortest run that counts as having played something.
 *
 * A launch that fails after the process starts -- a core that rejects the ROM,
 * an emulator that cannot open a display -- exits in under a second, and
 * recording those would be worse than recording nothing: the server advances
 * `last_played`, flips the ROM to "now playing" and rewinds a finished status
 * back to incomplete for every one of them. A minute is comfortably past any of
 * those and comfortably under anything a player would call a session.
 */
export const DEFAULT_MINIMUM_PLAY_SECONDS = 60;

/** Below this the payload is not even well formed: the server truncates
 *  sub-second precision off both ends, so anything shorter arrives with its end
 *  no later than its start and is rejected. */
const SERVER_RESOLUTION_MS = 1000;

export function openPlaySession(
  romId: number,
  saveSlot: string | null,
  clocks: Clocks = systemClocks,
): OpenPlaySession {
  return {
    romId,
    saveSlot,
    startedAt: clocks.now(),
    startedTick: clocks.tick(),
  };
}

/**
 * Turn a finished launch into a record, or decide it was not a play session.
 *
 * The duration is monotonic and the end is derived from it rather than read off
 * the wall clock a second time. Two things move that clock underneath a running
 * emulator: an NTP correction, and a laptop suspended mid-game. The first would
 * report a session that ran backwards, which the server rejects outright; the
 * second would bill the player for eight hours of sleep. A monotonic reading is
 * wrong about neither.
 */
export function closePlaySession(
  open: OpenPlaySession,
  minimumMs: number,
  clocks: Clocks = systemClocks,
): PlaySessionRecord | null {
  const durationMs = Math.round(clocks.tick() - open.startedTick);
  if (durationMs < Math.max(minimumMs, SERVER_RESOLUTION_MS)) return null;

  return {
    romId: open.romId,
    saveSlot: open.saveSlot,
    startTime: new Date(open.startedAt).toISOString(),
    endTime: new Date(open.startedAt + durationMs).toISOString(),
    durationMs,
  };
}

/** The floor a config asks for, in milliseconds, falling back to the default
 *  for a value that is not a usable number of seconds. */
export function minimumPlayMs(seconds: number | null | undefined): number {
  return Number.isFinite(seconds) && (seconds as number) >= 0
    ? (seconds as number) * 1000
    : DEFAULT_MINIMUM_PLAY_SECONDS * 1000;
}

/** What one batch may carry, matching the server's own cap. A larger batch is
 *  refused whole, so it is split here rather than discovered there. */
export const MAX_BATCH = 100;

/** One entry as both ingest endpoints spell it. */
export interface PlaySessionEntry {
  rom_id: number;
  save_slot: string | null;
  start_time: string;
  end_time: string;
  duration_ms: number;
}

export function toEntries(
  records: readonly PlaySessionRecord[],
): PlaySessionEntry[] {
  return records.map((record) => ({
    rom_id: record.romId,
    save_slot: record.saveSlot,
    start_time: record.startTime,
    end_time: record.endTime,
    duration_ms: record.durationMs,
  }));
}

/** Split a backlog into batches the server will accept. */
export function inBatches(
  records: readonly PlaySessionRecord[],
  size = MAX_BATCH,
): PlaySessionRecord[][] {
  const batches: PlaySessionRecord[][] = [];
  for (let at = 0; at < records.length; at += size) {
    batches.push(records.slice(at, at + size));
  }
  return batches;
}

/** Whether a launch should report its play sessions at all. */
export function playTrackingEnabled(config: {
  trackPlaySessions: boolean;
  serverUrl: string | null;
}): boolean {
  return Boolean(config.trackPlaySessions && config.serverUrl);
}

/**
 * What a status means for a record still sitting in the queue.
 *
 * The queue exists for the failures that pass: no session yet, a server that is
 * down, a network that is not there. It must not hold a record the server will
 * refuse every time it is offered -- a malformed entry rejected by validation
 * would otherwise sit at the front of the backlog forever, and the sessions
 * behind it would never be reported either. So a refusal about the payload is
 * final, and one about the moment is not.
 */
export function shouldRetry(status: number): boolean {
  if (status < 400) return false;
  if (status >= 500) return true;
  // 401 is the session gone, 403 a scope this user may yet be granted, 408 and
  // 429 the server asking for later.
  return status === 401 || status === 403 || status === 408 || status === 429;
}

/**
 * What makes two records the same session.
 *
 * The server's own identity, minus the device and the user, which do not vary
 * within one machine's queue: it dedupes on (user, device, rom, start_time), so
 * matching on the same pair is what lets a record the server has already taken
 * be recognised here and dropped.
 */
export function identityOf(record: PlaySessionRecord): string {
  return `${record.romId}\u0000${record.startTime}`;
}
