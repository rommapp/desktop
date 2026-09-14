import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evictToLimit } from "./evict.ts";

/** A cache holding one directory per ROM, aged so eviction has an order. */
async function fakeCache(
  roms: { id: number; files: Record<string, number>; agedDays: number }[],
) {
  const root = mkdtempSync(join(tmpdir(), "romm-cache-"));
  for (const rom of roms) {
    const dir = join(root, String(rom.id));
    mkdirSync(dir, { recursive: true });
    const when = new Date(Date.now() - rom.agedDays * 86_400_000);
    for (const [name, size] of Object.entries(rom.files)) {
      const path = join(dir, name);
      writeFileSync(path, "x".repeat(size));
      await utimes(path, when, when);
    }
  }
  return root;
}

test("evictToLimit drops whole ROM directories, oldest first", async () => {
  const root = await fakeCache([
    { id: 1, files: { "old.sfc": 100 }, agedDays: 30 },
    { id: 2, files: { "middle.sfc": 100 }, agedDays: 10 },
    { id: 3, files: { "fresh.sfc": 100 }, agedDays: 0 },
  ]);

  await evictToLimit(root, 250, join(root, "3"));

  assert.equal(existsSync(join(root, "1")), false, "oldest ROM is evicted");
  assert.ok(existsSync(join(root, "2")), "a ROM under the limit stays");
  assert.ok(existsSync(join(root, "3")), "the fresh ROM stays");
});

test("evictToLimit never drops the ROM this launch needs", async () => {
  const root = await fakeCache([
    { id: 1, files: { "huge.iso": 500 }, agedDays: 99 },
  ]);

  await evictToLimit(root, 100, join(root, "1"));

  assert.ok(existsSync(join(root, "1")), "kept even though it alone is over");
});

test("evictToLimit counts every file a ROM directory holds", async () => {
  // A rename on the server leaves the previous download beside the new one.
  const root = await fakeCache([
    { id: 1, files: { "renamed.sfc": 100, "original.sfc": 100 }, agedDays: 5 },
    { id: 2, files: { "keep.sfc": 100 }, agedDays: 0 },
  ]);

  await evictToLimit(root, 150, join(root, "2"));

  assert.equal(existsSync(join(root, "1")), false, "both files go together");
});
