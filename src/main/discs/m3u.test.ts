import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DiscFile,
  discNumberOf,
  readRomFiles,
  renderM3u,
  selectDiscs,
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

test("renderM3u names the discs relative to itself", () => {
  const text = renderM3u([
    file("Game (Disc 1).chd"),
    file("Game (Disc 2).chd"),
  ]);
  assert.equal(text, "Game (Disc 1).chd\nGame (Disc 2).chd\n");
  // No directory component: the playlist sits beside what it names, so it is
  // valid from the cache and from the user's own library alike.
  assert.ok(!text.includes("/"));
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
    null,
    "nope",
  ];
  assert.deepEqual(readRomFiles({ files: bad }), []);
  // And keeps the good rows beside the bad ones.
  assert.equal(readRomFiles({ files: [...bad, row] }).length, 1);
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
