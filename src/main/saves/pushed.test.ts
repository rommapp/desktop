import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPushedFile, rememberPushedRows } from "./pushed.ts";
import { PUSHED_FILE, type PushedRow } from "./states.ts";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

/** A directory the record can be written into, as the launch would give it. */
function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "romm-pushed-"));
}

/** One row as a push leaves it: the server's, and the file it came from. */
function row(id: number, updatedAt = NOW): PushedRow {
  return { id, updatedAt, mtimeMs: updatedAt - 3_000 };
}

test("the rows a push left survive being written and read back", async () => {
  const directory = stateDir();
  await rememberPushedRows(directory, {
    "slot 1": row(4),
    "slot 2": row(5, NOW + 1_000),
  });

  assert.deepEqual(await readPushedFile(directory), {
    "slot 1": row(4),
    "slot 2": row(5, NOW + 1_000),
  });
});

test("a later push keeps the rows the earlier one left", async () => {
  // Each run writes only the slots it touched, so losing the rest would have
  // every untouched slot fetched back at the next launch.
  const directory = stateDir();
  await rememberPushedRows(directory, { "slot 1": row(4) });
  await rememberPushedRows(directory, { "slot 3": row(6) });

  assert.deepEqual(await readPushedFile(directory), {
    "slot 1": row(4),
    "slot 3": row(6),
  });
});

test("a slot pushed again takes the new row and leaves one entry", async () => {
  const directory = stateDir();
  await rememberPushedRows(directory, { "slot 1": row(4, NOW) });
  await rememberPushedRows(directory, { "slot 1": row(4, NOW + 1_000) });

  assert.deepEqual(await readPushedFile(directory), {
    "slot 1": row(4, NOW + 1_000),
  });
});

test("a directory with no record reads as none, not as an error", async () => {
  assert.deepEqual(await readPushedFile(stateDir()), {});
  assert.deepEqual(
    await readPushedFile(join(stateDir(), "no-such-directory")),
    {},
  );
});

test("a record that is not JSON reads as none", async () => {
  const directory = stateDir();
  writeFileSync(join(directory, PUSHED_FILE), "{ this is not json");
  assert.deepEqual(await readPushedFile(directory), {});
});

test("an entry that does not read costs only that entry", async () => {
  const directory = stateDir();
  writeFileSync(
    join(directory, PUSHED_FILE),
    JSON.stringify({ "slot 1": row(4), "slot 2": { id: 5 }, auto: row(7) }),
  );

  assert.deepEqual(await readPushedFile(directory), { "slot 1": row(4) });
});

test("a write leaves no half-written record behind", async () => {
  const directory = stateDir();
  await rememberPushedRows(directory, { "slot 1": row(4) });

  assert.deepEqual(readdirSync(directory), [PUSHED_FILE]);
});

test("a directory that is not there yet is made for the record", async () => {
  const directory = join(stateDir(), "states");
  await rememberPushedRows(directory, { "slot 1": row(4) });

  assert.deepEqual(await readPushedFile(directory), { "slot 1": row(4) });
});

test("a record that cannot be written costs the record, not the run", async () => {
  // The path the launch pinned is a file rather than a directory. Nothing here
  // may reach the caller: the pushes that produced these rows already landed.
  const directory = stateDir();
  const notADirectory = join(directory, "in the way");
  writeFileSync(notADirectory, "not a directory");

  await rememberPushedRows(notADirectory, { "slot 1": row(4) });

  assert.deepEqual(await readPushedFile(directory), {});
  assert.deepEqual(readdirSync(directory), ["in the way"]);
});
