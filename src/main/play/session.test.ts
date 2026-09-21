import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closePlaySession,
  identityOf,
  inBatches,
  minimumPlayMs,
  openPlaySession,
  playTrackingEnabled,
  shouldRetry,
  toEntries,
  type Clocks,
  type PlaySessionRecord,
} from "./session.ts";

/** Clocks a test drives by hand. `now` is wall clock, `tick` monotonic, and
 *  they are moved separately so a test can disagree the two on purpose. */
function fakeClocks(now: number, tick = 0) {
  const state = { now, tick };
  const clocks: Clocks = { now: () => state.now, tick: () => state.tick };
  return { clocks, state };
}

const MINUTE = 60_000;
const START = Date.UTC(2026, 0, 2, 10, 0, 0);

function played(elapsedMs: number, minimumMs = MINUTE) {
  const { clocks, state } = fakeClocks(START, 1000);
  const open = openPlaySession(7, "autosave", clocks);
  state.tick += elapsedMs;
  state.now += elapsedMs;
  return closePlaySession(open, minimumMs, clocks);
}

test("a run past the floor becomes a record the server can take", () => {
  const record = played(90_000);
  assert.ok(record);
  assert.equal(record.romId, 7);
  assert.equal(record.saveSlot, "autosave");
  assert.equal(record.durationMs, 90_000);
  assert.equal(record.startTime, "2026-01-02T10:00:00.000Z");
  assert.equal(record.endTime, "2026-01-02T10:01:30.000Z");
  assert.ok(
    Date.parse(record.endTime) > Date.parse(record.startTime),
    "the server rejects a session that does not move forward",
  );
});

test("an emulator that fails on startup is not a play session", () => {
  assert.equal(played(300), null);
  assert.equal(played(59_000), null);
  assert.ok(played(60_000), "the floor itself counts");
});

test("a floor below the server's resolution is still a whole second", () => {
  // Both ends are truncated to the second on ingest, so a sub-second session
  // would arrive with its end no later than its start and be refused.
  assert.equal(played(400, 0), null);
  assert.ok(played(1000, 0));
});

test("the duration ignores a wall clock that moved during the game", () => {
  const { clocks, state } = fakeClocks(START, 1000);
  const open = openPlaySession(7, null, clocks);
  state.tick += 10 * MINUTE;
  // An NTP correction mid-game, backwards past the start.
  state.now -= 60 * MINUTE;

  const record = closePlaySession(open, MINUTE, clocks);
  assert.ok(record);
  assert.equal(record.durationMs, 10 * MINUTE);
  assert.equal(record.endTime, "2026-01-02T10:10:00.000Z");
});

test("a suspended machine is not billed for the time it slept", () => {
  const { clocks, state } = fakeClocks(START, 1000);
  const open = openPlaySession(7, null, clocks);
  // Eight hours of wall clock, two minutes of monotonic: the lid was shut.
  state.now += 8 * 60 * MINUTE;
  state.tick += 2 * MINUTE;

  const record = closePlaySession(open, MINUTE, clocks);
  assert.ok(record);
  assert.equal(record.durationMs, 2 * MINUTE);
});

test("minimumPlayMs falls back for anything that is not a count of seconds", () => {
  assert.equal(minimumPlayMs(30), 30_000);
  assert.equal(minimumPlayMs(0), 0);
  assert.equal(minimumPlayMs(null), 60_000);
  assert.equal(minimumPlayMs(undefined), 60_000);
  assert.equal(minimumPlayMs(Number.NaN), 60_000);
  assert.equal(minimumPlayMs(-5), 60_000);
});

test("playTrackingEnabled needs both the setting and a server", () => {
  assert.equal(
    playTrackingEnabled({ trackPlaySessions: true, serverUrl: "https://r" }),
    true,
  );
  assert.equal(
    playTrackingEnabled({ trackPlaySessions: false, serverUrl: "https://r" }),
    false,
  );
  assert.equal(
    playTrackingEnabled({ trackPlaySessions: true, serverUrl: null }),
    false,
  );
});

test("a refusal about the payload is final, one about the moment is not", () => {
  assert.equal(shouldRetry(201), false);
  // The session is gone or the scope is missing: both can change on their own.
  assert.equal(shouldRetry(401), true);
  assert.equal(shouldRetry(403), true);
  assert.equal(shouldRetry(429), true);
  assert.equal(shouldRetry(503), true);
  // The server has judged the body, and would judge it the same way again.
  assert.equal(shouldRetry(400), false);
  assert.equal(shouldRetry(404), false);
  assert.equal(shouldRetry(422), false);
});

function record(romId: number, startTime: string): PlaySessionRecord {
  return {
    romId,
    saveSlot: null,
    startTime,
    endTime: "2026-01-02T10:01:00.000Z",
    durationMs: MINUTE,
  };
}

test("a backlog is split into batches the server accepts", () => {
  const many = Array.from({ length: 250 }, (_, at) =>
    record(at, "2026-01-02T10:00:00.000Z"),
  );
  const batches = inBatches(many);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 50],
  );
  assert.equal(inBatches([]).length, 0);
});

test("entries are spelled the way both ingest endpoints read them", () => {
  assert.deepEqual(toEntries([record(7, "2026-01-02T10:00:00.000Z")]), [
    {
      rom_id: 7,
      save_slot: null,
      start_time: "2026-01-02T10:00:00.000Z",
      end_time: "2026-01-02T10:01:00.000Z",
      duration_ms: MINUTE,
    },
  ]);
});

test("identity matches what the server dedupes on", () => {
  const one = record(7, "2026-01-02T10:00:00.000Z");
  assert.equal(identityOf(one), identityOf({ ...one, durationMs: 999 }));
  assert.notEqual(identityOf(one), identityOf(record(8, one.startTime)));
  assert.notEqual(
    identityOf(one),
    identityOf(record(7, "2026-01-02T11:00:00.000Z")),
  );
});
