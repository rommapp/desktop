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
    assert.deepEqual(
      [...tree.files.keys()],
      ["USA/Card A/save.gci", "top.raw"],
    );
    assert.equal(tree.files.get("top.raw")?.size, 1);
    assert.equal(tree.complete, true);
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
    assert.deepEqual([...(await listTree(dir)).files.keys()], ["real"]);
  });
});

test("a symlinked root is not walked, and the listing says so", async (context) => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "elsewhere"));
    await writeFile(join(dir, "elsewhere", "secret"), "x");
    try {
      await symlink(join(dir, "elsewhere"), join(dir, "root"));
    } catch {
      context.skip("symlinks need privileges here");
      return;
    }
    const tree = await listTree(join(dir, "root"));
    assert.equal(tree.files.size, 0);
    assert.equal(tree.complete, false);
  });
});

test("a missing root is a complete, empty listing, not a throw", async () => {
  await withDir(async (dir) => {
    const tree = await listTree(join(dir, "missing"));
    assert.equal(tree.files.size, 0);
    assert.equal(tree.complete, true);
  });
});

test("a listing stops at its limits rather than walking everything", async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "deep"), "x");
    for (const name of ["1", "2", "3"]) await writeFile(join(dir, name), "x");
    const capped = await listTree(dir, { maxEntries: 2, maxDepth: 12 });
    assert.equal(capped.files.size, 2);
    assert.equal(capped.complete, false);
    const shallow = await listTree(dir, { maxEntries: 100, maxDepth: 1 });
    assert.deepEqual([...shallow.files.keys()], ["1", "2", "3"]);
    assert.equal(shallow.complete, false);
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

test("a diff against an incomplete listing is refused, not guessed", async () => {
  await withDir(async (dir) => {
    for (const name of ["a", "b", "c"]) await writeFile(join(dir, name), "x");
    const limits = { maxEntries: 2, maxDepth: 12 };
    const before = await listTree(dir, limits);
    // Deleting "a" lets "c" into the capped listing, which would otherwise
    // read as a file the run wrote.
    await rm(join(dir, "a"));
    assert.equal(changedFiles(before, await listTree(dir, limits)), null);
  });
});
