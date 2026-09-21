import assert from "node:assert/strict";
import { basename, join, sep } from "node:path";
import { test } from "node:test";
import { newerSibling, resolveSavePaths, saveBaseName } from "./paths.ts";

const ROOT = join("/var", "save-data");

test("resolveSavePaths is disabled without a root", () => {
  assert.equal(resolveSavePaths(null, 1, "game.sfc"), null);
});

test("resolveSavePaths separates saves from states under the ROM id", () => {
  const paths = resolveSavePaths(ROOT, 42, "Super Mario 64 (USA).z64");
  assert.deepEqual(paths, {
    saveDir: join(ROOT, "42", "saves"),
    stateDir: join(ROOT, "42", "states"),
    saveFile: join(ROOT, "42", "saves", "Super Mario 64 (USA).srm"),
    statePrefix: join(ROOT, "42", "states", "Super Mario 64 (USA).state"),
  });
});

test("the save is named after the ROM the server reported", () => {
  const paths = resolveSavePaths(ROOT, 7, "Chrono Trigger.sfc");
  assert.ok(paths);
  // The cache stores this under 7/Chrono Trigger.sfc, so a launch from there
  // and one straight out of the library agree on the save.
  assert.equal(basename(paths.saveFile), "Chrono Trigger.srm");
});

test("saveBaseName drops the extension and keeps the rest of the name", () => {
  assert.equal(saveBaseName("Sonic 3 & Knuckles.md"), "Sonic 3 & Knuckles");
  assert.equal(
    saveBaseName("Final Fantasy VII (Disc 1).chd"),
    "Final Fantasy VII (Disc 1)",
  );
  assert.equal(saveBaseName("no-extension"), "no-extension");
});

test("saveBaseName never yields an empty or traversing component", () => {
  for (const name of ["", ".", "..", "../../etc/passwd", ".srm"]) {
    const base = saveBaseName(name);
    assert.ok(base.length > 0, `${name} must not vanish`);
    assert.ok(!base.includes(sep), `${name} must stay one component`);
    assert.ok(!base.includes("/"), `${name} must stay one component`);
  }
});

test("saveBaseName steps around names Windows reserves for devices", () => {
  // Reserved with an extension too, so `CON.srm` is as unopenable as `CON`.
  assert.equal(saveBaseName("CON.zip"), "_CON");
  assert.equal(saveBaseName("aux.nes"), "_aux");
  assert.equal(saveBaseName("com1.bin"), "_com1");
  // Only the exact device names: a game that merely starts with one is fine.
  assert.equal(saveBaseName("Contra.nes"), "Contra");
  assert.equal(saveBaseName("Auxiliary.gb"), "Auxiliary");
});

test("resolveSavePaths keeps a hostile filename inside the root", () => {
  const paths = resolveSavePaths(ROOT, 1, "../../../../etc/passwd");
  assert.ok(paths);
  assert.ok(paths.saveFile.startsWith(join(ROOT, "1") + sep));
});

test("a save written after ours, under another name, is named", () => {
  // The emulator names the save, not the shell: a launch pins the directory but
  // a name derived from the content can still differ, and then the shell's file
  // sits untouched beside the one the game is really writing.
  const ours = { name: "Game.srm", modifiedAt: 1_000 };
  const beside = [
    ours,
    { name: "Game (USA).srm", modifiedAt: 2_000 },
    { name: "Game (Europe).srm", modifiedAt: 1_500 },
  ];

  assert.equal(newerSibling(ours, beside), "Game (USA).srm");
});

test("nothing is named when our own save is the newest, or the only one", () => {
  const ours = { name: "Game.srm", modifiedAt: 3_000 };

  assert.equal(newerSibling(ours, [ours]), null);
  assert.equal(newerSibling(ours, []), null);
  assert.equal(
    newerSibling(ours, [ours, { name: "Game (USA).srm", modifiedAt: 2_999 }]),
    null,
  );
});

test("only saves count, not the state and temp files beside them", () => {
  // A launch writes states into their own directory, but a download in progress
  // and a stray file are not saves the emulator wrote.
  const ours = { name: "Game.srm", modifiedAt: 1_000 };
  const beside = [
    ours,
    { name: ".Game.srm.part", modifiedAt: 5_000 },
    { name: "Game.state", modifiedAt: 5_000 },
    { name: "Game.SRM.backup", modifiedAt: 5_000 },
  ];

  assert.equal(newerSibling(ours, beside), null);
});
