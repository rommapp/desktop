import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type PlaySessionRecord } from "./session.ts";
import {
  claimQueue,
  dequeue,
  enqueue,
  ownerOf,
  MAX_QUEUED,
  MAX_QUEUED_AGE_MS,
  prune,
  pruneQueue,
  readQueue,
} from "./queue.ts";

const SERVER = "https://romm.example.com";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

function queueFile(): string {
  return join(mkdtempSync(join(tmpdir(), "romm-play-")), "play-sessions.json");
}

function record(
  romId: number,
  startedAt = NOW - 60_000,
  serverUrl = SERVER,
): PlaySessionRecord {
  return {
    romId,
    saveSlot: "autosave",
    serverUrl,
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
    JSON.stringify({
      owners: {},
      sessions: [
        record(1),
        { romId: "seven", startTime: "x" },
        {
          romId: 2,
          saveSlot: null,
          serverUrl: SERVER,
          startTime: "not a date",
          endTime: "x",
          durationMs: 1,
        },
        // No server to file it against, so there is no account to check a
        // delivery of it against either.
        { ...record(3), serverUrl: undefined },
        record(2),
      ],
    }),
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

test("the file on disk is the sessions, their owners, and nothing else", async () => {
  const path = queueFile();
  await claimQueue(path, SERVER, 7);
  await enqueue(path, record(1), NOW);
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(parsed, { owners: { [SERVER]: 7 }, sessions: [record(1)] });
});

test("a file in the shape this predates reads as empty rather than as data", async () => {
  // The bare array written before owners existed carries no account, so there
  // is nothing to check a delivery against. Unreleased, so it reads as nothing
  // rather than being migrated.
  const path = queueFile();
  writeFileSync(path, JSON.stringify([record(1)]));
  assert.deepEqual(await readQueue(path), []);
});

test("delivery prunes what the backlog has outgrown, and persists it", async () => {
  const path = queueFile();
  await enqueue(path, record(1, NOW - MAX_QUEUED_AGE_MS - 1000), NOW);
  await enqueue(path, record(2, NOW - 1000), NOW);
  // Nothing has been enqueued since, which is the case the age bound is for:
  // a machine that has stopped being played on never reaches enqueue again.
  const kept = await pruneQueue(path, NOW);

  assert.deepEqual(
    kept.map((entry) => entry.romId),
    [2],
  );
  assert.deepEqual(
    (await readQueue(path)).map((entry) => entry.romId),
    [2],
    "the removal is written, not just returned",
  );
});

test("pruning a backlog with nothing to drop leaves the file alone", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);
  const before = await readFile(path, "utf8");

  assert.equal((await pruneQueue(path, NOW)).length, 1);
  assert.equal(await readFile(path, "utf8"), before);
});

test("a queue for another server survives being pruned for this one", async () => {
  const path = queueFile();
  await enqueue(path, record(1, NOW - 1000, "https://other.example"), NOW);
  await enqueue(path, record(2), NOW);

  // Pruning is about age and size, not about whose server it is: repointing the
  // shell must not quietly discard the backlog of the server left behind.
  assert.deepEqual(
    (await pruneQueue(path, NOW)).map((entry) => entry.serverUrl),
    ["https://other.example", SERVER],
  );
});

test("a queue with no owner yet is adopted rather than discarded", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);

  assert.equal(await ownerOf(path, SERVER), undefined);
  assert.equal(await claimQueue(path, SERVER, 7), 0, "nothing is discarded");
  assert.equal(await ownerOf(path, SERVER), 7);
  assert.equal((await readQueue(path)).length, 1, "the session survives");
});

test("claiming for the same account again is a no-op", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);
  await claimQueue(path, SERVER, 7);

  assert.equal(await claimQueue(path, SERVER, 7), 0);
  assert.equal((await readQueue(path)).length, 1);
});

test("a backlog is discarded rather than filed under whoever signed in next", async () => {
  const path = queueFile();
  await enqueue(path, record(1), NOW);
  await enqueue(path, record(2), NOW);
  await claimQueue(path, SERVER, 7);

  // User 7 played these; user 8 is who the server now says is asking. Nobody
  // can hand them to 7 after the fact, so they go rather than land on 8.
  assert.equal(await claimQueue(path, SERVER, 8), 2);
  assert.deepEqual(await readQueue(path), []);
  assert.equal(await ownerOf(path, SERVER), 8);
});

test("an account change on one server leaves another server's backlog alone", async () => {
  const path = queueFile();
  const other = "https://other.example";
  await enqueue(path, record(1), NOW);
  await enqueue(path, record(2, NOW - 60_000, other), NOW);
  await claimQueue(path, SERVER, 7);
  await claimQueue(path, other, 9);

  assert.equal(await claimQueue(path, SERVER, 8), 1);
  assert.deepEqual(
    (await readQueue(path)).map((entry) => entry.serverUrl),
    [other],
    "the other server's session is not this account's business",
  );
  assert.equal(await ownerOf(path, other), 9, "and its owner is untouched");
});

test("owners survive the writes that touch sessions", async () => {
  const path = queueFile();
  await claimQueue(path, SERVER, 7);

  await enqueue(path, record(1), NOW);
  assert.equal(await ownerOf(path, SERVER), 7, "enqueue keeps it");

  await pruneQueue(path, NOW);
  assert.equal(await ownerOf(path, SERVER), 7, "pruning keeps it");

  await dequeue(path, [record(1)]);
  assert.equal(await ownerOf(path, SERVER), 7, "dequeue keeps it");
});
