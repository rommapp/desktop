import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displacedStandaloneName,
  isGameState,
  knowsStates,
  planStandaloneRestore,
  planStandaloneStates,
  pushedSlotKey,
  safeStateName,
  stampStateName,
  stateScreenshotName,
  stateSlotOf,
  statesEmbedScreenshots,
  unstampStateName,
  type RemoteStateRow,
  type StateFile,
  type StateTarget,
} from "./states.ts";

const PS2: StateTarget = { target: "SLUS-20946", layout: "file-prefix" };
const GC: StateTarget = { target: "GALE01", layout: "file-prefix" };

function file(name: string, patch: Partial<StateFile> = {}): StateFile {
  return { name, size: 100, modifiedAt: 1000, ...patch };
}

function row(patch: Partial<RemoteStateRow> = {}): RemoteStateRow {
  return {
    id: 1,
    fileName: "SLUS-20946 (0F2EF3B2).03.p2s",
    emulator: "pcsx2",
    size: 100,
    updatedAt: 5000,
    screenshotId: null,
    ...patch,
  };
}

test("only the emulators whose state names this shell can read", () => {
  assert.equal(knowsStates("pcsx2"), true);
  assert.equal(knowsStates("dolphin"), true);
  // One exit state per game rather than a slot, and no states at all.
  assert.equal(knowsStates("rpcs3"), false);
  assert.equal(knowsStates("cemu"), false);
});

test("each emulator's slot is read out of its own naming", () => {
  assert.equal(stateSlotOf("pcsx2", "SLUS-20946 (0F2EF3B2).03.p2s"), 3);
  assert.equal(stateSlotOf("pcsx2", "SLUS-20946 (0F2EF3B2).10.p2s"), 10);
  assert.equal(stateSlotOf("dolphin", "GALE01.s03"), 3);
  assert.equal(stateSlotOf("dolphin", "GALE01.s10"), 10);
});

test("a name that only looks like a state names no slot", () => {
  // Both emulators count from 1, so a zero is a filename rather than a slot.
  assert.equal(stateSlotOf("pcsx2", "SLUS-20946 (0F2EF3B2).00.p2s"), null);
  assert.equal(stateSlotOf("dolphin", "GALE01.s00"), null);
  assert.equal(stateSlotOf("pcsx2", "SLUS-20946.p2s"), null);
  assert.equal(stateSlotOf("dolphin", "GALE01.sav"), null);
  // Dolphin's is two digits exactly, PCSX2's one or two.
  assert.equal(stateSlotOf("dolphin", "GALE01.s3"), null);
  // Another emulator's naming is not this one's.
  assert.equal(stateSlotOf("pcsx2", "GALE01.s03"), null);
  assert.equal(stateSlotOf("rpcs3", "GALE01.s03"), null);
});

test("a stamped name still reads as the slot it was", () => {
  // The invariant the whole convention rests on: the stamp goes in front of
  // the slot token, so a stamped name still matches the slot pattern. RomM
  // reads these back the same way, and a stamp at the end would break both.
  const at = new Date("2026-11-03T04:05:06.789Z");
  for (const [emulator, name, slot] of [
    ["pcsx2", "SLUS-20946 (0F2EF3B2).03.p2s", 3],
    ["dolphin", "GALE01.s07", 7],
  ] as const) {
    const stamped = stampStateName(emulator, name, at);
    assert.notEqual(stamped, name);
    assert.match(stamped, /\.\d{8}-\d{12}\./);
    assert.equal(stateSlotOf(emulator, stamped), slot);
    assert.equal(unstampStateName(stamped), name);
  }
});

test("the stamp is RomM's own shape, to the microsecond", () => {
  // Python's %Y%m%d-%H%M%S%f: eight digits, a dash, then twelve. A millisecond
  // clock fills nine of those twelve, so the last three are zeroes.
  const stamped = stampStateName(
    "dolphin",
    "GALE01.s01",
    new Date("2026-11-03T04:05:06.789Z"),
  );
  assert.equal(stamped, "GALE01.20261103-040506789000.s01");
});

test("a name with no slot is left alone rather than stamped somewhere wrong", () => {
  assert.equal(stampStateName("pcsx2", "notastate.txt", new Date()), "notastate.txt");
  assert.equal(unstampStateName("notastate.txt"), "notastate.txt");
});

test("only one stamp comes off, so a game named like one survives", () => {
  assert.equal(
    unstampStateName("Game.20261103-040506789000.20261103-040506789000.s01"),
    "Game.20261103-040506789000.s01",
  );
});

test("a state is this game's when the target names it", () => {
  assert.equal(isGameState("SLUS-20946 (0F2EF3B2).03.p2s", PS2), true);
  assert.equal(isGameState("SLUS-21354 (AABBCCDD).03.p2s", PS2), false);
  assert.equal(isGameState("GALE01.s03", GC), true);
  assert.equal(isGameState("GAFE01.s03", GC), false);
});

test("the run's own new and rewritten states are what goes up", () => {
  const plan = planStandaloneStates({
    emulatorId: "pcsx2",
    before: [
      file("SLUS-20946 (0F2EF3B2).01.p2s", { modifiedAt: 10 }),
      file("SLUS-20946 (0F2EF3B2).02.p2s", { modifiedAt: 20 }),
    ],
    after: [
      // Untouched.
      file("SLUS-20946 (0F2EF3B2).01.p2s", { modifiedAt: 10 }),
      // Rewritten.
      file("SLUS-20946 (0F2EF3B2).02.p2s", { modifiedAt: 50 }),
      // New.
      file("SLUS-20946 (0F2EF3B2).03.p2s", { modifiedAt: 40 }),
    ],
    target: PS2,
    maxBytes: 1024,
  });
  // Newest first, so a run cut short has sent the slot last written.
  assert.deepEqual(
    plan.send.map((entry) => [entry.slot, entry.file.modifiedAt]),
    [
      [2, 50],
      [3, 40],
    ],
  );
  assert.deepEqual(plan.tooLarge, []);
  assert.equal(plan.foreign, 0);
});

test("another game's state in the same folder is counted, not sent", () => {
  const plan = planStandaloneStates({
    emulatorId: "pcsx2",
    before: [],
    after: [file("SLUS-21354 (AABBCCDD).01.p2s")],
    target: PS2,
    maxBytes: 1024,
  });
  assert.deepEqual(plan.send, []);
  assert.equal(plan.foreign, 1);
});

test("without a target nothing is sent at all", () => {
  // A state filed against the wrong game cannot be undone from here.
  const plan = planStandaloneStates({
    emulatorId: "pcsx2",
    before: [],
    after: [file("SLUS-20946 (0F2EF3B2).01.p2s")],
    target: null,
    maxBytes: 1024,
  });
  assert.deepEqual(plan.send, []);
});

test("a state past the ceiling is named rather than sent", () => {
  const plan = planStandaloneStates({
    emulatorId: "pcsx2",
    before: [],
    after: [file("SLUS-20946 (0F2EF3B2).01.p2s", { size: 5000 })],
    target: PS2,
    maxBytes: 1024,
  });
  assert.deepEqual(plan.send, []);
  assert.deepEqual(
    plan.tooLarge.map((entry) => entry.name),
    ["SLUS-20946 (0F2EF3B2).01.p2s"],
  );
});

test("a restore takes the newest row per slot, unstamped", () => {
  const plan = planStandaloneRestore({
    emulatorId: "pcsx2",
    rows: [
      row({ id: 1, fileName: "SLUS-20946 (0F2EF3B2).20261101-000000000000.03.p2s", updatedAt: 100 }),
      row({ id: 2, fileName: "SLUS-20946 (0F2EF3B2).20261102-000000000000.03.p2s", updatedAt: 200 }),
      row({ id: 3, fileName: "SLUS-20946 (0F2EF3B2).20261101-000000000000.01.p2s", updatedAt: 150 }),
    ],
    onDisk: [],
    target: PS2,
  });
  assert.deepEqual(
    plan.map((entry) => [entry.slot, entry.row.id, entry.fileName]),
    [
      [1, 3, "SLUS-20946 (0F2EF3B2).01.p2s"],
      [3, 2, "SLUS-20946 (0F2EF3B2).03.p2s"],
    ],
  );
});

test("a row another emulator wrote is never loaded here", () => {
  // A state belongs to the build that wrote it, and the wrong one crashes.
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [row({ emulator: "dolphin" }), row({ emulator: null })],
      onDisk: [],
      target: PS2,
    }),
    [],
  );
});

test("a row naming another game, or no slot, is left where it is", () => {
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [
        row({ fileName: "SLUS-21354 (AABBCCDD).03.p2s" }),
        row({ fileName: "SLUS-20946 (0F2EF3B2).p2s" }),
        row({ fileName: "SLUS-20946 (0F2EF3B2).00.p2s" }),
      ],
      onDisk: [],
      target: PS2,
    }),
    [],
  );
});

test("a slot holding something newer than RomM's copy keeps it", () => {
  const taken = file("SLUS-20946 (0F2EF3B2).03.p2s", { modifiedAt: 9000 });
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [row({ updatedAt: 5000 })],
      onDisk: [taken],
      target: PS2,
    }),
    [],
  );
});

test("a slot holding something older is displaced, and says what it displaces", () => {
  const stale = file("SLUS-20946 (0F2EF3B2).03.p2s", { modifiedAt: 100 });
  const plan = planStandaloneRestore({
    emulatorId: "pcsx2",
    rows: [row({ updatedAt: 5000 })],
    onDisk: [stale],
    target: PS2,
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]?.displacing, stale);
});

test("a row whose name would not be safe to write is dropped", () => {
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [row({ fileName: "../../SLUS-20946 (0F2EF3B2).03.p2s" })],
      onDisk: [],
      target: PS2,
    }),
    [],
  );
});

test("a state name is one file in the folder and nothing else", () => {
  assert.equal(safeStateName("SLUS-20946 (0F2EF3B2).03.p2s"), true);
  assert.equal(safeStateName("sub/GALE01.s01"), false);
  assert.equal(safeStateName("sub\\GALE01.s01"), false);
  assert.equal(safeStateName("../GALE01.s01"), false);
  assert.equal(safeStateName(".."), false);
  assert.equal(safeStateName("GALE01.s01 "), false);
  assert.equal(safeStateName(""), false);
});

test("the row this machine's own push left does not come back down", () => {
  // The push runs after the exit that wrote the state, so RomM's stamp is
  // always later than the file's. Without the record, freshness alone would
  // archive the slot and fetch its own bytes back at every launch after it.
  const onDisk = [
    file("SLUS-20946 (0F2EF3B2).03.p2s", { modifiedAt: 1000 }),
  ];
  const mine = row({ id: 42, updatedAt: 9000 });
  const pushed = {
    [pushedSlotKey(3)]: { id: 42, updatedAt: 9000, mtimeMs: 1000 },
  };
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [mine],
      onDisk,
      target: PS2,
      pushed,
    }),
    [],
  );

  // Only that exact pairing. Another machine's newer row for the same slot is
  // still this launch's to take, and so is the same row once the file in the
  // slot is no longer the one it was pushed from.
  assert.equal(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [row({ id: 43, updatedAt: 9500 })],
      onDisk,
      target: PS2,
      pushed,
    }).length,
    1,
  );
  assert.equal(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [mine],
      onDisk: [file("SLUS-20946 (0F2EF3B2).03.p2s", { modifiedAt: 2000 })],
      target: PS2,
      pushed,
    }).length,
    1,
  );
});

test("an archived state is unreachable from every later restore", () => {
  // A capture is a new row stamped now, so an archive under a readable name
  // would be the newest thing RomM held for the slot and the next launch would
  // put it straight back, undoing the restore that displaced it.
  const archived = displacedStandaloneName(
    "SLUS-20946 (0F2EF3B2).03.p2s",
    new Date("2026-11-03T04:05:06.789Z"),
  );
  assert.equal(
    archived,
    "SLUS-20946 (0F2EF3B2).03.p2s.replaced-20261103-040506789000",
  );
  assert.equal(stateSlotOf("pcsx2", archived), null);
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [row({ fileName: archived, updatedAt: 9_000_000 })],
      onDisk: [],
      target: PS2,
    }),
    [],
  );
});

test("only PCSX2 carries a picture inside its states", () => {
  assert.equal(statesEmbedScreenshots("pcsx2"), true);
  assert.equal(statesEmbedScreenshots("dolphin"), false);
  assert.equal(
    stateScreenshotName("SLUS-20946 (0F2EF3B2).03.p2s"),
    "SLUS-20946 (0F2EF3B2).03.p2s.png",
  );
});
