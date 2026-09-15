import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DiscFile,
  discNumberOf,
  readRomFiles,
  renderM3u,
  selectDiscs,
  selectStagedFiles,
} from "./m3u.ts";

function file(fileName: string, id = 1): DiscFile {
  return { id, fileName, fullPath: `psx/game/${fileName}`, sizeBytes: 10 };
}

test("discNumberOf reads the shapes a disc set is named with", () => {
  assert.equal(discNumberOf("Final Fantasy VII (USA) (Disc 2).chd"), 2);
  assert.equal(discNumberOf("Game (Disk 3).cue"), 3);
  assert.equal(discNumberOf("Game CD2.chd"), 2);
  assert.equal(discNumberOf("Game (Disc 11).chd"), 11);
  assert.equal(discNumberOf("Chrono Trigger.sfc"), null);
  // "Disco" is not a disc, and neither is a bare number.
  assert.equal(discNumberOf("Disco Inferno.chd"), null);
  assert.equal(discNumberOf("Game 2.chd"), null);
});

test("selectDiscs keeps only what an emulator can boot", () => {
  const discs = selectDiscs([
    file("Game (Disc 1).chd"),
    file("Game.txt"),
    file("Game (Disc 2).chd"),
    file("cover.png"),
    file("manual.pdf"),
  ]);
  assert.deepEqual(
    discs.map((d) => d.fileName),
    ["Game (Disc 1).chd", "Game (Disc 2).chd"],
  );
});

test("selectDiscs orders by disc number, not by name", () => {
  // Sorted by name these run 1, 10, 2; a player would find disc 10 second.
  const discs = selectDiscs([
    file("Game (Disc 10).chd"),
    file("Game (Disc 2).chd"),
    file("Game (Disc 1).chd"),
  ]);
  assert.deepEqual(
    discs.map((d) => discNumberOf(d.fileName)),
    [1, 2, 10],
  );
});

test("selectDiscs prefers the sheet over the data it describes", () => {
  // Handing an emulator the .bin of a cue/bin pair loses the track layout, and
  // listing both would make one disc look like two.
  const discs = selectDiscs([
    file("Game (Disc 1).cue"),
    file("Game (Disc 1).bin"),
    file("Game (Disc 2).cue"),
    file("Game (Disc 2).bin"),
  ]);
  assert.deepEqual(
    discs.map((d) => d.fileName),
    ["Game (Disc 1).cue", "Game (Disc 2).cue"],
  );
});

test("selectDiscs keeps a bare bin when nothing describes it", () => {
  const discs = selectDiscs([file("Game (Track 1).bin")]);
  assert.deepEqual(
    discs.map((d) => d.fileName),
    ["Game (Track 1).bin"],
  );
});

test("selectDiscs falls back to name order when nothing is numbered", () => {
  const discs = selectDiscs([file("beta.chd"), file("alpha.chd")]);
  assert.deepEqual(
    discs.map((d) => d.fileName),
    ["alpha.chd", "beta.chd"],
  );
});

test("selectStagedFiles keeps the tracks a sheet cannot boot without", () => {
  // The .cue names its .bin by relative name, so leaving the data out of the
  // download would fetch a sheet pointing at a file nobody has.
  const staged = selectStagedFiles([
    file("Game (Disc 1).cue", 1),
    file("Game (Disc 1).bin", 2),
    file("Game (Disc 2).cue", 3),
    file("Game (Disc 2).bin", 4),
    file("Game.txt", 5),
    file("cover.png", 6),
  ]);
  assert.deepEqual(
    staged.map((f) => f.fileName),
    [
      "Game (Disc 1).bin",
      "Game (Disc 1).cue",
      "Game (Disc 2).bin",
      "Game (Disc 2).cue",
    ],
  );
  // The playlist still names the sheets alone.
  assert.deepEqual(
    selectDiscs([
      file("Game (Disc 1).cue", 1),
      file("Game (Disc 1).bin", 2),
      file("Game (Disc 2).cue", 3),
      file("Game (Disc 2).bin", 4),
    ]).map((f) => f.fileName),
    ["Game (Disc 1).cue", "Game (Disc 2).cue"],
  );
});

test("selectStagedFiles keeps a sheet's audio tracks too", () => {
  const staged = selectStagedFiles([
    file("Game (Disc 1).cue", 1),
    file("Game (Disc 1) (Track 1).bin", 2),
    file("Game (Disc 1) (Track 2).wav", 3),
    file("Game (Disc 2).cue", 4),
    file("readme.nfo", 5),
  ]);
  assert.deepEqual(staged.map((f) => f.fileName).sort(), [
    "Game (Disc 1) (Track 1).bin",
    "Game (Disc 1) (Track 2).wav",
    "Game (Disc 1).cue",
    "Game (Disc 2).cue",
  ]);
});

test("renderM3u lists one disc per line, in the order given", () => {
  const text = renderM3u([
    "/cache/7/Game (Disc 1).chd",
    "/library/psx/Game/Game (Disc 2).chd",
  ]);
  assert.equal(
    text,
    "/cache/7/Game (Disc 1).chd\n/library/psx/Game/Game (Disc 2).chd\n",
  );
});

test("renderM3u ends every line with LF, which is all Dolphin accepts", () => {
  const text = renderM3u(["/cache/7/a.chd", "/cache/7/b.chd"]);
  assert.ok(!text.includes("\r"));
  assert.ok(text.endsWith("\n"));
});

const row = {
  id: 4,
  file_name: "Game (Disc 1).chd",
  full_path: "psx/Game/Game (Disc 1).chd",
  file_size_bytes: 700,
};

test("readRomFiles takes the fields a disc needs", () => {
  assert.deepEqual(readRomFiles({ files: [row] }), [
    {
      id: 4,
      fileName: "Game (Disc 1).chd",
      fullPath: "psx/Game/Game (Disc 1).chd",
      sizeBytes: 700,
    },
  ]);
});

test("readRomFiles survives a body that is not the one expected", () => {
  for (const body of [null, undefined, 7, "files", {}, { files: {} }]) {
    assert.deepEqual(readRomFiles(body), []);
  }
});

test("readRomFiles drops a row missing anything it needs", () => {
  const bad = [
    { ...row, id: "4" },
    { ...row, file_name: "" },
    { ...row, file_name: 9 },
    { ...row, full_path: null },
    { ...row, file_size_bytes: "700" },
    { ...row, file_size_bytes: -1 },
    // An id that is not a whole positive number is not one the content
    // endpoint can be asked for: file_ids=-1 fails the request outright.
    { ...row, id: -1 },
    { ...row, id: 0 },
    { ...row, id: 1.5 },
    { ...row, file_size_bytes: 1.5 },
    null,
    "nope",
  ];
  assert.deepEqual(readRomFiles({ files: bad }), []);
  // And keeps the good rows beside the bad ones.
  assert.equal(readRomFiles({ files: [...bad, row] }).length, 1);
});

test("readRomFiles keeps the first of two rows naming one file", () => {
  // Both would land on the same path, and the playlist would name it twice.
  const files = readRomFiles({
    files: [row, { ...row, id: 9, file_name: "game (disc 1).CHD" }],
  });
  assert.deepEqual(
    files.map((f) => f.id),
    [4],
  );
});

test("readRomFiles refuses a name that would not stay put", () => {
  // The name becomes a path inside the rom's cache directory, so anything the
  // filesystem would read differently is dropped rather than sanitised: a
  // renamed disc is one the playlist would then fail to name.
  for (const fileName of [
    "../escape.chd",
    "sub/dir.chd",
    "back\\slash.chd",
    "CON.chd",
    "trailing.chd ",
  ]) {
    assert.deepEqual(
      readRomFiles({ files: [{ ...row, file_name: fileName }] }),
      [],
      fileName,
    );
  }
});
