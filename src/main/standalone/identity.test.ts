import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRomIdentity, selectSaveFiles } from "./identity.ts";

test("a ROM body's identity is read as RomM spells it", () => {
  assert.deepEqual(
    parseRomIdentity({
      id: 12,
      title_id: "BLUS-30001",
      save_target: "BLUS30001",
      save_target_layout: "folder-prefix",
    }),
    { titleId: "BLUS-30001", saveTarget: "BLUS30001", layout: "folder-prefix" },
  );
});

test("a ROM the server could not identify has nothing to select with", () => {
  assert.deepEqual(parseRomIdentity({ title_id: null, save_target: null }), {
    titleId: null,
    saveTarget: null,
    layout: null,
  });
  assert.deepEqual(parseRomIdentity(null), {
    titleId: null,
    saveTarget: null,
    layout: null,
  });
});

test("a target with no layout it can be applied with is dropped", () => {
  const identity = parseRomIdentity({
    title_id: "GALE01",
    save_target: "GALE01",
    save_target_layout: "somewhere-new",
  });
  assert.equal(identity.titleId, "GALE01");
  assert.equal(identity.saveTarget, null);
  assert.equal(identity.layout, null);
});

test("a target shaped like a path out is refused", () => {
  for (const [target, layout] of [
    ["../../etc", "folder-split"],
    ["a/b", "folder-exact"],
    ["..", "file-prefix"],
    ["C:\\x", "folder-exact"],
    ["a\u0000b", "folder-exact"],
    ["x".repeat(300), "folder-exact"],
  ]) {
    assert.equal(
      parseRomIdentity({ save_target: target, save_target_layout: layout })
        .saveTarget,
      null,
      target,
    );
  }
});

const FILES = [
  "BLUS30001-SAVE00/PARAM.SFO",
  "BLUS30001-SAVE00/DATA.BIN",
  "BLUS30002/PARAM.SFO",
  "USA/Card A/01-GALE-SuperSmash.gci",
  "0004000e/0011c500/data/00000001/main",
  "0004000e/0011c501/data/00000001/main",
  "GALE01.sav",
  "GALE01X.sav",
];

test("a folder prefix selects every file in each matching save folder", () => {
  assert.deepEqual(selectSaveFiles(FILES, "blus30001", "folder-prefix"), [
    "BLUS30001-SAVE00/PARAM.SFO",
    "BLUS30001-SAVE00/DATA.BIN",
  ]);
});

test("an exact folder does not select one that merely starts the same", () => {
  assert.deepEqual(selectSaveFiles(FILES, "BLUS30002", "folder-exact"), [
    "BLUS30002/PARAM.SFO",
  ]);
  assert.deepEqual(selectSaveFiles(FILES, "BLUS3000", "folder-exact"), []);
});

test("a split target matches its folders in sequence, at any depth", () => {
  assert.deepEqual(
    selectSaveFiles(FILES, "0004000E/0011C500", "folder-split"),
    ["0004000e/0011c500/data/00000001/main"],
  );
});

test("file layouts read the name, a stem for the exact one", () => {
  assert.deepEqual(selectSaveFiles(FILES, "GALE01", "file-exact"), [
    "GALE01.sav",
  ]);
  assert.deepEqual(selectSaveFiles(FILES, "GALE01", "file-prefix"), [
    "GALE01.sav",
    "GALE01X.sav",
  ]);
  assert.deepEqual(selectSaveFiles(FILES, "01-GALE", "file-prefix"), [
    "USA/Card A/01-GALE-SuperSmash.gci",
  ]);
});
