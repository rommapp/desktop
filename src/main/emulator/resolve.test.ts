import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DesktopConfig, LaunchError } from "../../shared/types.ts";
import { testConfig } from "../../test/config.ts";
import { STANDALONE_EMULATORS, toEmulatorMappings } from "./standalone.ts";
import {
  findPreferredCores,
  applyCorePreference,
  applyTokens,
  coreFileName,
  emulatorIsPresent,
  emulatorLabel,
  emulatorReadsPlaylist,
  emulatorUsesSaveFile,
  emulatorUsesStateDir,
  hasPlatformSpecificEmulator,
  isSafeCoreName,
  requiresCore,
  resolveCore,
  resolveEmulatorCommand,
  resolveLaunch,
  usesBuiltInRetroArch,
} from "./resolve.ts";

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
    config: testConfig({ retroarchPath: binary, retroarchCoresPath: root }),
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
    config: testConfig({
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
    config: testConfig({
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
        config: testConfig({ retroarchPath: binary, retroarchCoresPath: root }),
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
        config: testConfig({ retroarchPath: binary, retroarchCoresPath: root }),
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
        config: testConfig({
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
        config: testConfig({
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
    config: testConfig({
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
    config: testConfig({
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
    config: testConfig({
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
        config: testConfig({
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
    config: testConfig({ retroarchPath: binary, retroarchCoresPath: root }),
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

test("{biosconfig} is empty until the mirror has written one", () => {
  // Nothing is generated when the mirror is off, and a row that still names the
  // token gets an empty string rather than a path to a file that is not there.
  const args = applyTokens(["--appendconfig={biosconfig}"], {
    rom: "/cache/1/game.chd",
    core: null,
    savePaths: null,
    biosPaths: {
      directory: "/data/bios/psx",
      appendConfig: join(mkdtempSync(join(tmpdir(), "romm-bios-")), "gone.cfg"),
    },
  });
  assert.deepEqual(args, ["--appendconfig="]);
});

test("applyTokens substitutes the firmware directory", () => {
  const args = applyTokens(["-bios", "{bios}", "{rom}"], {
    rom: "/cache/1/game.chd",
    core: null,
    savePaths: null,
    biosPaths: {
      directory: "/data/bios/psx",
      appendConfig: "/data/bios/.retroarch/psx.cfg",
    },
  });
  assert.deepEqual(args, ["-bios", "/data/bios/psx", "/cache/1/game.chd"]);
});

test("a row naming {bios} with the mirror switched off gets an empty string", () => {
  // Not a launch failure, unlike {core} and {saves}: an emulator pointed at an
  // empty argument for a BIOS directory is the same as one pointed nowhere,
  // and most platforms need no firmware at all.
  const args = applyTokens(["-bios", "{bios}"], {
    rom: "/cache/1/game.chd",
    core: null,
    savePaths: null,
    biosPaths: null,
  });
  assert.deepEqual(args, ["-bios", ""]);
});

test("a RetroArch launch is pointed at the firmware only once there is some", () => {
  // The generated config's presence on disk is the whole protocol: the sync
  // writes it when the mirror has files and deletes it when the mirror empties,
  // so one stat answers the question without asking the server.
  const install = fakeInstall(["snes9x"]);
  const biosRoot = mkdtempSync(join(tmpdir(), "romm-bios-"));
  const config = testConfig({
    retroarchPath: install.binary,
    retroarchCoresPath: install.root,
    biosPath: biosRoot,
  });
  const launch = () =>
    resolveLaunch({
      config,
      platformSlug: "snes",
      cores: ["snes9x"],
      romPath: "/cache/1/game.sfc",
      savePaths: null,
    });

  // Nothing synced yet, so nothing is appended and the launch is what it was.
  assert.deepEqual(launch().args, [
    "-L",
    join(install.root, coreFileName("snes9x")),
    "/cache/1/game.sfc",
  ]);

  const generated = join(biosRoot, ".retroarch", "snes.cfg");
  mkdirSync(join(biosRoot, ".retroarch"), { recursive: true });
  writeFileSync(generated, 'system_directory = "x"');
  const args = launch().args;
  // First, because --appendconfig is read as RetroArch starts up.
  assert.equal(args[0], `--appendconfig=${generated}`);
  assert.deepEqual(args.slice(1), [
    "-L",
    join(install.root, coreFileName("snes9x")),
    "/cache/1/game.sfc",
  ]);
});

test("a RetroArch launch appends the launch config beside the firmware one", () => {
  // RetroArch takes a "|"-delimited list, so the save interval this launch asks
  // for does not displace the firmware directory it also needs.
  const install = fakeInstall(["mgba"]);
  const biosRoot = mkdtempSync(join(tmpdir(), "romm-bios-"));
  const generated = join(biosRoot, ".retroarch", "gba.cfg");
  mkdirSync(join(biosRoot, ".retroarch"), { recursive: true });
  writeFileSync(generated, 'system_directory = "x"');
  const config = testConfig({
    retroarchPath: install.binary,
    retroarchCoresPath: install.root,
    biosPath: biosRoot,
  });

  const withBoth = resolveLaunch({
    config,
    platformSlug: "gba",
    cores: ["mgba"],
    romPath: "/cache/1/game.gba",
    savePaths: null,
    launchConfig: "/save-data/.retroarch/autosave.cfg",
  });
  assert.equal(
    withBoth.args[0],
    `--appendconfig=${generated}|/save-data/.retroarch/autosave.cfg`,
  );

  // And on its own, for a platform whose firmware the mirror has nothing for.
  const withoutFirmware = resolveLaunch({
    config: testConfig({
      retroarchPath: install.binary,
      retroarchCoresPath: install.root,
    }),
    platformSlug: "gba",
    cores: ["mgba"],
    romPath: "/cache/1/game.gba",
    savePaths: null,
    launchConfig: "/save-data/.retroarch/autosave.cfg",
  });
  assert.equal(
    withoutFirmware.args[0],
    "--appendconfig=/save-data/.retroarch/autosave.cfg",
  );
});

test("only the built-in path is the one the shell writes arguments for", () => {
  // What gates generating a config: a mapping never names one, so writing it
  // would leave a stray file no launch reads.
  const install = fakeInstall([]);
  const mapped = testConfig({
    emulators: [
      {
        platformSlug: "ps2",
        command: install.binary,
        args: ["-batch", "{rom}"],
      },
    ],
  });
  assert.equal(usesBuiltInRetroArch(mapped, "ps2"), false);
  assert.equal(usesBuiltInRetroArch(mapped, "gba"), true);

  // A wildcard row covers every platform, so none of them is the built-in path.
  const wildcard = testConfig({
    emulators: [
      { platformSlug: "*", command: install.binary, args: ["{rom}"] },
    ],
  });
  assert.equal(usesBuiltInRetroArch(wildcard, "gba"), false);
});

test("a launch that asks for fullscreen gets RetroArch's own flag", () => {
  const install = fakeInstall(["mgba"]);
  const config = testConfig({
    retroarchPath: install.binary,
    retroarchCoresPath: install.root,
  });
  const launch = (fullscreen: boolean) =>
    resolveLaunch({
      config,
      platformSlug: "gba",
      cores: ["mgba"],
      romPath: "/cache/1/game.gba",
      savePaths: null,
      fullscreen,
    }).args;

  // Before the content, like every other flag, and nothing at all when the
  // launch did not ask: there is no "windowed" flag to undo the user's setting.
  assert.deepEqual(launch(true), [
    "-L",
    join(install.root, coreFileName("mgba")),
    "-f",
    "/cache/1/game.gba",
  ]);
  assert.ok(!launch(false).includes("-f"));
});

test("asking to read the emulator's output asks RetroArch to produce some", () => {
  // RetroArch names the save file it resolved and whether it wrote one at this
  // level, which is the account no amount of watching a file produces.
  const install = fakeInstall(["mgba"]);
  const args = (logEmulatorOutput: boolean) =>
    resolveLaunch({
      config: testConfig({
        retroarchPath: install.binary,
        retroarchCoresPath: install.root,
        logEmulatorOutput,
      }),
      platformSlug: "gba",
      cores: ["mgba"],
      romPath: "/cache/1/game.gba",
      savePaths: null,
    }).args;

  assert.ok(args(true).includes("--verbose"));
  assert.ok(!args(false).includes("--verbose"));
  // Before the content, like every other flag.
  assert.ok(
    args(true).indexOf("--verbose") < args(true).indexOf("/cache/1/game.gba"),
  );
});

test("a standalone mapping is never handed a fullscreen flag", () => {
  // It is RetroArch's. A mapping's arguments are the user's, and its emulator's
  // own flag is whatever that emulator calls it.
  const install = fakeInstall([]);
  const config = testConfig({
    emulators: [
      {
        platformSlug: "ps2",
        command: install.binary,
        args: ["-batch", "{rom}"],
      },
    ],
  });
  const launch = resolveLaunch({
    config,
    platformSlug: "ps2",
    cores: [],
    romPath: "/cache/1/game.chd",
    savePaths: null,
    fullscreen: true,
  });
  assert.deepEqual(launch.args, ["-batch", "/cache/1/game.chd"]);
});

test("a RetroArch mapping can ask for the system directory itself", () => {
  // The automatic flag is only for the built-in RetroArch path, since a
  // mapping's arguments are the user's and "flatpak run org.libretro.RetroArch"
  // is not something the shell can recognise as RetroArch. So a row says where
  // it wants the generated config, which is the case the README's own Flatpak
  // wildcard row needs.
  const install = fakeInstall(["mednafen_psx_hw"]);
  const biosRoot = mkdtempSync(join(tmpdir(), "romm-bios-"));
  const generated = join(biosRoot, ".retroarch", "psx.cfg");
  mkdirSync(join(biosRoot, ".retroarch"), { recursive: true });
  writeFileSync(generated, 'system_directory = "x"');
  const config = testConfig({
    retroarchCoresPath: install.root,
    biosPath: biosRoot,
    emulators: [
      {
        platformSlug: "*",
        label: "RetroArch (Flatpak)",
        command: install.binary,
        args: [
          "run",
          "org.libretro.RetroArch",
          "--appendconfig={biosconfig}",
          "-L",
          "{core}",
          "{rom}",
        ],
      },
    ],
  });
  const launch = resolveLaunch({
    config,
    platformSlug: "psx",
    cores: ["mednafen_psx_hw"],
    romPath: "/cache/1/game.chd",
    savePaths: null,
  });
  assert.deepEqual(launch.args, [
    "run",
    "org.libretro.RetroArch",
    `--appendconfig=${generated}`,
    "-L",
    join(install.root, coreFileName("mednafen_psx_hw")),
    "/cache/1/game.chd",
  ]);
});

test("a standalone mapping is never handed --appendconfig", () => {
  // It is a RetroArch flag. A mapping that wants the directory says {bios}.
  const install = fakeInstall([]);
  const biosRoot = mkdtempSync(join(tmpdir(), "romm-bios-"));
  mkdirSync(join(biosRoot, ".retroarch"), { recursive: true });
  writeFileSync(join(biosRoot, ".retroarch", "ps2.cfg"), "");
  const config = testConfig({
    biosPath: biosRoot,
    emulators: [
      {
        platformSlug: "ps2",
        command: install.binary,
        args: ["-batch", "{rom}"],
      },
    ],
  });
  const launch = resolveLaunch({
    config,
    platformSlug: "ps2",
    cores: [],
    romPath: "/cache/1/game.chd",
    savePaths: null,
  });
  assert.deepEqual(launch.args, ["-batch", "/cache/1/game.chd"]);
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
    config: testConfig({
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
        config: testConfig({
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
  assert.ok(requiresCore(testConfig(), "snes"));
});

test("requiresCore is false for a standalone emulator", () => {
  // The platform may still have candidate cores; this mapping never loads one.
  const config = testConfig({
    emulators: [
      { platformSlug: "ps2", command: "/usr/bin/pcsx2", args: ["{rom}"] },
    ],
  });
  assert.equal(requiresCore(config, "ps2"), false);
});

test("requiresCore follows the wildcard row for an unmapped platform", () => {
  const config = testConfig({
    emulators: [
      { platformSlug: "*", command: "/usr/bin/flatpak", args: ["{rom}"] },
    ],
  });
  assert.equal(requiresCore(config, "snes"), false);
});

test("requiresCore is true for a mapping that names {core}", () => {
  const config = testConfig({
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
  assert.ok(emulatorIsPresent(testConfig({ retroarchPath: binary }), "snes"));
  assert.equal(emulatorIsPresent(testConfig(), "snes"), false);
  assert.equal(
    emulatorIsPresent(testConfig({ retroarchPath: "/nope/retroarch" }), "snes"),
    false,
  );
});

test("emulatorIsPresent resolves a mapping against the base path", () => {
  const { root } = fakeInstall([]);
  writeFileSync(join(root, "pcsx2"), "");
  const config = testConfig({
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
  assert.equal(emulatorLabel(testConfig(), "snes"), "RetroArch");
  const config = testConfig({
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

test("emulatorReadsPlaylist answers for the emulator a platform would use", () => {
  // No mapping at all: the built-in RetroArch path, which boots an .m3u.
  assert.ok(emulatorReadsPlaylist(testConfig(), "psx"));

  const config = testConfig({
    emulators: [
      // RetroArch under another name. Nothing says so, but a mapping loading a
      // libretro core is RetroArch driving one.
      {
        platformSlug: "pcecd",
        command: "flatpak",
        args: ["run", "org.libretro.RetroArch", "-L", "{core}", "{rom}"],
      },
      // A standalone emulator, which is assumed not to read one.
      { platformSlug: "ps2", command: "/usr/bin/pcsx2-qt", args: ["{rom}"] },
      // Recognised by name, which is how a hand-configured DuckStation keeps
      // disc switching on the platform that needs it most.
      {
        platformSlug: "psx",
        command: "/usr/bin/duckstation-qt",
        args: ["-batch", "{rom}"],
      },
      // One nothing recognises, which says so itself.
      {
        platformSlug: "ngc",
        command: "/opt/some-emu",
        args: ["{rom}"],
        playlist: true,
      },
      // A declaration outranks the inference, in both directions.
      {
        platformSlug: "saturn",
        command: "/opt/thing",
        args: ["-L", "{core}", "{rom}"],
        playlist: false,
      },
    ],
  });
  assert.ok(emulatorReadsPlaylist(config, "pcecd"));
  assert.equal(emulatorReadsPlaylist(config, "ps2"), false);
  assert.ok(emulatorReadsPlaylist(config, "psx"));
  assert.ok(emulatorReadsPlaylist(config, "ngc"));
  assert.equal(emulatorReadsPlaylist(config, "saturn"), false);
});

test("a playlist-reading emulator is recognised behind flatpak", () => {
  // The command is the sandbox, so the emulator is only named in the arguments.
  const config = testConfig({
    emulators: [
      {
        platformSlug: "psx",
        command: "/usr/bin/flatpak",
        args: ["run", "org.duckstation.DuckStation", "-batch", "{rom}"],
      },
    ],
  });
  assert.ok(emulatorReadsPlaylist(config, "psx"));
});

test("a detected emulator carries its own playlist answer", () => {
  const detected = toEmulatorMappings(
    STANDALONE_EMULATORS.filter((entry) =>
      ["pcsx2", "dolphin"].includes(entry.id),
    ).map((emulator) => ({ emulator, command: `/usr/bin/${emulator.id}` })),
  );
  const config = testConfig({ emulators: detected });
  assert.equal(emulatorReadsPlaylist(config, "ps2"), false);
  assert.ok(emulatorReadsPlaylist(config, "ngc"));
});

test("assumeMissingCoreInstalled resolves a core that is not there yet", () => {
  const { root, binary } = fakeInstall([]);
  const launch = resolveLaunch({
    config: testConfig({ retroarchPath: binary, retroarchCoresPath: root }),
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
        config: testConfig({
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
        config: testConfig({ retroarchCoresPath: root }),
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
        config: testConfig({ retroarchPath: binary, retroarchCoresPath: root }),
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
        config: testConfig({ retroarchPath: binary, retroarchCoresPath: root }),
        platformSlug: "snes",
        cores: ["snes9x"],
        romPath: "/cache/1-game.sfc",
        savePaths: null,
      }),
    /None of the cores/,
  );
});

test("preferred cores go in front of the frontend's", () => {
  const config = testConfig({
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
  const config = testConfig({ preferredCores: { "3ds": ["azahar"] } });
  assert.deepEqual(applyCorePreference(config, "3ds", []), ["azahar"]);
});

test("platform slugs match without regard to case", () => {
  const config = testConfig({ preferredCores: { PSX: ["swanstation"] } });
  assert.deepEqual(applyCorePreference(config, "psx", ["pcsx_rearmed"]), [
    "swanstation",
    "pcsx_rearmed",
  ]);
});

test("a platform with no preference is left exactly as it came", () => {
  const config = testConfig({ preferredCores: { psx: ["swanstation"] } });
  const cores = ["snes9x", "bsnes"];
  assert.deepEqual(applyCorePreference(config, "snes", cores), cores);
  assert.deepEqual(applyCorePreference(testConfig(), "snes", cores), cores);
});

test("a preferred core is not repeated when the frontend named it too", () => {
  const config = testConfig({ preferredCores: { snes: ["snes9x"] } });
  assert.deepEqual(applyCorePreference(config, "snes", ["snes9x", "bsnes"]), [
    "snes9x",
    "bsnes",
  ]);
});

test("a preference that cannot be a filename is dropped, not obeyed", () => {
  // These names reach a filesystem path and a buildbot URL, so the config is no
  // more trusted here than the renderer is.
  const config = testConfig({
    preferredCores: { snes: ["../../evil", "Snes9x", "snes9x"] },
  });
  assert.deepEqual(applyCorePreference(config, "snes", ["bsnes"]), [
    "snes9x",
    "bsnes",
  ]);
});

test("the preference list itself is de-duplicated for its other readers", () => {
  // applyCorePreference is not the only caller any more: the install plan reads
  // findPreferredCores directly, and a name repeated by hand there becomes the
  // same download attempted twice.
  const config = testConfig({
    preferredCores: { psx: ["mednafen_psx_hw", "mednafen_psx_hw"] },
  });
  assert.deepEqual(findPreferredCores(config, "psx"), ["mednafen_psx_hw"]);
});

test("a core named twice is tried once", () => {
  // A hand-edited list can repeat itself, and every entry becomes a download
  // attempt when the core is missing.
  const config = testConfig({
    preferredCores: { snes: ["snes9x", "snes9x", "bsnes"] },
  });
  assert.deepEqual(applyCorePreference(config, "snes", ["snes9x"]), [
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
    const config = testConfig({
      // Deliberately wrong shapes, so the cast goes via unknown: the point is
      // what happens when the JSON on disk does not match the type.
      preferredCores: table as unknown as DesktopConfig["preferredCores"],
    });
    assert.deepEqual(
      applyCorePreference(config, "snes", cores),
      cores,
      `${table}`,
    );
  }
});

test("RetroArch being installed does not count as a PS2 emulator", () => {
  // The bug this guards: emulatorIsPresent answers "would a launch find an
  // executable", which is true for every platform once RetroArch exists. Asking
  // that before offering PCSX2 would mean never offering it, since RetroArch is
  // the normal case and a libretro core earns no achievements on PS2.
  const { binary, root } = fakeInstall(["snes9x"]);
  const config = testConfig({
    retroarchPath: binary,
    retroarchCoresPath: root,
    useDetectedEmulators: false,
  });
  assert.ok(emulatorIsPresent(config, "ps2"));
  assert.equal(hasPlatformSpecificEmulator(config, "ps2"), false);
});

test("an explicit row for the platform does count", () => {
  const { root } = fakeInstall([]);
  const standalone = join(root, "pcsx2");
  writeFileSync(standalone, "");
  const config = testConfig({
    emulators: [{ platformSlug: "PS2", command: standalone, args: ["{rom}"] }],
    useDetectedEmulators: false,
  });
  // Matched without regard to case, like every other slug lookup.
  assert.ok(hasPlatformSpecificEmulator(config, "ps2"));
  assert.equal(hasPlatformSpecificEmulator(config, "ngc"), false);
});

test("a wildcard row is not a considered choice for this platform", () => {
  // It is a catch-all for platforms with nothing better, which is the same
  // reason detection outranks it in findMapping.
  const { root } = fakeInstall([]);
  const generic = join(root, "generic");
  writeFileSync(generic, "");
  const config = testConfig({
    emulators: [{ platformSlug: "*", command: generic, args: ["{rom}"] }],
    useDetectedEmulators: false,
  });
  assert.equal(hasPlatformSpecificEmulator(config, "ps2"), false);
});

test("emulatorUsesSaveFile answers for the emulator a platform would use", () => {
  // No mapping at all: the built-in RetroArch path, whose arguments the shell
  // writes and which passes -s with the exact file.
  assert.ok(emulatorUsesSaveFile(testConfig(), "psx"));

  const config = testConfig({
    emulators: [
      // The exact form, and the one to prefer.
      {
        platformSlug: "snes",
        command: "/usr/bin/retroarch",
        args: ["-L", "{core}", "-s", "{savefile}", "{rom}"],
      },
      // The directory form, which does not count: the emulator names the save
      // after the content, and that is precisely what differs between a cached
      // launch and an in-library one.
      {
        platformSlug: "gba",
        command: "/usr/bin/mgba",
        args: ["--savedir", "{saves}", "{rom}"],
      },
      // Naming only the state tokens is not consuming the save file, though
      // it is what emulatorUsesStateDir is looking for.
      {
        platformSlug: "n64",
        command: "/usr/bin/mupen64plus",
        args: ["--statedir", "{states}", "{statefile}", "{rom}"],
      },
      // The documented minimal mapping: no save token at all. This emulator
      // keeps its saves wherever it puts them by default.
      {
        platformSlug: "ps2",
        command: "/usr/bin/pcsx2-qt",
        args: ["-batch", "{rom}"],
      },
    ],
  });

  assert.ok(emulatorUsesSaveFile(config, "snes"));
  assert.equal(emulatorUsesSaveFile(config, "gba"), false);
  assert.equal(emulatorUsesSaveFile(config, "n64"), false);
  assert.equal(emulatorUsesSaveFile(config, "ps2"), false);
});

test("emulatorUsesStateDir answers for where the states will land", () => {
  // No mapping: the built-in RetroArch path, whose generated config pins
  // savestate_directory and turns RetroArch's own sorting off.
  assert.ok(emulatorUsesStateDir(testConfig(), "psx"));

  const config = testConfig({
    emulators: [
      // The directory is enough, unlike the save file: the mirror only reads
      // it, and it belongs to this ROM alone.
      {
        platformSlug: "n64",
        command: "/usr/bin/mupen64plus",
        args: ["--statedir", "{states}", "{rom}"],
      },
      // Naming the file pins it just as well.
      {
        platformSlug: "snes",
        command: "/usr/bin/retroarch",
        args: ["-L", "{core}", "-S", "{statefile}", "{rom}"],
      },
      // Saves pinned, states left wherever the emulator puts them: there is
      // nothing of this game's states to find, so nothing to mirror.
      {
        platformSlug: "gba",
        command: "/usr/bin/mgba",
        args: ["-s", "{savefile}", "{rom}"],
      },
    ],
  });

  assert.ok(emulatorUsesStateDir(config, "n64"));
  assert.ok(emulatorUsesStateDir(config, "snes"));
  assert.equal(emulatorUsesStateDir(config, "gba"), false);
});
