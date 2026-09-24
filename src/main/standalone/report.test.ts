import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type StandaloneData } from "./data.ts";
import { parseRomIdentity } from "./identity.ts";
import { describeAfter, describeBefore, describeTarget } from "./report.ts";
import { type Tree } from "./tree.ts";

const DATA: StandaloneData = {
  emulatorId: "rpcs3",
  folder: "/home/sam/.config/rpcs3",
  source: "default",
  exists: true,
  saveRoot: "dev_hdd0/home/00000001/savedata",
  stateRoot: "savestates",
};

function tree(paths: Record<string, number>, complete = true): Tree {
  return {
    files: new Map(
      Object.entries(paths).map(([path, modifiedAt]) => [
        path,
        { size: 1, modifiedAt },
      ]),
    ),
    complete,
  };
}

const IDENTIFIED = parseRomIdentity({
  title_id: "BLUS-30001",
  save_target: "BLUS30001",
  save_target_layout: "folder-prefix",
});

test("each state of RomM's answer reads differently", () => {
  assert.equal(describeTarget(null), "RomM did not say what this game is");
  // A malformed body is read as an unidentified game, not an error.
  assert.equal(
    describeTarget(parseRomIdentity("<html>")),
    "RomM has no id for this game",
  );
  assert.equal(
    describeTarget(parseRomIdentity({ title_id: "GALE01" })),
    "RomM knows it as GALE01 but names no save target",
  );
  assert.equal(
    describeTarget(IDENTIFIED),
    "RomM names BLUS30001 (folder-prefix)",
  );
});

test("the start line names the folder and what the target selects there", () => {
  const saves = tree({ "BLUS30001-A/PARAM.SFO": 1, "BLUS30002/PARAM.SFO": 1 });
  assert.equal(
    describeBefore(12, DATA, saves, IDENTIFIED),
    `[standalone] rom 12: rpcs3 keeps saves in ${join(DATA.folder, DATA.saveRoot)} (default); RomM names BLUS30001 (folder-prefix), which selects 1 of 2 files there`,
  );
  // An emulator that has never run, and a partial listing, both say so.
  assert.match(
    describeBefore(12, { ...DATA, exists: false }, tree({}, false), IDENTIFIED),
    /\(default, not there yet\).*selects 0 of 0 listed files/,
  );
});

test("the exit line lists what the run wrote and what the target caught", () => {
  const before = tree({ "BLUS30001-A/DATA.BIN": 1, "OTHER/DATA.BIN": 1 });
  const after = tree({
    "BLUS30001-A/DATA.BIN": 2,
    "OTHER/DATA.BIN": 1,
    "NEW/DATA.BIN": 5,
  });
  assert.equal(
    describeAfter(12, "save", before, after, IDENTIFIED),
    "[standalone] rom 12: the run wrote 2 save files: BLUS30001-A/DATA.BIN, NEW/DATA.BIN; RomM's target selects 1 of them",
  );
  assert.equal(
    describeAfter(12, "state", before, before, null),
    "[standalone] rom 12: the run wrote no state files",
  );
});

test("an incomplete listing says nothing is known rather than guessing", () => {
  assert.equal(
    describeAfter(
      12,
      "save",
      tree({ a: 1 }, false),
      tree({ a: 1, b: 2 }),
      IDENTIFIED,
    ),
    "[standalone] rom 12: the save folder could not be read whole, so what the run wrote there is not known",
  );
});

test("a long list is cut short and counted", () => {
  const after = tree(
    Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `f${String(index).padStart(2, "0")}`,
        1,
      ]),
    ),
  );
  assert.match(
    describeAfter(1, "save", tree({}), after, null),
    /wrote 12 save files: f00, .*f09 and 2 more$/,
  );
});
