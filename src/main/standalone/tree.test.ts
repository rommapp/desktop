import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedFiles, listTree } from "./tree.ts";

async function withDir(body: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "romm-standalone-tree-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a listing names every file by its path under the root", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "USA", "Card A"), { recursive: true });
    await writeFile(join(dir, "USA", "Card A", "save.gci"), "abc");
    await writeFile(join(dir, "top.raw"), "x");
    const tree = await listTree(dir);
    assert.deepEqual([...tree.keys()], ["USA/Card A/save.gci", "top.raw"]);
    assert.equal(tree.get("top.raw")?.size, 1);
  });
});

test("a symlink is not followed or listed", async (context) => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "real"), "x");
    try {
      await symlink(join(dir, "real"), join(dir, "link"));
    } catch {
      context.skip("symlinks need privileges here");
      return;
    }
    assert.deepEqual([...(await listTree(dir)).keys()], ["real"]);
  });
});

test("a missing root is an empty listing, not a throw", async () => {
  await withDir(async (dir) => {
    assert.equal((await listTree(join(dir, "missing"))).size, 0);
  });
});

test("a listing stops at its limits rather than walking everything", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "deep"), "x");
    for (const name of ["1", "2", "3"]) await writeFile(join(dir, name), "x");
    assert.equal(
      (await listTree(dir, { maxEntries: 2, maxDepth: 12 })).size,
      2,
    );
    assert.deepEqual(
      [...(await listTree(dir, { maxEntries: 100, maxDepth: 1 })).keys()],
      ["1", "2", "3"],
    );
  });
});

test("what a run changed is what it added or rewrote", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "kept"), "same");
    await writeFile(join(dir, "rewritten"), "old");
    await writeFile(join(dir, "deleted"), "gone");
    const before = await listTree(dir);

    await writeFile(join(dir, "rewritten"), "new!");
    await rm(join(dir, "deleted"));
    await writeFile(join(dir, "added"), "x");
    // Same size, later time: still a write.
    await writeFile(join(dir, "kept"), "same");
    const later = new Date(Date.now() + 5000);
    await utimes(join(dir, "kept"), later, later);

    assert.deepEqual(changedFiles(before, await listTree(dir)), [
      "added",
      "kept",
      "rewritten",
    ]);
  });
});
