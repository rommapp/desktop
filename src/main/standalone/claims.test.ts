import assert from "node:assert/strict";
import { test } from "node:test";
import { claimFolder } from "./claims.ts";

test("a folder another launch holds cannot be claimed until it is released", () => {
  const release = claimFolder("/data/dolphin-emu", "linux");
  assert.ok(release);
  assert.equal(claimFolder("/data/dolphin-emu/", "linux"), null);
  // A different folder is its own claim.
  const other = claimFolder("/data/PCSX2", "linux");
  assert.ok(other);
  release();
  // A second release must not free a claim someone else now holds.
  const again = claimFolder("/data/dolphin-emu", "linux");
  assert.ok(again);
  release();
  assert.equal(claimFolder("/data/dolphin-emu", "linux"), null);
  again();
  other();
});

test("case-insensitive platforms collide on two spellings of one folder", () => {
  const release = claimFolder("/Users/sam/Library/Dolphin", "darwin");
  assert.ok(release);
  assert.equal(claimFolder("/users/sam/library/dolphin", "darwin"), null);
  release();
});
