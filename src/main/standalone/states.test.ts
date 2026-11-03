import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displacedStandaloneName,
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
} from "./states.ts";

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
});

test("a Dolphin Wii state is this game's, which a save target could not say", () => {
  // RomM's Wii save target is a folder name (folder-exact) and a state is a
  // flat file, so matching one against the other rejected every Wii state
  // silently. What makes a state this game's is that this run wrote it.
  const plan = planStandaloneStates({
    emulatorId: "dolphin",
    before: [],
    after: [file("RSBE01.s03")],
    maxBytes: 1024,
  });
  assert.deepEqual(
    plan.send.map((entry) => entry.slot),
    [3],
  );
});

test("a contested folder sends nothing, since whose states these are is unknown", () => {
  const plan = planStandaloneStates({
    emulatorId: "pcsx2",
    before: [],
    after: [file("SLUS-20946 (0F2EF3B2).01.p2s")],
    contested: true,
    maxBytes: 1024,
  });
  assert.deepEqual(plan.send, []);
});

test("a state past the ceiling is named rather than sent", () => {
  const plan = planStandaloneStates({
    emulatorId: "pcsx2",
    before: [],
    after: [file("SLUS-20946 (0F2EF3B2).01.p2s", { size: 5000 })],
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
    maxBytes: 1024,
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
      maxBytes: 1024,
    }),
    [],
  );
});

test("a row carrying no slot this emulator addresses is left where it is", () => {
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [
        row({ fileName: "SLUS-20946 (0F2EF3B2).p2s" }),
        row({ fileName: "SLUS-20946 (0F2EF3B2).00.p2s" }),
      ],
      onDisk: [],
      maxBytes: 1024,
    }),
    [],
  );
});

test("a row whose name differs is still this ROM's, since the server scoped it", () => {
  // The rows came from /api/states?rom_id=, so they are this game's by
  // construction. A filename check on top only rejected what it misread.
  assert.equal(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [row({ fileName: "Something Else.03.p2s" })],
      onDisk: [],
      maxBytes: 1024,
    }).length,
    1,
  );
});

test("a row past the ceiling never reaches the download", () => {
  // The fetch is bounded by the row's own declared size, which is the
  // server's word, so a row claiming gigabytes has to be dropped before it.
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [row({ size: 5000 })],
      onDisk: [],
      maxBytes: 1024,
    }),
    [],
  );
});

test("the newest row wins before the pushed record is consulted", () => {
  // Skipping this machine's row first let the slot fall back to older
  // history, which would overwrite the state that push had just made.
  const plan = planStandaloneRestore({
    emulatorId: "pcsx2",
    rows: [row({ id: 1, updatedAt: 5000 }), row({ id: 2, updatedAt: 9000 })],
    onDisk: [file("SLUS-20946 (0F2EF3B2).03.p2s", { modifiedAt: 1000 })],
    pushed: { [pushedSlotKey(3)]: { id: 2, updatedAt: 9000, mtimeMs: 1000 } },
    maxBytes: 1024,
  });
  assert.deepEqual(plan, []);
});

test("rows tie on the second are broken by the later id", () => {
  const plan = planStandaloneRestore({
    emulatorId: "pcsx2",
    rows: [row({ id: 7, updatedAt: 5000 }), row({ id: 9, updatedAt: 5000 })],
    onDisk: [],
    maxBytes: 1024,
  });
  assert.equal(plan[0]?.row.id, 9);
});

test("a slot spelled differently is still the file a restore overwrites", () => {
  // On Windows and macOS these are one file, so reading the slot as empty
  // would replace it without checking freshness or archiving its bytes.
  const local = file("GALE01.s03", { modifiedAt: 100 });
  const plan = planStandaloneRestore({
    emulatorId: "dolphin",
    rows: [row({ fileName: "gale01.s03", emulator: "dolphin", updatedAt: 5000 })],
    onDisk: [local],
    maxBytes: 1024,
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]?.displacing, local);
});

test("two spellings at once put neither at risk", () => {
  // Only a filesystem that keeps them apart can hold both, and there a write
  // to a name neither carries creates a new file with nothing in its way.
  const plan = planStandaloneRestore({
    emulatorId: "dolphin",
    rows: [row({ fileName: "GaLe01.s03", emulator: "dolphin", updatedAt: 5000 })],
    onDisk: [file("GALE01.s03"), file("gale01.s03")],
    maxBytes: 1024,
  });
  assert.equal(plan[0]?.displacing, null);
});

test("a slot holding something newer than RomM's copy keeps it", () => {
  const taken = file("SLUS-20946 (0F2EF3B2).03.p2s", { modifiedAt: 9000 });
  assert.deepEqual(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [row({ updatedAt: 5000 })],
      onDisk: [taken],
      maxBytes: 1024,
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
    maxBytes: 1024,
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
      maxBytes: 1024,
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
      pushed,
      maxBytes: 1024,
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
      pushed,
      maxBytes: 1024,
    }).length,
    1,
  );
  assert.equal(
    planStandaloneRestore({
      emulatorId: "pcsx2",
      rows: [mine],
      onDisk: [file("SLUS-20946 (0F2EF3B2).03.p2s", { modifiedAt: 2000 })],
      pushed,
      maxBytes: 1024,
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
      maxBytes: 1024,
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
