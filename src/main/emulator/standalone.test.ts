import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STANDALONE_EMULATORS,
  detectStandalone,
  emulatorForPlatform,
  detectedMappingFor,
  resetStandaloneDetection,
  toEmulatorMappings,
} from "./standalone.ts";

const WIN_ENV = {
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
};

/** Stand in for the filesystem, so every platform's paths can be exercised. */
function onDisk(...paths: string[]) {
  const present = new Set(paths);
  return (path: string) => present.has(path);
}

function pathsFor(id: string, platform: NodeJS.Platform, home: string) {
  const emulator = STANDALONE_EMULATORS.find((entry) => entry.id === id);
  assert.ok(emulator, `no such emulator: ${id}`);
  return emulator.paths(platform, home, WIN_ENV);
}

test("looks for PCSX2 where each platform puts it", () => {
  assert.ok(
    pathsFor("pcsx2", "darwin", "/Users/sam").includes(
      "/Applications/PCSX2.app/Contents/MacOS/PCSX2",
    ),
  );
  const windows = pathsFor("pcsx2", "win32", "C:\\Users\\sam");
  assert.ok(windows.includes("C:\\Program Files\\PCSX2\\pcsx2-qt.exe"));
  // The executable name is not guessable from the directory, which is the
  // whole reason detection is worth having: pcsx2-qt.exe, not pcsx2.exe.
  for (const path of windows) assert.match(path, /pcsx2-qt\.exe$/);
  const linux = pathsFor("pcsx2", "linux", "/home/sam");
  assert.ok(linux.includes("/usr/bin/pcsx2-qt"));
  assert.ok(
    linux.some((path) => path.includes("flatpak") && path.includes("PCSX2")),
  );
});

test("looks for Dolphin where each platform puts it", () => {
  assert.ok(
    pathsFor("dolphin", "darwin", "/Users/sam").includes(
      "/Applications/Dolphin.app/Contents/MacOS/Dolphin",
    ),
  );
  assert.ok(
    pathsFor("dolphin", "win32", "C:\\Users\\sam").includes(
      "C:\\Program Files\\Dolphin\\Dolphin.exe",
    ),
  );
  const linux = pathsFor("dolphin", "linux", "/home/sam");
  assert.ok(linux.includes("/usr/bin/dolphin-emu"));
  assert.ok(linux.includes("/usr/games/dolphin-emu"));
});

test("finds an emulator inside a frontend's own tree", () => {
  // Someone running RetroBat already has these; asking them to configure what
  // they installed would be the wrong request.
  const found = detectStandalone(
    "win32",
    "C:\\Users\\sam",
    WIN_ENV,
    onDisk("C:\\RetroBat\\emulators\\pcsx2\\pcsx2-qt.exe"),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.emulator.id, "pcsx2");
});

test("Windows paths are built with Windows separators", () => {
  // node:path follows the host, so without the win32 flavour these could only
  // ever be checked on Windows.
  for (const path of pathsFor("dolphin", "win32", "C:\\Users\\sam")) {
    assert.doesNotMatch(path, /\//, path);
    assert.doesNotMatch(path, /undefined/, path);
  }
});

test("finds nothing when nothing is installed", () => {
  assert.deepEqual(
    detectStandalone("darwin", "/Users/sam", {}, () => false),
    [],
  );
});

test("one Dolphin covers both GameCube and Wii", () => {
  const detected = detectStandalone(
    "darwin",
    "/Users/sam",
    {},
    onDisk("/Applications/Dolphin.app/Contents/MacOS/Dolphin"),
  );
  const mappings = toEmulatorMappings(detected);
  assert.deepEqual(
    mappings.map((mapping) => mapping.platformSlug),
    ["ngc", "wii"],
  );
  for (const mapping of mappings) {
    assert.equal(mapping.label, "Dolphin");
    // -b so it exits when the game stops and the shell window comes back.
    assert.deepEqual(mapping.args, ["-b", "-e", "{rom}"]);
  }
});

test("a detected row is shaped exactly like a hand-written one", () => {
  // So a detected emulator and a configured one travel the same launch path,
  // rather than there being a second mechanism to keep in step.
  const [mapping] = toEmulatorMappings(
    detectStandalone(
      "darwin",
      "/Users/sam",
      {},
      onDisk("/Applications/PCSX2.app/Contents/MacOS/PCSX2"),
    ),
  );
  assert.deepEqual(mapping, {
    platformSlug: "ps2",
    command: "/Applications/PCSX2.app/Contents/MacOS/PCSX2",
    args: ["-batch", "{rom}"],
    label: "PCSX2",
  });
});

test("a platform with no standalone emulator gets nothing", () => {
  resetStandaloneDetection();
  const exists = onDisk("/Applications/PCSX2.app/Contents/MacOS/PCSX2");
  assert.ok(detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists));
  assert.equal(
    detectedMappingFor("snes", "darwin", "/Users/sam", {}, exists),
    null,
  );
  resetStandaloneDetection();
});

test("platform slugs match without regard to case", () => {
  resetStandaloneDetection();
  const exists = onDisk("/Applications/Dolphin.app/Contents/MacOS/Dolphin");
  assert.ok(detectedMappingFor("NGC", "darwin", "/Users/sam", {}, exists));
  resetStandaloneDetection();
});

test("a miss is retried rather than remembered", () => {
  // An emulator installed while the app is running should be found without a
  // restart, so only a successful detection is worth caching.
  resetStandaloneDetection();
  let installed = false;
  const exists = (path: string) =>
    installed && path === "/Applications/PCSX2.app/Contents/MacOS/PCSX2";

  assert.equal(
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists),
    null,
  );
  installed = true;
  assert.ok(detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists));
  resetStandaloneDetection();
});

test("a hit is not re-probed on every call", () => {
  resetStandaloneDetection();
  let probes = 0;
  const exists = (path: string) => {
    probes += 1;
    return path === "/Applications/PCSX2.app/Contents/MacOS/PCSX2";
  };
  detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists);
  const afterFirst = probes;
  assert.ok(afterFirst > 0);
  for (let i = 0; i < 5; i += 1) {
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists);
  }
  assert.equal(probes, afterFirst, "detection should be memoised once found");
  resetStandaloneDetection();
});

test("each platform maps to the emulator that serves it", () => {
  assert.equal(emulatorForPlatform("ps2"), "pcsx2");
  // One Dolphin, two platforms.
  assert.equal(emulatorForPlatform("ngc"), "dolphin");
  assert.equal(emulatorForPlatform("wii"), "dolphin");
  assert.equal(emulatorForPlatform("NGC"), "dolphin");
});

test("a platform a core can handle maps to no standalone", () => {
  // Only the platforms RetroAchievements leaves no core option for are listed,
  // so nothing here should claim snes or psx.
  for (const slug of ["snes", "psx", "n64", "dreamcast", "3ds", ""]) {
    assert.equal(emulatorForPlatform(slug), null, slug);
  }
});
