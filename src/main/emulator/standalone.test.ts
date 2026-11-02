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

test("looks for RPCS3 where each platform puts it", () => {
  // The bundle is RPCS3.app and the binary inside it is lowercase, which is
  // exactly the kind of thing detection exists to stop people guessing at.
  const readDir = listing({ "/Applications": ["RPCS3.app"] });
  assert.deepEqual(pathsFor("rpcs3", "darwin", "/Users/sam", readDir), [
    "/Applications/RPCS3.app/Contents/MacOS/rpcs3",
  ]);
  const windows = pathsFor("rpcs3", "win32", "C:\\Users\\sam");
  assert.ok(windows.includes("C:\\Program Files\\RPCS3\\rpcs3.exe"));
  for (const path of windows) assert.match(path, /rpcs3\.exe$/);
  const linux = pathsFor("rpcs3", "linux", "/home/sam");
  assert.ok(linux.includes("/usr/bin/rpcs3"));
  assert.ok(
    linux.some(
      (path) => path.includes("flatpak") && path.endsWith("net.rpcs3.RPCS3"),
    ),
  );
});

test("looks for Cemu where each platform puts it", () => {
  const readDir = listing({ "/Applications": ["Cemu.app"] });
  assert.deepEqual(pathsFor("cemu", "darwin", "/Users/sam", readDir), [
    "/Applications/Cemu.app/Contents/MacOS/Cemu",
  ]);
  // Cemu's own installer defaults to LOCALAPPDATA\Cemu rather than the
  // Programs directory the others use, so that is the first place to look.
  const windows = pathsFor("cemu", "win32", "C:\\Users\\sam");
  assert.equal(windows[0], "C:\\Users\\sam\\AppData\\Local\\Cemu\\Cemu.exe");
  for (const path of windows) assert.match(path, /Cemu\.exe$/);
  const linux = pathsFor("cemu", "linux", "/home/sam");
  // Capitalised: cemu is not what its build installs, and a case-insensitive
  // filesystem is not something to count on.
  assert.ok(linux.includes("/usr/bin/Cemu"));
  assert.ok(
    linux.some(
      (path) => path.includes("flatpak") && path.endsWith("info.cemu.Cemu"),
    ),
  );
});

test("the platforms RetroArch cannot play at all have a row each", () => {
  // PS2 and GameCube/Wii are here because RetroAchievements recognises no
  // libretro core for them; PS3 and Wii U because libretro has no core at all,
  // so without these two rows the platforms simply do not launch.
  const found = toEmulatorMappings(
    detect(
      "linux",
      "/home/sam",
      "/usr/bin/rpcs3",
      "/var/lib/flatpak/exports/bin/info.cemu.Cemu",
    ),
  );
  assert.deepEqual(found, [
    {
      platformSlug: "ps3",
      command: "/usr/bin/rpcs3",
      // --no-gui so it quits when the game stops.
      args: ["--no-gui", "{rom}"],
      label: "RPCS3",
      playlist: false,
      emulatorId: "rpcs3",
    },
    {
      platformSlug: "wiiu",
      command: "/var/lib/flatpak/exports/bin/info.cemu.Cemu",
      args: ["-g", "{rom}"],
      label: "Cemu",
      playlist: false,
      emulatorId: "cemu",
    },
  ]);
});

test("every emulator in the table names its platforms and arguments", () => {
  // A row that named no platform would be detected and never used, and one
  // without {rom} would launch the emulator with no game in it.
  const slugs = new Set<string>();
  for (const emulator of STANDALONE_EMULATORS) {
    assert.ok(emulator.platformSlugs.length > 0, emulator.id);
    assert.ok(
      emulator.args.some((arg) => arg.includes("{rom}")),
      emulator.id,
    );
    // No {core}: a standalone emulator that asked for one would trigger a core
    // download it would never load.
    for (const arg of emulator.args) {
      assert.doesNotMatch(arg, /\{core\}/, emulator.id);
    }
    for (const slug of emulator.platformSlugs) {
      assert.equal(slug, slug.toLowerCase(), emulator.id);
      // Two emulators claiming one platform would make the table's order
      // decide which one plays it.
      assert.equal(slugs.has(slug), false, slug);
      slugs.add(slug);
    }
  }
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
  // rather than there being a second mechanism to keep in step. The id is one
  // a hand-written row can carry too.
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
    playlist: false,
    emulatorId: "pcsx2",
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

test("a hit costs one stat per call, not another scan", () => {
  // Every emulator found, so nothing is left to look for and every later call
  // should be the liveness check and nothing else: no directory scan, and one
  // stat each to confirm the remembered paths are still there. All of them
  // have to be installed for that to hold -- one missing emulator is one the
  // next call has to go looking for again, which is the point of the memo
  // being per emulator rather than a single "something was found".
  resetStandaloneDetection();
  let probes = 0;
  let scans = 0;
  const bundles = ["PCSX2.app", "Dolphin.app", "RPCS3.app", "Cemu.app"];
  const paths = new Set([
    "/Applications/PCSX2.app/Contents/MacOS/PCSX2",
    "/Applications/Dolphin.app/Contents/MacOS/Dolphin",
    "/Applications/RPCS3.app/Contents/MacOS/rpcs3",
    "/Applications/Cemu.app/Contents/MacOS/Cemu",
  ]);
  assert.equal(
    paths.size,
    STANDALONE_EMULATORS.length,
    "every emulator in the table needs a bundle here, or the memo has one left to look for",
  );
  const exists = (candidate: string) => {
    probes += 1;
    return paths.has(candidate);
  };
  const readDir = (dir: string) => {
    scans += 1;
    return dir === "/Applications" ? bundles : [];
  };

  detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir);
  assert.ok(scans > 0, "the first call has to look");
  probes = 0;
  scans = 0;
  for (let i = 0; i < 5; i += 1) {
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir);
  }
  assert.equal(scans, 0, "a remembered emulator is not scanned for again");
  assert.equal(
    probes,
    STANDALONE_EMULATORS.length * 5,
    "one stat per remembered emulator per call",
  );
  resetStandaloneDetection();
});

test("an emulator that disappears is not remembered as installed", () => {
  // A version in the bundle name means an upgrade renames it:
  // PCSX2-v2.8.2.app becomes PCSX2-v2.9.0.app and the remembered path is gone.
  // Holding on to it would keep resolving to a deleted binary until a restart,
  // while hasPlatformSpecificEmulator kept saying an emulator was present.
  resetStandaloneDetection();
  let version = "2.8.2";
  const bundle = () => `PCSX2-v${version}.app`;
  const exists = (candidate: string) =>
    candidate === `/Applications/${bundle()}/Contents/MacOS/PCSX2`;
  const readDir = (dir: string) => (dir === "/Applications" ? [bundle()] : []);

  assert.equal(
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir)
      ?.command,
    "/Applications/PCSX2-v2.8.2.app/Contents/MacOS/PCSX2",
  );
  version = "2.9.0";
  assert.equal(
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, exists, readDir)
      ?.command,
    "/Applications/PCSX2-v2.9.0.app/Contents/MacOS/PCSX2",
  );

  // And uninstalled is uninstalled, not "found earlier".
  version = "gone";
  const empty = () => [];
  assert.equal(
    detectedMappingFor("ps2", "darwin", "/Users/sam", {}, () => false, empty),
    null,
  );
  resetStandaloneDetection();
});

test("each platform maps to the emulator that serves it", () => {
  assert.equal(emulatorForPlatform("ps2"), "pcsx2");
  // One Dolphin, two platforms.
  assert.equal(emulatorForPlatform("ngc"), "dolphin");
  assert.equal(emulatorForPlatform("wii"), "dolphin");
  assert.equal(emulatorForPlatform("NGC"), "dolphin");
  assert.equal(emulatorForPlatform("ps3"), "rpcs3");
  assert.equal(emulatorForPlatform("wiiu"), "cemu");
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

test("the newest of several versioned bundles is the one that launches", () => {
  // Dragging an upgrade into /Applications does not replace a bundle whose name
  // carries a different version, so both survive. Directory order decides
  // nothing, and launching the old one is not harmless: RetroAchievements has
  // minimum emulator versions.
  const readDir = listing({
    "/Applications": [
      "PCSX2-v2.9.0.app",
      "PCSX2-v2.10.0.app",
      "PCSX2-v2.8.2.app",
    ],
  });
  const found = STANDALONE_EMULATORS.find((entry) => entry.id === "pcsx2")!;
  const paths = found.paths("darwin", "/Users/sam", {}, readDir);
  // 2.10 over 2.9: compared as numbers, not as text.
  assert.deepEqual(paths, [
    "/Applications/PCSX2-v2.10.0.app/Contents/MacOS/PCSX2",
    "/Applications/PCSX2-v2.9.0.app/Contents/MacOS/PCSX2",
    "/Applications/PCSX2-v2.8.2.app/Contents/MacOS/PCSX2",
  ]);
});

test("the plain bundle name wins over a versioned one left behind", () => {
  // Dolphin's disk image installs Dolphin.app and updates it in place, so the
  // bare name is the current one -- and someone who renamed a bundle to it has
  // said which they mean.
  const readDir = listing({
    "/Applications": ["Dolphin-5.0.app", "Dolphin.app"],
  });
  const dolphin = STANDALONE_EMULATORS.find((entry) => entry.id === "dolphin")!;
  assert.equal(
    dolphin.paths("darwin", "/Users/sam", {}, readDir)[0],
    "/Applications/Dolphin.app/Contents/MacOS/Dolphin",
  );
});

test("a platform no standalone serves does not touch the filesystem", () => {
  // findMapping asks for every platform in a library. A scan and a dozen stats
  // per SNES game, on the main process, for an answer the table already knows.
  resetStandaloneDetection();
  let looked = 0;
  const count = () => {
    looked += 1;
    return false;
  };
  const scan = () => {
    looked += 1;
    return [];
  };
  for (const slug of ["snes", "n64", "psx", "dreamcast"]) {
    assert.equal(
      detectedMappingFor(slug, "darwin", "/Users/sam", {}, count, scan),
      null,
      slug,
    );
  }
  assert.equal(looked, 0);
  resetStandaloneDetection();
});

test("an application that merely starts with the name is not the emulator", () => {
  // A separator alone is not enough: the suffix has to be a version, or
  // PCSX2-Manager.app gets launched as PCSX2 if it happens to hold a binary of
  // that name -- and it would sort as though it were the bare bundle.
  const readDir = listing({
    "/Applications": [
      "PCSX2-Manager.app",
      "PCSX2 Launcher.app",
      "Dolphin-Beta.app",
    ],
  });
  for (const id of ["pcsx2", "dolphin"]) {
    const emulator = STANDALONE_EMULATORS.find((entry) => entry.id === id)!;
    assert.deepEqual(
      emulator.paths("darwin", "/Users/sam", {}, readDir),
      [],
      id,
    );
  }
});
