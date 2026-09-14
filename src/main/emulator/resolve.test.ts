import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CACHE_LIMIT_BYTES,
  type DesktopConfig,
  LaunchError,
} from "../../shared/types.ts";
import {
  applyCorePreference,
  applyTokens,
  coreFileName,
  emulatorIsPresent,
  emulatorLabel,
  isSafeCoreName,
  requiresCore,
  resolveCore,
  resolveEmulatorCommand,
  resolveLaunch,
} from "./resolve.ts";

function baseConfig(patch: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverUrl: "https://romm.example.com",
    retroarchPath: null,
    retroarchCoresPath: null,
    autoInstallCores: true,
    preferredCores: {},
    emulators: [],
    cachePath: null,
    cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
    trustedCertificates: [],
    ...patch,
  };
}

/** A throwaway tree standing in for a RetroArch install. */
function fakeInstall(cores: string[]) {
  const root = mkdtempSync(join(tmpdir(), "romm-retroarch-"));
  const binary = join(root, "retroarch");
  writeFileSync(binary, "");
  for (const core of cores) writeFileSync(join(root, coreFileName(core)), "");
  return { root, binary };
}

test("isSafeCoreName accepts real core names", () => {
  assert.ok(isSafeCoreName("mupen64plus_next"));
  assert.ok(isSafeCoreName("snes9x"));
});

test("isSafeCoreName rejects anything that could escape the cores directory", () => {
  for (const bad of [
    "../../bin/sh",
    "core/../..",
    "core.so",
    "core name",
    "Core",
    "",
  ]) {
    assert.equal(isSafeCoreName(bad), false, `${bad} must be rejected`);
  }
});

test("applyTokens substitutes without splitting argv entries", () => {
  const args = applyTokens(["-L", "{core}", "{rom}"], {
    rom: "/cache/My Game (USA).zip",
    core: "/cores/snes9x_libretro.so",
    savePaths: null,
  });
  assert.deepEqual(args, [
    "-L",
    "/cores/snes9x_libretro.so",
    "/cache/My Game (USA).zip",
  ]);
});

test("resolveCore skips unsafe and missing cores", () => {
  const { root } = fakeInstall(["mgba"]);
  const core = resolveCore(root, ["../evil", "gambatte", "mgba"]);
  assert.equal(core?.name, "mgba");
});

test("resolveCore returns null when nothing is installed", () => {
  const { root } = fakeInstall([]);
  assert.equal(resolveCore(root, ["snes9x"]), null);
});

test("resolveLaunch builds a RetroArch command from the first installed core", () => {
  const { root, binary } = fakeInstall(["snes9x"]);
  const launch = resolveLaunch({
    config: baseConfig({ retroarchPath: binary, retroarchCoresPath: root }),
    platformSlug: "snes",
    cores: ["snes9x"],
    romPath: "/cache/1-game.sfc",
    savePaths: null,
  });
  assert.equal(launch.command, binary);
  assert.deepEqual(launch.args, [
    "-L",
    join(root, coreFileName("snes9x")),
    "/cache/1-game.sfc",
  ]);
  assert.match(launch.label, /RetroArch/);
});

test("resolveLaunch prefers a per-platform mapping over RetroArch", () => {
  const { root, binary } = fakeInstall(["snes9x"]);
  const standalone = join(root, "dolphin");
  writeFileSync(standalone, "");
  const launch = resolveLaunch({
    config: baseConfig({
      retroarchPath: binary,
      retroarchCoresPath: root,
      emulators: [
        {
          platformSlug: "ngc",
          command: standalone,
          args: ["-e", "{rom}"],
          label: "Dolphin",
        },
      ],
    }),
    platformSlug: "ngc",
    cores: [],
    romPath: "/cache/2-game.iso",
    savePaths: null,
  });
  assert.equal(launch.command, standalone);
  assert.deepEqual(launch.args, ["-e", "/cache/2-game.iso"]);
  assert.equal(launch.label, "Dolphin");
});

test("resolveLaunch falls back to a wildcard mapping", () => {
  const { root } = fakeInstall([]);
  const generic = join(root, "generic");
  writeFileSync(generic, "");
  const launch = resolveLaunch({
    config: baseConfig({
      emulators: [{ platformSlug: "*", command: generic, args: ["{rom}"] }],
    }),
    platformSlug: "anything",
    cores: [],
    romPath: "/cache/3-game.bin",
    savePaths: null,
  });
  assert.equal(launch.command, generic);
});

test("resolveLaunch reports a platform with no known cores", () => {
  const { root, binary } = fakeInstall(["snes9x"]);
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({ retroarchPath: binary, retroarchCoresPath: root }),
        platformSlug: "switch",
        cores: [],
        romPath: "/cache/4-game.xci",
        savePaths: null,
      }),
    { code: "unsupported-platform" },
  );
});

test("resolveLaunch reports cores that are known but not installed", () => {
  const { root, binary } = fakeInstall([]);
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({ retroarchPath: binary, retroarchCoresPath: root }),
        platformSlug: "n64",
        cores: ["mupen64plus_next"],
        romPath: "/cache/5-game.z64",
        savePaths: null,
      }),
    { code: "no-emulator-configured" },
  );
});

test("resolveLaunch reports a configured emulator that has been removed", () => {
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({
          emulators: [
            { platformSlug: "psx", command: "/nope/duckstation", args: [] },
          ],
        }),
        platformSlug: "psx",
        cores: [],
        romPath: "/cache/6-game.chd",
        savePaths: null,
      }),
    { code: "emulator-not-found" },
  );
});

test("resolveLaunch refuses a mapping whose {core} cannot be resolved", () => {
  const { root } = fakeInstall([]);
  const generic = join(root, "generic");
  writeFileSync(generic, "");
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({
          retroarchCoresPath: root,
          emulators: [
            {
              platformSlug: "*",
              command: generic,
              args: ["-L", "{core}", "{rom}"],
            },
          ],
        }),
        platformSlug: "snes",
        cores: ["snes9x"],
        romPath: "/cache/7-game.sfc",
        savePaths: null,
      }),
    // An empty -L argument would fail inside the emulator instead.
    { code: "no-emulator-configured" },
  );
});

test("resolveLaunch still fills {core} for a mapping when one is installed", () => {
  const { root } = fakeInstall(["snes9x"]);
  const generic = join(root, "generic");
  writeFileSync(generic, "");
  const launch = resolveLaunch({
    config: baseConfig({
      retroarchCoresPath: root,
      emulators: [
        {
          platformSlug: "*",
          command: generic,
          args: ["-L", "{core}", "{rom}"],
        },
      ],
    }),
    platformSlug: "snes",
    cores: ["snes9x"],
    romPath: "/cache/8-game.sfc",
    savePaths: null,
  });
  assert.deepEqual(launch.args, [
    "-L",
    join(root, coreFileName("snes9x")),
    "/cache/8-game.sfc",
  ]);
});

test("resolveLaunch leaves a mapping without {core} alone when no core exists", () => {
  const { root } = fakeInstall([]);
  const standalone = join(root, "pcsx2");
  writeFileSync(standalone, "");
  const launch = resolveLaunch({
    config: baseConfig({
      emulators: [
        {
          platformSlug: "ps2",
          command: standalone,
          args: ["-batch", "{rom}"],
        },
      ],
    }),
    platformSlug: "ps2",
    cores: [],
    romPath: "/cache/9-game.iso",
    savePaths: null,
  });
  assert.deepEqual(launch.args, ["-batch", "/cache/9-game.iso"]);
});

test("resolveEmulatorCommand joins a relative command onto the base path", () => {
  assert.equal(
    resolveEmulatorCommand("pcsx2/pcsx2-qt.exe", "E:/RetroBat/emulators"),
    join("E:/RetroBat/emulators", "pcsx2/pcsx2-qt.exe"),
  );
});

test("resolveEmulatorCommand leaves an absolute command alone", () => {
  const absolute = join(tmpdir(), "elsewhere", "duckstation");
  assert.equal(
    resolveEmulatorCommand(absolute, "E:/RetroBat/emulators"),
    absolute,
  );
});

test("resolveEmulatorCommand is a no-op without a base path", () => {
  assert.equal(
    resolveEmulatorCommand("pcsx2/pcsx2-qt.exe", null),
    "pcsx2/pcsx2-qt.exe",
  );
});

test("resolveLaunch runs a mapping named relative to the base path", () => {
  const { root } = fakeInstall([]);
  mkdirSync(join(root, "pcsx2"), { recursive: true });
  const exe = join(root, "pcsx2", "pcsx2-qt.exe");
  writeFileSync(exe, "");

  const launch = resolveLaunch({
    config: baseConfig({
      emulatorsBasePath: root,
      emulators: [
        {
          platformSlug: "ps2",
          label: "PCSX2",
          command: "pcsx2/pcsx2-qt.exe",
          args: ["-batch", "{rom}"],
        },
      ],
    }),
    platformSlug: "ps2",
    cores: [],
    romPath: "/cache/10-game.chd",
    savePaths: null,
  });

  assert.equal(launch.command, exe);
  assert.deepEqual(launch.args, ["-batch", "/cache/10-game.chd"]);
});

test("resolveLaunch reports the resolved path when a relative command is missing", () => {
  const { root } = fakeInstall([]);
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({
          emulatorsBasePath: root,
          emulators: [
            { platformSlug: "ps2", command: "pcsx2/pcsx2-qt.exe", args: [] },
          ],
        }),
        platformSlug: "ps2",
        cores: [],
        romPath: "/cache/11-game.chd",
        savePaths: null,
      }),
    // The message has to name where it actually looked, not what was typed.
    (error: unknown) =>
      error instanceof LaunchError &&
      error.code === "emulator-not-found" &&
      error.message.includes(join(root, "pcsx2", "pcsx2-qt.exe")),
  );
});

/** The sandbox as resolveSavePaths would hand it over, without touching disk. */
function fakeSavePaths(root: string) {
  return {
    saveDir: join(root, "1", "saves"),
    stateDir: join(root, "1", "states"),
    saveFile: join(root, "1", "saves", "game.srm"),
    statePrefix: join(root, "1", "states", "game.state"),
  };
}

test("resolveLaunch points RetroArch at the sandbox when one is configured", () => {
  const { root, binary } = fakeInstall(["snes9x"]);
  const savePaths = fakeSavePaths(join(root, "save-data"));
  const launch = resolveLaunch({
    config: baseConfig({ retroarchPath: binary, retroarchCoresPath: root }),
    platformSlug: "snes",
    cores: ["snes9x"],
    romPath: "/cache/1-game.sfc",
    savePaths,
  });
  assert.deepEqual(launch.args, [
    "-L",
    join(root, coreFileName("snes9x")),
    "-s",
    savePaths.saveFile,
    "-S",
    savePaths.statePrefix,
    "/cache/1-game.sfc",
  ]);
});

test("applyTokens substitutes the save directories and the files in them", () => {
  const savePaths = fakeSavePaths("/save-data");
  const args = applyTokens(
    ["-savedir", "{saves}", "-sram", "{savefile}", "-state", "{statefile}"],
    { rom: "/cache/1-game.sfc", core: null, savePaths },
  );
  assert.deepEqual(args, [
    "-savedir",
    savePaths.saveDir,
    "-sram",
    savePaths.saveFile,
    "-state",
    savePaths.statePrefix,
  ]);
});

test("applyTokens inserts paths literally, not as substitution patterns", () => {
  // $& and $` are replacement patterns to String.replaceAll, so a path
  // containing one would rewrite the argument around it.
  const args = applyTokens(["{rom}", "-L", "{core}"], {
    rom: "/games/Ke$&ha $`quoted`.nes",
    core: "/cores/$'weird.so",
    savePaths: null,
  });
  assert.deepEqual(args, [
    "/games/Ke$&ha $`quoted`.nes",
    "-L",
    "/cores/$'weird.so",
  ]);
});

test("applyTokens leaves token-looking text inside a path alone", () => {
  // A save root containing "{states}" was inserted by the {saves} pass and
  // then rewritten by the {states} pass that followed it.
  const savePaths = {
    saveDir: "/data/{states}/7/saves",
    stateDir: "/data/{states}/7/states",
    saveFile: "/data/{states}/7/saves/game.srm",
    statePrefix: "/data/{states}/7/states/game.state",
  };
  const args = applyTokens(["-savedir", "{saves}", "-statedir", "{states}"], {
    rom: "/cache/7/game.sfc",
    core: null,
    savePaths,
  });
  assert.deepEqual(args, [
    "-savedir",
    savePaths.saveDir,
    "-statedir",
    savePaths.stateDir,
  ]);
});

test("applyTokens leaves an unknown token untouched", () => {
  const args = applyTokens(["{nonsense}", "{rom}"], {
    rom: "/cache/7/game.sfc",
    core: null,
    savePaths: null,
  });
  assert.deepEqual(args, ["{nonsense}", "/cache/7/game.sfc"]);
});

test("resolveLaunch fills {saves} and {states} for a mapping", () => {
  const { root } = fakeInstall([]);
  const standalone = join(root, "pcsx2");
  writeFileSync(standalone, "");
  const savePaths = fakeSavePaths(join(root, "save-data"));
  const launch = resolveLaunch({
    config: baseConfig({
      emulators: [
        {
          platformSlug: "ps2",
          command: standalone,
          args: ["-memcard", "{saves}", "-statedir", "{states}", "{rom}"],
        },
      ],
    }),
    platformSlug: "ps2",
    cores: [],
    romPath: "/cache/12-game.chd",
    savePaths,
  });
  assert.deepEqual(launch.args, [
    "-memcard",
    savePaths.saveDir,
    "-statedir",
    savePaths.stateDir,
    "/cache/12-game.chd",
  ]);
});

test("resolveLaunch refuses a mapping naming {saves} with no saveDataPath", () => {
  const { root } = fakeInstall([]);
  const standalone = join(root, "pcsx2");
  writeFileSync(standalone, "");
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({
          emulators: [
            {
              platformSlug: "ps2",
              command: standalone,
              args: ["-memcard", "{saves}", "{rom}"],
            },
          ],
        }),
        platformSlug: "ps2",
        cores: [],
        romPath: "/cache/13-game.chd",
        savePaths: null,
      }),
    // An empty -memcard argument would fail inside the emulator instead.
    (error: unknown) =>
      error instanceof LaunchError &&
      error.code === "no-emulator-configured" &&
      error.message.includes("saveDataPath"),
  );
});

test("requiresCore is true for the RetroArch default path", () => {
  assert.ok(requiresCore(baseConfig(), "snes"));
});

test("requiresCore is false for a standalone emulator", () => {
  // The platform may still have candidate cores; this mapping never loads one.
  const config = baseConfig({
    emulators: [
      { platformSlug: "ps2", command: "/usr/bin/pcsx2", args: ["{rom}"] },
    ],
  });
  assert.equal(requiresCore(config, "ps2"), false);
});

test("requiresCore follows the wildcard row for an unmapped platform", () => {
  const config = baseConfig({
    emulators: [
      { platformSlug: "*", command: "/usr/bin/flatpak", args: ["{rom}"] },
    ],
  });
  assert.equal(requiresCore(config, "snes"), false);
});

test("requiresCore is true for a mapping that names {core}", () => {
  const config = baseConfig({
    emulators: [
      {
        platformSlug: "*",
        command: "/usr/bin/flatpak",
        args: ["-L", "{core}", "{rom}"],
      },
    ],
  });
  assert.ok(requiresCore(config, "snes"));
});

test("emulatorIsPresent sees a RetroArch that exists", () => {
  const { binary } = fakeInstall([]);
  assert.ok(emulatorIsPresent(baseConfig({ retroarchPath: binary }), "snes"));
  assert.equal(emulatorIsPresent(baseConfig(), "snes"), false);
  assert.equal(
    emulatorIsPresent(baseConfig({ retroarchPath: "/nope/retroarch" }), "snes"),
    false,
  );
});

test("emulatorIsPresent resolves a mapping against the base path", () => {
  const { root } = fakeInstall([]);
  writeFileSync(join(root, "pcsx2"), "");
  const config = baseConfig({
    emulatorsBasePath: root,
    emulators: [
      { platformSlug: "ps2", command: "pcsx2", args: ["{rom}"] },
      { platformSlug: "ps3", command: "rpcs3", args: ["{rom}"] },
    ],
  });
  assert.ok(emulatorIsPresent(config, "ps2"));
  assert.equal(emulatorIsPresent(config, "ps3"), false);
});

test("emulatorLabel names the mapping, or RetroArch when there is none", () => {
  assert.equal(emulatorLabel(baseConfig(), "snes"), "RetroArch");
  const config = baseConfig({
    emulators: [
      {
        platformSlug: "ps2",
        label: "PCSX2",
        command: "/usr/bin/pcsx2",
        args: ["{rom}"],
      },
      { platformSlug: "ps3", command: "/usr/bin/rpcs3", args: ["{rom}"] },
    ],
  });
  assert.equal(emulatorLabel(config, "ps2"), "PCSX2");
  // No label, so the command stands in, the same way resolveLaunch reports it.
  assert.equal(emulatorLabel(config, "ps3"), "/usr/bin/rpcs3");
});

test("assumeMissingCoreInstalled resolves a core that is not there yet", () => {
  const { root, binary } = fakeInstall([]);
  const launch = resolveLaunch({
    config: baseConfig({ retroarchPath: binary, retroarchCoresPath: root }),
    platformSlug: "snes",
    cores: ["snes9x"],
    romPath: "/cache/1-game.sfc",
    savePaths: null,
    assumeMissingCoreInstalled: true,
  });
  // The stand-in is the path the install will write to, so what gets validated
  // is the shape of the real launch.
  assert.equal(launch.label, "RetroArch (snes9x)");
  assert.ok(launch.args.includes(join(root, coreFileName("snes9x"))));
});

test("assuming a core does not paper over any other failure", () => {
  // The whole point of validating with the core assumed present: everything
  // else still has to hold, or a launch would download a core and then fail.
  const { root } = fakeInstall([]);
  const standalone = join(root, "flatpak");
  writeFileSync(standalone, "");

  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({
          retroarchCoresPath: root,
          emulators: [
            {
              platformSlug: "*",
              command: standalone,
              args: ["-L", "{core}", "-s", "{savefile}", "{rom}"],
            },
          ],
        }),
        platformSlug: "snes",
        cores: ["snes9x"],
        romPath: "/cache/1-game.sfc",
        savePaths: null,
        assumeMissingCoreInstalled: true,
      }),
    // The missing saveDataPath, not the missing core.
    (error: unknown) =>
      error instanceof LaunchError && error.message.includes("saveDataPath"),
  );

  // A missing emulator is likewise not something a core download can fix.
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({ retroarchCoresPath: root }),
        platformSlug: "snes",
        cores: ["snes9x"],
        romPath: "/cache/1-game.sfc",
        savePaths: null,
        assumeMissingCoreInstalled: true,
      }),
    LaunchError,
  );
});

test("assumeMissingCoreInstalled still needs a name that could be fetched", () => {
  const { root, binary } = fakeInstall([]);
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({ retroarchPath: binary, retroarchCoresPath: root }),
        platformSlug: "snes",
        cores: ["../evil"],
        romPath: "/cache/1-game.sfc",
        savePaths: null,
        assumeMissingCoreInstalled: true,
      }),
    LaunchError,
  );
});

test("without the option a missing core still fails", () => {
  const { root, binary } = fakeInstall([]);
  assert.throws(
    () =>
      resolveLaunch({
        config: baseConfig({ retroarchPath: binary, retroarchCoresPath: root }),
        platformSlug: "snes",
        cores: ["snes9x"],
        romPath: "/cache/1-game.sfc",
        savePaths: null,
      }),
    /None of the cores/,
  );
});

test("preferred cores go in front of the frontend's", () => {
  const config = baseConfig({
    preferredCores: { psx: ["swanstation", "mednafen_psx_hw"] },
  });
  assert.deepEqual(
    applyCorePreference(config, "psx", ["pcsx_rearmed", "mednafen_psx_hw"]),
    // The preference leads; what the frontend offered and the preference did
    // not name still follows, so nothing is narrowed away.
    ["swanstation", "mednafen_psx_hw", "pcsx_rearmed"],
  );
});

test("a preferred core the frontend never offered is still honoured", () => {
  // The whole point: RomM's map cannot know which core RetroAchievements
  // recognises, so naming one it does not list has to reach it.
  const config = baseConfig({ preferredCores: { "3ds": ["azahar"] } });
  assert.deepEqual(applyCorePreference(config, "3ds", []), ["azahar"]);
});

test("platform slugs match without regard to case", () => {
  const config = baseConfig({ preferredCores: { PSX: ["swanstation"] } });
  assert.deepEqual(applyCorePreference(config, "psx", ["pcsx_rearmed"]), [
    "swanstation",
    "pcsx_rearmed",
  ]);
});

test("a platform with no preference is left exactly as it came", () => {
  const config = baseConfig({ preferredCores: { psx: ["swanstation"] } });
  const cores = ["snes9x", "bsnes"];
  assert.deepEqual(applyCorePreference(config, "snes", cores), cores);
  assert.deepEqual(applyCorePreference(baseConfig(), "snes", cores), cores);
});

test("a preferred core is not repeated when the frontend named it too", () => {
  const config = baseConfig({ preferredCores: { snes: ["snes9x"] } });
  assert.deepEqual(applyCorePreference(config, "snes", ["snes9x", "bsnes"]), [
    "snes9x",
    "bsnes",
  ]);
});

test("a preference that cannot be a filename is dropped, not obeyed", () => {
  // These names reach a filesystem path and a buildbot URL, so the config is no
  // more trusted here than the renderer is.
  const config = baseConfig({
    preferredCores: { snes: ["../../evil", "Snes9x", "snes9x"] },
  });
  assert.deepEqual(applyCorePreference(config, "snes", ["bsnes"]), [
    "snes9x",
    "bsnes",
  ]);
});

test("a malformed preferredCores table is ignored rather than fatal", () => {
  // Hand-edited JSON, so every wrong shape has to fall through to the
  // frontend's list instead of throwing mid-launch.
  const cores = ["snes9x"];
  for (const table of [
    null,
    undefined,
    "snes9x",
    42,
    { snes: "snes9x" },
    { snes: null },
    { snes: [1, 2, 3] },
  ]) {
    const config = baseConfig({
      preferredCores: table as DesktopConfig["preferredCores"],
    });
    assert.deepEqual(
      applyCorePreference(config, "snes", cores),
      cores,
      `${table}`,
    );
  }
});
