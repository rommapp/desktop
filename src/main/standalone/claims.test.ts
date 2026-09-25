import assert from "node:assert/strict";
import { test } from "node:test";
import { claimFolder } from "./claims.ts";

test("a folder another launch holds cannot be claimed until it is released", () => {
  const first = claimFolder("/data/dolphin-emu", "linux");
  assert.ok(first);
  assert.equal(claimFolder("/data/dolphin-emu/", "linux"), null);
  // A different folder is its own claim.
  const other = claimFolder("/data/PCSX2", "linux");
  assert.ok(other);
  first.release();
  // A second release must not free a claim someone else now holds.
  const again = claimFolder("/data/dolphin-emu", "linux");
  assert.ok(again);
  first.release();
  assert.equal(claimFolder("/data/dolphin-emu", "linux"), null);
  again.release();
  other.release();
});

test("a claim someone else asked for while it was held reads as contested", () => {
  const first = claimFolder("/data/rpcs3", "linux");
  assert.ok(first);
  assert.equal(first.contested, false);
  // The second launch's emulator still runs and writes to the folder.
  assert.equal(claimFolder("/data/rpcs3", "linux"), null);
  assert.equal(first.contested, true);
  first.release();
  // The next claim starts clean.
  const next = claimFolder("/data/rpcs3", "linux");
  assert.equal(next?.contested, false);
  next?.release();
});

test("case-insensitive platforms collide on two spellings of one folder", () => {
  const claim = claimFolder("/Users/sam/Library/Dolphin", "darwin");
  assert.ok(claim);
  assert.equal(claimFolder("/users/sam/library/dolphin", "darwin"), null);
  claim.release();
});
