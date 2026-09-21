import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_STATE_BYTES,
  planStates,
  stateAssetName,
  stateSlot,
  type StateEntry,
} from "./states.ts";

function entry(name: string, modifiedAt: number, size = 1024): StateEntry {
  return { name, size, modifiedAt };
}

test("the slot is read off the name RetroArch writes", () => {
  assert.equal(stateSlot("Game.state"), "slot 0");
  assert.equal(stateSlot("Game.state1"), "slot 1");
  assert.equal(stateSlot("Game.state10"), "slot 10");
  assert.equal(stateSlot("Game.state.auto"), "auto");
});

test("what is not a slot is not mirrored", () => {
  // Backups and thumbnails share the directory, and neither is a slot: a
  // thumbnail sent as a state would sit in RomM as a savestate nobody can load.
  assert.equal(stateSlot("Game.state.bak"), null);
  assert.equal(stateSlot("Game.state1.bak"), null);
  assert.equal(stateSlot("Game.state1.png"), null);
  assert.equal(stateSlot("Game.srm"), null);
  assert.equal(stateSlot("Game.state1.auto"), null);
});

test("the emulator naming the file its own way is still this game's slot", () => {
  // The directory is keyed on the ROM id, so what is in it belongs to this
  // game whatever it is called -- and what the emulator calls it is exactly
  // what the shell was wrong about for saves.
  assert.equal(stateSlot("Legend of Zelda, The (USA).state3"), "slot 3");
});

test("a state is sent when the run wrote it", () => {
  const before = [entry("Game.state1", 1_000)];
  const after = [entry("Game.state1", 2_000), entry("Game.state2", 2_000)];

  const plan = planStates({ before, after });

  assert.deepEqual(
    plan.send.map((upload) => upload.slot),
    ["slot 1", "slot 2"],
  );
});

test("a slot the run never touched stays where it is", () => {
  // The common case by far: nine slots sitting untouched from months ago, and
  // an exit that re-sent all of them would cost a transfer per launch forever.
  const both = [entry("Game.state1", 1_000), entry("Game.state.auto", 1_000)];

  const plan = planStates({ before: both, after: both });

  assert.deepEqual(plan.send, []);
});

test("a state rewritten to the same length still counts as written", () => {
  // Savestates are fixed-size for most cores, so the size alone says nothing
  // and the modification time is what carries the change.
  const plan = planStates({
    before: [entry("Game.state1", 1_000, 4096)],
    after: [entry("Game.state1", 2_000, 4096)],
  });

  assert.deepEqual(
    plan.send.map((upload) => upload.slot),
    ["slot 1"],
  );
});

test("a state past the server's ceiling is named rather than sent", () => {
  const plan = planStates({
    before: [],
    after: [entry("Game.state1", 1_000, MAX_STATE_BYTES + 1)],
  });

  assert.deepEqual(plan.send, []);
  assert.deepEqual(
    plan.tooLarge.map((state) => state.name),
    ["Game.state1"],
  );
});

test("the name carries the machine, so two desktops do not overwrite each other", () => {
  assert.equal(
    stateAssetName("Zelda", "study-pc", "slot 3"),
    "Zelda [study-pc slot 3].state",
  );
  assert.notEqual(
    stateAssetName("Zelda", "study-pc", "slot 3"),
    stateAssetName("Zelda", "laptop", "slot 3"),
  );
});

test("a long game name yields to the slot rather than swallowing it", () => {
  // The name is truncated from the right, and the slot lives there. Losing it
  // would file every slot of this game under one name, each overwriting the
  // last, which is the one outcome this naming exists to prevent.
  const long = "A".repeat(300);

  const third = stateAssetName(long, "study-pc", "slot 3");
  const fourth = stateAssetName(long, "study-pc", "slot 4");

  assert.ok(third.endsWith("[study-pc slot 3].state"));
  assert.ok(fourth.endsWith("[study-pc slot 4].state"));
  assert.notEqual(third, fourth);
  assert.ok(third.length <= 120);
});

test("a machine whose name survives nothing still produces a usable name", () => {
  assert.equal(stateAssetName("Game", "...", "auto"), "Game [auto].state");
});
