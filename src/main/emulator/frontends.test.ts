import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRONTEND_EMULATOR_IDS,
  emulatorsInFolder,
  frontendCandidates,
} from "./frontends.ts";

const HOME = "C:\\Users\\sam";
const ENV = { USERPROFILE: "C:\\Users\\sam" };

/** Folders under the chosen one, matched as Windows matches them: without
 *  regard to case, which is what lets one spelling cover ES-DE's "Emulators"
 *  and RetroBat's "emulators". */
function inFolder(chosen: string, ...files: string[]): string[] {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return emulatorsInFolder(chosen, "win32", HOME, ENV, (path) =>
    present.has(path.toLowerCase()),
  );
}

test("finds RetroBat's emulators from its root or its emulators folder", () => {
  const files = [
    "D:\\RetroBat\\emulators\\retroarch\\retroarch.exe",
    "D:\\RetroBat\\emulators\\pcsx2\\pcsx2-qt.exe",
    "D:\\RetroBat\\emulators\\dolphin-emu\\Dolphin.exe",
    "D:\\RetroBat\\emulators\\rpcs3\\rpcs3.exe",
    "D:\\RetroBat\\emulators\\cemu\\Cemu.exe",
  ];
  assert.deepEqual(inFolder("D:\\RetroBat", ...files), [...FRONTEND_EMULATOR_IDS]);
  assert.deepEqual(inFolder("D:\\RetroBat\\emulators", ...files), [...FRONTEND_EMULATOR_IDS]);
});

test("finds ES-DE's portable Emulators folder", () => {
  assert.deepEqual(
    inFolder(
      "E:\\ES-DE",
      "E:\\ES-DE\\Emulators\\RetroArch-Win64\\retroarch.exe",
      "E:\\ES-DE\\Emulators\\PCSX2-Qt\\pcsx2-qt.exe",
      "E:\\ES-DE\\Emulators\\Dolphin-x64\\Dolphin.exe",
    ),
    ["retroarch", "pcsx2", "dolphin"],
  );
});

test("finds EmuDeck's emulators from its profile folder, including its PCSX2 name", () => {
  assert.deepEqual(
    inFolder(
      "C:\\Users\\sam\\emudeck",
      "C:\\Users\\sam\\emudeck\\EmulationStation-DE\\Emulators\\PCSX2-Qt\\pcsx2-qtx64.exe",
    ),
    ["pcsx2"],
  );
});

test("an emulator's own folder, picked directly, finds that emulator", () => {
  assert.deepEqual(
    inFolder("D:\\Emus\\Cemu 2.6", "D:\\Emus\\Cemu 2.6\\Cemu.exe"),
    ["cemu"],
  );
});

test("a folder with nothing recognisable in it finds nothing", () => {
  assert.deepEqual(inFolder("D:\\Photos", "D:\\Photos\\retroarch.png"), []);
});

test("default roots are kept apart from a chosen folder", () => {
  const { chosen, defaults } = frontendCandidates("dolphin", null, "win32", HOME, ENV);
  assert.deepEqual(chosen, []);
  assert.ok(defaults.includes("C:\\RetroBat\\emulators\\dolphin-emu\\Dolphin.exe"));
  assert.ok(
    defaults.includes(
      "C:\\Users\\sam\\emudeck\\EmulationStation-DE\\Emulators\\Dolphin-x64\\Dolphin.exe",
    ),
  );
  for (const path of defaults) assert.doesNotMatch(path, /\/|undefined/, path);
});

test("the frontends' layouts are Windows-only", () => {
  // On Linux EmuDeck uses Flatpaks and AppImages, which the standalone table
  // finds by itself; no frontend there keeps a tree of Windows executables.
  for (const platform of ["linux", "darwin"] as const) {
    assert.deepEqual(frontendCandidates("pcsx2", "/home/sam/RetroBat", platform, "/home/sam", {}), {
      chosen: [],
      defaults: [],
    });
  }
});
