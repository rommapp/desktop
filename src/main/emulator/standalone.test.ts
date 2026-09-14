import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STANDALONE_EMULATORS,
  detectStandalone,
  detectedMappingFor,
  detectedStandaloneLabels,
  emulatorForPlatform,
  resetStandaloneDetection,
  standaloneIsInstalled,
  standaloneLabel,
  toEmulatorMappings,
} from "./standalone.ts";

const WIN_ENV = {
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
};

/**
 * Stand in for the filesystem, so every platform's paths can be exercised.
 *
 * Returns both halves, because macOS detection scans /Applications for a bundle
 * whose name carries a version rather than checking a fixed path. The listing
 * is derived from the paths, so a test names a file once.
 */
function fakeFs(...paths: string[]) {
  const present = new Set(paths);
  const dirs = new Map<string, Set<string>>();
  for (const path of paths) {
    const match = /^(.*)\/([^/]+\.app)\//.exec(path);
    if (!match) continue;
    const root = match[1]!;
    if (!dirs.has(root)) dirs.set(root, new Set());
    dirs.get(root)!.add(match[2]!);
  }
  return {
    exists: (path: string) => present.has(path),
    readDir: (dir: string) => [...(dirs.get(dir) ?? [])],
  };
}

/** Just the directory half, for exercising paths() directly. */
function listing(entries: Record<string, string[]> = {}) {
  return (directory: string) => entries[directory] ?? [];
}

function pathsFor(
  id: string,
  platform: NodeJS.Platform,
  home: string,
  readDir = listing(),
) {
  const emulator = STANDALONE_EMULATORS.find((entry) => entry.id === id);
  assert.ok(emulator, `no such emulator: ${id}`);
  return emulator.paths(platform, home, WIN_ENV, readDir);
}

function detect(platform: NodeJS.Platform, home: string, ...paths: string[]) {
  const fs = fakeFs(...paths);
  return detectStandalone(platform, home, WIN_ENV, fs.exists, fs.readDir);
}

test("finds a PCSX2 bundle that carries its version number", () => {
  // The real one is PCSX2-v2.8.2.app, so nothing fixed can match it and the
  // directory has to be scanned. This is what "no libretro core is known for
  // ps2" turned out to mean on a Mac with PCSX2 sitting in /Applications.
  const readDir = listing({
    "/Applications": ["PCSX2-v2.8.2.app", "Safari.app"],
  });
  assert.deepEqual(pathsFor("pcsx2", "darwin", "/Users/sam", readDir), [
    "/Applications/PCSX2-v2.8.2.app/Contents/MacOS/PCSX2",
  ]);
});

test("an unversioned bundle and one under the home folder both count", () => {
  const readDir = listing({
    "/Applications": ["PCSX2.app"],
    "/Users/sam/Applications": ["PCSX2 2.9.app"],
  });
  assert.deepEqual(pathsFor("pcsx2", "darwin", "/Users/sam", readDir), [
    "/Applications/PCSX2.app/Contents/MacOS/PCSX2",
    "/Users/sam/Applications/PCSX2 2.9.app/Contents/MacOS/PCSX2",
  ]);
});

test("a different application starting with the same letters is not it", () => {
  // The suffix has to begin with a separator, or PCSX2Manager.app would be
  // launched as though it were the emulator.
  const readDir = listing({
    "/Applications": ["PCSX2Manager.app", "NotPCSX2.app", "PCSX2.txt"],
  });
  assert.deepEqual(pathsFor("pcsx2", "darwin", "/Users/sam", readDir), []);
});

test("an Applications folder with nothing in it yields nothing", () => {
  assert.deepEqual(pathsFor("dolphin", "darwin", "/Users/sam"), []);
  assert.deepEqual(detect("darwin", "/Users/sam"), []);
});

test("looks for PCSX2 where each platform puts it", () => {
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
  const readDir = listing({ "/Applications": ["Dolphin.app"] });
  assert.ok(
    pathsFor("dolphin", "darwin", "/Users/sam", readDir).includes(
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
  const found = detect(
    "win32",
    "C:\\Users\\sam",
    "C:\\RetroBat\\emulators\\pcsx2\\pcsx2-qt.exe",
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

test("one Dolphin covers both GameCube and Wii", () => {
  const mappings = toEmulatorMappings(
    detect(
      "darwin",
      "/Users/sam",
      "/Applications/Dolphin.app/Contents/MacOS/Dolphin",
    ),
  );
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
    detect(
      "darwin",
      "/Users/sam",
      "/Applications/PCSX2-v2.8.2.app/Contents/MacOS/PCSX2",
    ),
  );
  assert.deepEqual(mapping, {
    platformSlug: "ps2",
    command: "/Applications/PCSX2-v2.8.2.app/Contents/MacOS/PCSX2",
    args: ["-batch", "{rom}"],
    label: "PCSX2",
  });
});

test("a platform with no standalone emulator gets nothing", () => {
  resetStandaloneDetection();
  const fs = fakeFs("/Applications/PCSX2.app/Contents/MacOS/PCSX2");
  assert.ok(
    detectedMappingFor(
      "ps2",
      "darwin",
      "/Users/sam",
      {},
      fs.exists,
      fs.readDir,
    ),
  );
  assert.equal(
    detectedMappingFor(
      "snes",
      "darwin",
      "/Users/sam",
      {},
      fs.exists,
      fs.readDir,
    ),
    null,
  );
  resetStandaloneDetection();
});

test("platform slugs match without regard to case", () => {
  resetStandaloneDetection();
  const fs = fakeFs("/Applications/Dolphin.app/Contents/MacOS/Dolphin");
  assert.ok(
    detectedMappingFor(
      "NGC",
      "darwin",
      "/Users/sam",
      {},
      fs.exists,
      fs.readDir,
    ),
  );
  resetStandaloneDetection();
});

test("a miss is retried rather than remembered", () => {
  // An emulator installed while the app is running should be found without a
  // restart, so only a successful detection is worth caching.
  resetStandaloneDetection();
  let installed = false;
  const path = "/Applications/PCSX2.app/Contents/MacOS/PCSX2";
  const exists = (candidate: string) => installed && candidate === path;
  const readDir = (dir: string) =>
    installed && dir === "/Applications" ? ["PCSX2.app"] : [];

  assert.equal(
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir),
    null,
  );
  installed = true;
  assert.ok(
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir),
  );
  resetStandaloneDetection();
});

test("finding one emulator does not stop the other being looked for", () => {
  // The memo is per emulator. Remembering "something was found" would mean
  // installing PCSX2 on a machine that already had Dolphin went unnoticed
  // until a restart -- exactly the case this has to handle.
  resetStandaloneDetection();
  let pcsx2Installed = false;
  const dolphin = "/Applications/Dolphin.app/Contents/MacOS/Dolphin";
  const pcsx2 = "/Applications/PCSX2.app/Contents/MacOS/PCSX2";
  const exists = (candidate: string) =>
    candidate === dolphin || (pcsx2Installed && candidate === pcsx2);
  const readDir = (dir: string) =>
    dir === "/Applications"
      ? ["Dolphin.app", ...(pcsx2Installed ? ["PCSX2.app"] : [])]
      : [];

  assert.ok(
    detectedMappingFor("ngc", "darwin", "/Users/sam", {}, exists, readDir),
  );
  assert.equal(
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir),
    null,
  );
  pcsx2Installed = true;
  assert.ok(
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir),
    "PCSX2 installed later must still be found",
  );
  resetStandaloneDetection();
});

test("a hit is not re-probed on every call", () => {
  resetStandaloneDetection();
  let probes = 0;
  const path = "/Applications/PCSX2.app/Contents/MacOS/PCSX2";
  const exists = (candidate: string) => {
    probes += 1;
    return candidate === path;
  };
  const readDir = (dir: string) =>
    dir === "/Applications" ? ["PCSX2.app"] : [];

  detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir);
  const afterFirst = probes;
  assert.ok(afterFirst > 0);
  for (let i = 0; i < 5; i += 1) {
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir);
  }
  // Dolphin is still missing so it is re-probed; PCSX2 is not.
  assert.ok(
    probes - afterFirst < 5,
    `expected the PCSX2 hit to be memoised, probes went ${afterFirst} -> ${probes}`,
  );
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

test("an emulator installed mid-run is seen without a restart", () => {
  // What the launch waits on after handing an installer to the OS: the memo has
  // to be dropped on every look, or the answer is the one from before the
  // install and the game never starts.
  const bundles = ["Safari.app"];
  const readDir = (directory: string) =>
    directory === "/Applications" ? bundles : [];
  const exists = (path: string) =>
    path === "/Applications/PCSX2-v2.8.2.app/Contents/MacOS/PCSX2";

  assert.equal(
    standaloneIsInstalled("pcsx2", "darwin", "/Users/sam", {}, exists, readDir),
    false,
  );
  bundles.push("PCSX2-v2.8.2.app");
  assert.ok(
    standaloneIsInstalled("pcsx2", "darwin", "/Users/sam", {}, exists, readDir),
  );
  // Dolphin is not PCSX2, however much of the scan they share.
  assert.equal(
    standaloneIsInstalled(
      "dolphin",
      "darwin",
      "/Users/sam",
      {},
      exists,
      readDir,
    ),
    false,
  );
  resetStandaloneDetection();
});

test("names the emulators a machine turns out to have", () => {
  const fs = fakeFs(
    "/Applications/Dolphin.app/Contents/MacOS/Dolphin",
    "/Applications/PCSX2-v2.8.2.app/Contents/MacOS/PCSX2",
  );
  // Table order, not disk order, so a message reads the same on every machine.
  assert.deepEqual(
    detectedStandaloneLabels("darwin", "/Users/sam", {}, fs.exists, fs.readDir),
    ["PCSX2", "Dolphin"],
  );
  assert.deepEqual(
    detectedStandaloneLabels(
      "darwin",
      "/Users/sam",
      {},
      () => false,
      () => [],
    ),
    [],
  );
});

test("an emulator can be named before it is installed", () => {
  // The offer and the wait both talk about it while there is nothing on disk.
  assert.equal(standaloneLabel("pcsx2"), "PCSX2");
  assert.equal(standaloneLabel("dolphin"), "Dolphin");
  assert.equal(standaloneLabel("nothing"), null);
});
