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
  applyTokens,
  coreFileName,
  isSafeCoreName,
  resolveCore,
  resolveEmulatorCommand,
  resolveLaunch,
} from "./resolve.ts";

function baseConfig(patch: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverUrl: "https://romm.example.com",
    retroarchPath: null,
    retroarchCoresPath: null,
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
      }),
    // The message has to name where it actually looked, not what was typed.
    (error: unknown) =>
      error instanceof LaunchError &&
      error.code === "emulator-not-found" &&
      error.message.includes(join(root, "pcsx2", "pcsx2-qt.exe")),
  );
});
