import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contentStateBase,
  displacedStateName,
  localStateName,
  MAX_STATE_BYTES,
  planStateRestore,
  planStates,
  readStateList,
  slotFromAssetName,
  stateAssetName,
  stateLoadsIn,
  stateSlot,
  type RemoteState,
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

test("the ceiling leaves room for a real state and not for a heap", () => {
  // Memory, not bandwidth: the file and the multipart body framing it are both
  // resident, so the peak is about twice this. Well over the heaviest state a
  // core actually writes, well under RomM's own 512 MiB asset limit.
  assert.equal(MAX_STATE_BYTES, 128 * 1024 * 1024);
  assert.ok(MAX_STATE_BYTES > 64 * 1024 * 1024);
  assert.ok(MAX_STATE_BYTES < 512 * 1024 * 1024);
});

// ── The restore ───────────────────────────────────────────────────────────────

function remote(
  fileName: string,
  updatedAt: string,
  over: Partial<RemoteState> = {},
): RemoteState {
  return {
    id: 1,
    fileName,
    emulator: "snes9x",
    size: 4096,
    updatedAt: Date.parse(updatedAt),
    screenshotId: null,
    ...over,
  };
}

test("the slot comes back out of the name the mirror wrote", () => {
  assert.equal(slotFromAssetName("Zelda [study-pc slot 3].state"), "slot 3");
  assert.equal(slotFromAssetName("Zelda [study-pc auto].state"), "auto");
  assert.equal(slotFromAssetName("Zelda [slot 0].state"), "slot 0");
});

test("a state from anywhere else names no slot", () => {
  // The browser player and a hand upload both land here, and neither says
  // which slot it is. Guessing one would write over a slot the player has.
  assert.equal(slotFromAssetName("Zelda.state"), null);
  assert.equal(slotFromAssetName("Zelda [1999-01-01 12-00-00].state"), null);
  assert.equal(slotFromAssetName("Zelda [study-pc slot 3].srm"), null);
  // A title of its own ending in brackets cannot pass for a slot.
  assert.equal(slotFromAssetName("Zelda [slot 3] [extra].state"), null);
});

test("only the emulator that wrote a state can load it", () => {
  const state = remote("Zelda [pc slot 1].state", "2026-01-01T00:00:00Z");
  assert.equal(stateLoadsIn(state, "snes9x"), true);
  assert.equal(stateLoadsIn(state, "SNES9X"), true);
  assert.equal(stateLoadsIn(state, "bsnes"), false);
  // A state naming no emulator is nobody's rather than everybody's.
  assert.equal(stateLoadsIn({ ...state, emulator: null }, "snes9x"), false);
  assert.equal(stateLoadsIn(state, null), false);
});

test("a slot's local file is the name the emulator writes", () => {
  assert.equal(localStateName("Zelda", "slot 0"), "Zelda.state");
  assert.equal(localStateName("Zelda", "slot 3"), "Zelda.state3");
  // The automatic state loads on start without being asked for, so it is not
  // somewhere another machine's session gets to land.
  assert.equal(localStateName("Zelda", "auto"), null);
});

test("an empty slot is filled from the name the launch pinned", () => {
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop slot 2].state", "2026-01-01T00:00:00Z")],
    local: [],
    emulator: "snes9x",
    bases: ["Zelda (USA)", "discs"],
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.fileName, "Zelda (USA).state2");
  assert.equal(plan[0]?.displaces, null);
});

test("a directory that already names this game's states wins over the guess", () => {
  // The emulator names the state, not the shell: a restore into a name nothing
  // reads is a slot the player cannot see. So the spelling on disk decides,
  // where the launch would have arrived at it too.
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop slot 2].state", "2026-01-01T00:00:00Z")],
    local: [entry("discs.state1", 1_000)],
    emulator: "snes9x",
    bases: ["Zelda (USA)", "discs"],
  });

  assert.equal(plan[0]?.fileName, "discs.state2");
});

test("a name left by a different content choice does not decide", () => {
  // A whole-set launch left "discs.state1" behind, and this launch boots one
  // disc: the emulator will look for "Disc 2.state2", so restoring into the
  // playlist's name puts the state where nothing reads it.
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop slot 2].state", "2026-01-01T00:00:00Z")],
    local: [entry("discs.state1", 1_000)],
    emulator: "snes9x",
    bases: ["Disc 2"],
  });

  assert.equal(plan[0]?.fileName, "Disc 2.state2");
});

test("a slot past the ninety-ninth is still a slot", () => {
  // stateSlot reads any number of digits off the emulator's own name, so a
  // ceiling on the way back would upload a state nothing could ever restore.
  assert.equal(stateSlot("Game.state100"), "slot 100");
  assert.equal(
    slotFromAssetName(stateAssetName("Game", "pc", "slot 100")),
    "slot 100",
  );
  assert.equal(localStateName("Game", "slot 100"), "Game.state100");
});

test("a displaced state is archived out of the restore's reach", () => {
  // Filed as this machine's slot it would be that slot's newest row the moment
  // it was written, and the next launch would restore the bytes this one had
  // just replaced.
  const at = new Date("2026-09-22T01:16:39.006Z");
  const archived = displacedStateName("Zelda", "study-pc", "slot 1", at);

  assert.equal(
    archived,
    "Zelda [study-pc slot 1 replaced 2026-09-22 01-16-39-006].state",
  );
  assert.equal(slotFromAssetName(archived), null);
  assert.notEqual(archived, stateAssetName("Zelda", "study-pc", "slot 1"));
});

test("an archive of a long game name still keeps the slot and the marker", () => {
  const archived = displacedStateName(
    "A".repeat(300),
    "study-pc",
    "slot 3",
    new Date("2026-09-22T01:16:39.006Z"),
  );

  assert.ok(
    archived.endsWith("slot 3 replaced 2026-09-22 01-16-39-006].state"),
  );
  assert.ok(archived.length <= 120);
});

test("an archived state is not a candidate the restore can pick", () => {
  const plan = planStateRestore({
    remote: [
      remote("Zelda [laptop slot 1].state", "2026-01-01T00:00:00Z"),
      // Written later than the state above, and still never restored.
      remote(
        "Zelda [study-pc slot 1 replaced 2026-09-22 01-16-39-006].state",
        "2026-09-22T01:16:39Z",
        { id: 9 },
      ),
    ],
    local: [],
    emulator: "snes9x",
    bases: ["Zelda"],
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.state.fileName, "Zelda [laptop slot 1].state");
});

test("a slot's own file is the one this launch's emulator would read", () => {
  // `discs.state2` is the slot 2 of a whole-set launch, not of this one: this
  // emulator reads "Disc 2.state2", so restoring over the playlist's file
  // would cost a state nothing here reads and land where nothing looks.
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop slot 2].state", "2026-01-01T00:00:00Z")],
    local: [entry("discs.state2", Date.parse("2026-06-01T00:00:00Z"))],
    emulator: "snes9x",
    bases: ["Disc 2"],
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.fileName, "Disc 2.state2");
  assert.equal(plan[0]?.displaces, null);
});

test("a slot spelled differently is still the same file to displace", () => {
  // On Windows and macOS these are one file, so reading the slot as empty is
  // how it gets overwritten without being archived first. The file's own
  // spelling is what gets written.
  const local = entry("zelda.state1", Date.parse("2025-12-01T00:00:00Z"));
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop slot 1].state", "2026-01-01T00:00:00Z")],
    local: [local],
    emulator: "snes9x",
    bases: ["Zelda"],
  });

  assert.equal(plan[0]?.fileName, "zelda.state1");
  assert.deepEqual(plan[0]?.displaces, local);
});

test("a slot holding something newer is left alone", () => {
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop slot 1].state", "2026-01-01T00:00:00Z")],
    local: [entry("Zelda.state1", Date.parse("2026-02-01T00:00:00Z"))],
    emulator: "snes9x",
    bases: ["Zelda"],
  });

  assert.deepEqual(plan, []);
});

test("a slot holding something older is replaced, and its own bytes go up", () => {
  const older = entry("Zelda.state1", Date.parse("2025-12-01T00:00:00Z"));
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop slot 1].state", "2026-01-01T00:00:00Z")],
    local: [older],
    emulator: "snes9x",
    bases: ["Zelda"],
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.fileName, "Zelda.state1");
  assert.deepEqual(plan[0]?.displaces, older);
});

test("one state per slot, the most recently written of them", () => {
  const plan = planStateRestore({
    remote: [
      remote("Zelda [laptop slot 1].state", "2026-01-01T00:00:00Z", { id: 7 }),
      remote("Zelda [study-pc slot 1].state", "2026-03-01T00:00:00Z", {
        id: 8,
      }),
    ],
    local: [],
    emulator: "snes9x",
    bases: ["Zelda"],
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.state.fileName, "Zelda [study-pc slot 1].state");
});

test("the automatic state is never restored", () => {
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop auto].state", "2026-01-01T00:00:00Z")],
    local: [],
    emulator: "snes9x",
    bases: ["Zelda"],
  });

  assert.deepEqual(plan, []);
});

test("another core's states and oversized ones are not brought down", () => {
  const plan = planStateRestore({
    remote: [
      remote("Zelda [laptop slot 1].state", "2026-01-01T00:00:00Z", {
        emulator: "bsnes",
      }),
      remote("Zelda [laptop slot 2].state", "2026-01-01T00:00:00Z", {
        size: MAX_STATE_BYTES + 1,
      }),
    ],
    local: [],
    emulator: "snes9x",
    bases: ["Zelda"],
  });

  assert.deepEqual(plan, []);
});

test("a launch with no name to give its states restores none", () => {
  const plan = planStateRestore({
    remote: [remote("Zelda [laptop slot 1].state", "2026-01-01T00:00:00Z")],
    local: [],
    emulator: "snes9x",
    bases: [],
  });

  assert.deepEqual(plan, []);
});

test("the content's own name is what a disc set's states go by", () => {
  // A multi-disc launch boots the playlist the shell wrote, so an emulator
  // naming states after the content calls them "discs", not the game.
  assert.equal(contentStateBase("/cache/42/discs.m3u"), "discs");
  assert.equal(
    contentStateBase("/cache/42/Final Fantasy VII (Disc 2).chd"),
    "Final Fantasy VII (Disc 2)",
  );
  assert.equal(contentStateBase("/cache/42/Zelda"), "Zelda");
});

test("a malformed state list costs the rows it broke, not the launch", () => {
  const rows = readStateList([
    {
      id: 4,
      file_name: "Zelda [pc slot 1].state",
      file_size_bytes: 4096,
      emulator: "snes9x",
      updated_at: "2026-01-01T00:00:00Z",
      screenshot: { id: 9 },
    },
    // No id to fetch by, no length to hold the transfer to, no timestamp to
    // compare against, and a file the server has lost: none are rows to act on.
    { file_name: "a.state", file_size_bytes: 1, updated_at: "2026-01-01Z" },
    { id: 5, file_name: "b.state", updated_at: "2026-01-01T00:00:00Z" },
    { id: 6, file_name: "c.state", file_size_bytes: 1 },
    {
      id: 7,
      file_name: "d.state",
      file_size_bytes: 1,
      updated_at: "2026-01-01T00:00:00Z",
      missing_from_fs: true,
    },
    "not a row",
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 4);
  assert.equal(rows[0]?.screenshotId, 9);
  assert.equal(rows[0]?.updatedAt, Date.parse("2026-01-01T00:00:00Z"));
  assert.deepEqual(readStateList("not a list"), []);
});
