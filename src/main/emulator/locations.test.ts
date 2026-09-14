import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coresCandidates,
  defaultCoresPath,
  retroarchCandidates,
} from "./locations.ts";

const WIN_HOME = "C:\\Users\\sam";
const WIN_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  APPDATA: "C:\\Users\\sam\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
};

test("looks for RetroArch where each platform actually puts it", () => {
  assert.deepEqual(retroarchCandidates("darwin", "/Users/sam", {}), [
    "/Applications/RetroArch.app/Contents/MacOS/RetroArch",
    "/Users/sam/Applications/RetroArch.app/Contents/MacOS/RetroArch",
  ]);
  const windows = retroarchCandidates("win32", WIN_HOME, WIN_ENV);
  // Portable first: it is the most specific, and the one a frontend ships.
  assert.equal(windows[0], "C:\\RetroArch-Win64\\retroarch.exe");
  assert.ok(windows.includes("C:\\Program Files\\RetroArch\\retroarch.exe"));
  assert.ok(windows.some((path) => path.includes("scoop")));
  assert.ok(windows.some((path) => path.includes("Steam")));
  assert.ok(windows.some((path) => path.includes("RetroBat")));
  assert.deepEqual(retroarchCandidates("linux", "/home/sam", {}), [
    "/usr/bin/retroarch",
    "/usr/local/bin/retroarch",
    "/home/sam/.local/bin/retroarch",
  ]);
});

test("falls back to conventional roots when the environment is bare", () => {
  // A Windows process can be missing these; the defaults have to stand in
  // rather than producing "undefined\\RetroArch".
  const candidates = retroarchCandidates("win32", WIN_HOME, {});
  for (const path of candidates) assert.doesNotMatch(path, /undefined/);
  assert.ok(
    candidates.includes("C:\\Program Files\\RetroArch\\retroarch.exe"),
    candidates.join(", "),
  );
});

test("looks for cores beside a Windows binary before the user profile", () => {
  // A portable install keeps them beside the exe; an installed one under the
  // profile. Beside the binary is the more specific answer, so it goes first.
  const candidates = coresCandidates(
    "C:\\RetroArch-Win64\\retroarch.exe",
    "win32",
    WIN_HOME,
    WIN_ENV,
  );
  assert.equal(candidates[0], "C:\\RetroArch-Win64\\cores");
  assert.ok(
    candidates.includes("C:\\Users\\sam\\AppData\\Roaming\\RetroArch\\cores"),
  );
});

test("still has somewhere to look for cores with no binary found", () => {
  const candidates = coresCandidates(null, "win32", WIN_HOME, WIN_ENV);
  assert.ok(candidates.length > 0);
  for (const path of candidates) assert.doesNotMatch(path, /undefined/);
});

test("looks in the Flatpak and distro core directories on Linux", () => {
  const candidates = coresCandidates(null, "linux", "/home/sam", {});
  assert.ok(candidates.includes("/home/sam/.config/retroarch/cores"));
  assert.ok(
    candidates.includes(
      "/home/sam/.var/app/org.libretro.RetroArch/config/retroarch/cores",
    ),
  );
  assert.ok(candidates.includes("/usr/lib/libretro"));
});

test("names where cores belong for a RetroArch that has never run", () => {
  // The gap this closes: a fresh install creates its cores directory on first
  // run, so until then there is nowhere for a downloaded core to go and core
  // downloading switches itself off.
  assert.equal(
    defaultCoresPath(
      "/Applications/RetroArch.app/Contents/MacOS/RetroArch",
      "darwin",
      "/Users/sam",
      {},
    ),
    "/Users/sam/Library/Application Support/RetroArch/cores",
  );
  assert.equal(
    defaultCoresPath(
      "C:\\Program Files\\RetroArch\\retroarch.exe",
      "win32",
      WIN_HOME,
      WIN_ENV,
    ),
    "C:\\Users\\sam\\AppData\\Roaming\\RetroArch\\cores",
  );
  assert.equal(
    defaultCoresPath("/usr/bin/retroarch", "linux", "/home/sam", {}),
    "/home/sam/.config/retroarch/cores",
  );
});

test("the Windows default is writable rather than beside the binary", () => {
  // Program Files needs an administrator, so defaulting cores next to an
  // installed binary would fail the write. A genuinely portable install ships a
  // cores directory, so coresCandidates finds it and this never runs.
  const path = defaultCoresPath(
    "C:\\Program Files\\RetroArch\\retroarch.exe",
    "win32",
    WIN_HOME,
    WIN_ENV,
  );
  assert.doesNotMatch(path!, /Program Files/);
});

test("offers no cores directory when no RetroArch was found", () => {
  // Nothing to guess for: an emulator the shell did not recognise, such as a
  // Flatpak RetroArch whose sandbox could not read these paths anyway, keeps
  // needing retroarchCoresPath set by hand rather than a guess that fails
  // silently.
  for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
    assert.equal(defaultCoresPath(null, platform, "/home/sam", WIN_ENV), null);
  }
});
