import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CACHE_LIMIT_BYTES,
  type DesktopConfig,
} from "../../shared/types.ts";
import {
  buildbotPlatformDir,
  buildbotSupportsThisMachine,
  canInstallCore,
  coreDownloadUrl,
  firstInstallableCore,
} from "./buildbot.ts";
import { coreFileName } from "./resolve.ts";

function baseConfig(patch: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverUrl: "https://romm.example.com",
    retroarchPath: null,
    retroarchCoresPath: null,
    autoInstallCores: true,
    emulatorsBasePath: null,
    emulators: [],
    cachePath: null,
    saveDataPath: null,
    libraryPath: null,
    cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
    fullscreen: false,
    trustedCertificates: [],
    ...patch,
  };
}

/** A cores directory holding the named cores and nothing else. */
function fakeCores(cores: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "romm-cores-"));
  for (const core of cores) writeFileSync(join(root, coreFileName(core)), "");
  return root;
}

test("maps each machine to the buildbot's own directory names", () => {
  // Checked against the buildbot's published layout: x64 is "x86_64" there, and
  // macOS lives under apple/osx rather than darwin.
  assert.equal(buildbotPlatformDir("linux", "x64"), "linux/x86_64");
  assert.equal(buildbotPlatformDir("linux", "arm64"), "linux/aarch64");
  assert.equal(buildbotPlatformDir("linux", "arm"), "linux/armhf");
  assert.equal(buildbotPlatformDir("win32", "x64"), "windows/x86_64");
  assert.equal(buildbotPlatformDir("win32", "ia32"), "windows/x86");
  assert.equal(buildbotPlatformDir("darwin", "arm64"), "apple/osx/arm64");
  assert.equal(buildbotPlatformDir("darwin", "x64"), "apple/osx/x86_64");
});

test("Windows on ARM is served the x64 cores it emulates", () => {
  // The buildbot publishes no windows/arm64, and the core has to match the
  // emulator rather than this shell.
  assert.equal(buildbotPlatformDir("win32", "arm64"), "windows/x86_64");
});

test("a machine the buildbot does not publish for has no directory", () => {
  assert.equal(buildbotPlatformDir("darwin", "ppc64"), null);
  assert.equal(buildbotPlatformDir("linux", "s390x"), null);
  assert.equal(buildbotPlatformDir("freebsd", "x64"), null);
  assert.equal(buildbotSupportsThisMachine("freebsd", "x64"), false);
  assert.equal(buildbotSupportsThisMachine("linux", "x64"), true);
});

test("builds the download URL for a core", () => {
  assert.equal(
    coreDownloadUrl("snes9x", "linux", "x64"),
    "https://buildbot.libretro.com/nightly/linux/x86_64/latest/snes9x_libretro.so.zip",
  );
  assert.equal(
    coreDownloadUrl("mupen64plus_next", "win32", "x64"),
    "https://buildbot.libretro.com/nightly/windows/x86_64/latest/mupen64plus_next_libretro.dll.zip",
  );
  assert.equal(
    coreDownloadUrl("genesis_plus_gx", "darwin", "arm64"),
    "https://buildbot.libretro.com/nightly/apple/osx/arm64/latest/genesis_plus_gx_libretro.dylib.zip",
  );
});

test("a core name that could not be a filename is not made into a URL", () => {
  // Names reach here from the renderer, so the alphabet check that guards the
  // cores directory has to guard the request too.
  for (const bad of ["../../etc/passwd", "core name", "core.so", "Core", ""]) {
    assert.equal(coreDownloadUrl(bad, "linux", "x64"), null, bad);
  }
});

test("no URL is built for a machine with no buildbot directory", () => {
  assert.equal(coreDownloadUrl("snes9x", "freebsd", "x64"), null);
});

test("the first installable candidate skips names that cannot be fetched", () => {
  assert.equal(firstInstallableCore(["../evil", "snes9x", "bsnes"]), "snes9x");
  assert.equal(firstInstallableCore(["../evil"]), null);
  assert.equal(firstInstallableCore([]), null);
});

test("offers to install when the core is the only thing missing", () => {
  const config = baseConfig({
    retroarchPath: "/usr/bin/retroarch",
    retroarchCoresPath: fakeCores([]),
  });
  assert.ok(canInstallCore(config, "snes", ["snes9x"], "linux", "x64"));
});

test("does not install a core that is already there", () => {
  const config = baseConfig({
    retroarchPath: "/usr/bin/retroarch",
    retroarchCoresPath: fakeCores(["snes9x"]),
  });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x"], "linux", "x64"),
    false,
  );
});

test("does not install when a later candidate is already there", () => {
  // resolveCore takes the first installed candidate rather than the first
  // named one, so a preferred core being absent is not a reason to download.
  const config = baseConfig({
    retroarchPath: "/usr/bin/retroarch",
    retroarchCoresPath: fakeCores(["bsnes"]),
  });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x", "bsnes"], "linux", "x64"),
    false,
  );
});

test("respects the setting being turned off", () => {
  const config = baseConfig({
    autoInstallCores: false,
    retroarchPath: "/usr/bin/retroarch",
    retroarchCoresPath: fakeCores([]),
  });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x"], "linux", "x64"),
    false,
  );
});

test("does not install without somewhere to put it", () => {
  const config = baseConfig({ retroarchPath: "/usr/bin/retroarch" });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x"], "linux", "x64"),
    false,
  );
});

test("does not install a core for a standalone emulator", () => {
  // PCSX2 never loads a libretro core, so the platform having candidate cores
  // is not a reason to fetch one.
  const config = baseConfig({
    retroarchCoresPath: fakeCores([]),
    emulators: [
      {
        platformSlug: "ps2",
        label: "PCSX2",
        command: "/usr/bin/pcsx2",
        args: ["-batch", "{rom}"],
      },
    ],
  });
  assert.equal(canInstallCore(config, "ps2", ["pcsx2"], "linux", "x64"), false);
});

test("installs a core for a mapping that names one", () => {
  const config = baseConfig({
    retroarchCoresPath: fakeCores([]),
    emulators: [
      {
        platformSlug: "*",
        label: "RetroArch (Flatpak)",
        command: "/usr/bin/flatpak",
        args: ["run", "org.libretro.RetroArch", "-L", "{core}", "{rom}"],
      },
    ],
  });
  assert.ok(canInstallCore(config, "snes", ["snes9x"], "linux", "x64"));
});

test("does not install for a machine the buildbot skips", () => {
  const config = baseConfig({
    retroarchPath: "/usr/bin/retroarch",
    retroarchCoresPath: fakeCores([]),
  });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x"], "freebsd", "x64"),
    false,
  );
});

test("does not install when the platform names no fetchable core", () => {
  const config = baseConfig({
    retroarchPath: "/usr/bin/retroarch",
    retroarchCoresPath: fakeCores([]),
  });
  assert.equal(canInstallCore(config, "snes", [], "linux", "x64"), false);
  assert.equal(
    canInstallCore(config, "snes", ["../evil"], "linux", "x64"),
    false,
  );
});
