import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hashFile, md5Hex } from "./hash.ts";

test("the digest matches what RomM computes for the same bytes", () => {
  // hashlib.md5(b"abc", usedforsecurity=False).hexdigest(), the value the
  // server stores as a save's content_hash. If this drifts, every negotiate
  // reports a conflict.
  assert.equal(
    md5Hex(new TextEncoder().encode("abc")),
    "900150983cd24fb0d6963f7d28e17f72",
  );
});

test("an empty save hashes rather than reading as absent", () => {
  assert.equal(md5Hex(new Uint8Array(0)), "d41d8cd98f00b204e9800998ecf8427e");
});

test("a file hashes to the digest of its bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "romm-saves-hash-"));
  try {
    const path = join(dir, "Game.srm");
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    await writeFile(path, bytes);
    assert.equal(await hashFile(path), md5Hex(bytes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable path is null, not a throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "romm-saves-hash-"));
  try {
    assert.equal(await hashFile(join(dir, "Missing.srm")), null);
    // A directory stands in for any other read failure: the call must not
    // escape as an exception, or it would fail the launch it is gating.
    assert.equal(await hashFile(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
