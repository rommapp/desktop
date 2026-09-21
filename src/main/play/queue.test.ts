import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type PlaySessionRecord } from "./session.ts";
import {
  dequeue,
  enqueue,
  MAX_QUEUED,
  MAX_QUEUED_AGE_MS,
  prune,
  readQueue,
} from "./queue.ts";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

function queueFile(): string {
  return join(mkdtempSync(join(tmpdir(), "romm-play-")), "play-sessions.json");
}

function record(romId: number, startedAt = NOW - 60_000): PlaySessionRecord {
  return {
    romId,
    saveSlot: "autosave",
    startTime: new Date(startedAt).toISOString(),
    endTime: new Date(startedAt + 60_000).toISOString(),
    durationMs: 60_000,
  };
}

test("a queued session survives being written and read back", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);
  await enqueue(path, record(2), NOW);

  assert.deepEqual(
    (await readQueue(path)).map((entry) => entry.romId),
    [1, 2],
  );
});

test("enqueue hands back the whole backlog, not just the new row", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);
  const queued = await enqueue(path, record(2), NOW);
  assert.deepEqual(
    queued.map((entry) => entry.romId),
    [1, 2],
  );
});

test("two emulators exiting at once both end up in the file", async () => {
  const path = queueFile();
  // No await between them: the second read would otherwise see the file as it
  // was before the first wrote it, and write back a copy missing that row.
  await Promise.all([
    enqueue(path, record(1), NOW),
    enqueue(path, record(2), NOW),
    enqueue(path, record(3), NOW),
  ]);

  assert.deepEqual(
    (await readQueue(path)).map((entry) => entry.romId).sort(),
    [1, 2, 3],
  );
});

test("only what the server took is forgotten", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);
  await enqueue(path, record(2), NOW);
  await enqueue(path, record(3), NOW);

  await dequeue(path, [record(1), record(3)]);

  assert.deepEqual(
    (await readQueue(path)).map((entry) => entry.romId),
    [2],
  );
});

test("a session that landed while a flush was in flight is not dropped with it", async () => {
  const path = queueFile();
  const sent = record(1);
  await enqueue(path, sent, NOW);
  // A second launch finishes before the flush of the first comes back.
  await enqueue(path, record(2), NOW);

  await dequeue(path, [sent]);

  assert.deepEqual(
    (await readQueue(path)).map((entry) => entry.romId),
    [2],
  );
});

test("dequeue with nothing delivered leaves the file alone", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);
  await dequeue(path, []);
  assert.equal((await readQueue(path)).length, 1);
});

test("a missing, truncated or foreign file reads as an empty queue", async () => {
  assert.deepEqual(await readQueue(queueFile()), []);

  const truncated = queueFile();
  writeFileSync(truncated, '[{"romId": 1, "startTi');
  assert.deepEqual(await readQueue(truncated), []);

  const foreign = queueFile();
  writeFileSync(foreign, '{"not": "an array"}');
  assert.deepEqual(await readQueue(foreign), []);
});

test("a row that is not a session is dropped rather than sent", async () => {
  const path = queueFile();
  writeFileSync(
    path,
    JSON.stringify([
      record(1),
      { romId: "seven", startTime: "x" },
      {
        romId: 2,
        saveSlot: null,
        startTime: "not a date",
        endTime: "x",
        durationMs: 1,
      },
      record(2),
    ]),
  );
  assert.deepEqual(
    (await readQueue(path)).map((entry) => entry.romId),
    [1, 2],
  );
});

test("prune drops what is older than the age bound", () => {
  const old = record(1, NOW - MAX_QUEUED_AGE_MS - 1000);
  const fresh = record(2, NOW - 1000);
  assert.deepEqual(
    prune([old, fresh], NOW).map((entry) => entry.romId),
    [2],
  );
});

test("prune keeps the newest when the backlog runs past its cap", () => {
  const many = Array.from({ length: MAX_QUEUED + 10 }, (_, at) =>
    record(at, NOW - (MAX_QUEUED + 10 - at) * 1000),
  );
  const kept = prune(many, NOW);
  assert.equal(kept.length, MAX_QUEUED);
  // The oldest ten went; the newest, which drive last_played, stayed.
  assert.equal(kept[0]?.romId, 10);
  assert.equal(kept.at(-1)?.romId, MAX_QUEUED + 9);
});

test("the file on disk is the records and nothing else", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(Array.isArray(parsed));
  assert.deepEqual(parsed, [record(1)]);
});
