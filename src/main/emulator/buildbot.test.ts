import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LaunchError } from "../../shared/types.ts";
import { testConfig } from "../../test/config.ts";
import {
  BUILDBOT_ORIGIN,
  assertBuildbotResponse,
  buildbotPlatformDir,
  buildbotSupportsThisMachine,
  canInstallCore,
  coreDownloadUrl,
  firstInstallableCore,
  planCoreInstall,
} from "./buildbot.ts";
import { coreFileName } from "./resolve.ts";

/** A cores directory holding the named cores and nothing else. */
function fakeCores(cores: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "romm-cores-"));
  for (const core of cores) writeFileSync(join(root, coreFileName(core)), "");
  return root;
}

/** An emulator binary that actually exists, since the predicate checks. */
function fakeEmulator(name = "retroarch"): string {
  const path = join(mkdtempSync(join(tmpdir(), "romm-emu-")), name);
  writeFileSync(path, "");
  return path;
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
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores([]),
  });
  assert.ok(canInstallCore(config, "snes", ["snes9x"], "linux", "x64"));
});

test("does not install a core that is already there", () => {
  const config = testConfig({
    retroarchPath: fakeEmulator(),
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
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores(["bsnes"]),
  });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x", "bsnes"], "linux", "x64"),
    false,
  );
});

test("respects the setting being turned off", () => {
  const config = testConfig({
    autoInstallCores: false,
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores([]),
  });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x"], "linux", "x64"),
    false,
  );
});

test("does not install without somewhere to put it", () => {
  const config = testConfig({ retroarchPath: fakeEmulator() });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x"], "linux", "x64"),
    false,
  );
});

test("does not install a core for a standalone emulator", () => {
  // PCSX2 never loads a libretro core, so the platform having candidate cores
  // is not a reason to fetch one.
  const config = testConfig({
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
  const config = testConfig({
    retroarchCoresPath: fakeCores([]),
    emulators: [
      {
        platformSlug: "*",
        label: "RetroArch (Flatpak)",
        command: fakeEmulator("flatpak"),
        args: ["run", "org.libretro.RetroArch", "-L", "{core}", "{rom}"],
      },
    ],
  });
  assert.ok(canInstallCore(config, "snes", ["snes9x"], "linux", "x64"));
});

test("does not install for a machine the buildbot skips", () => {
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores([]),
  });
  assert.equal(
    canInstallCore(config, "snes", ["snes9x"], "freebsd", "x64"),
    false,
  );
});

test("does not install when the platform names no fetchable core", () => {
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores([]),
  });
  assert.equal(canInstallCore(config, "snes", [], "linux", "x64"), false);
  assert.equal(
    canInstallCore(config, "snes", ["../evil"], "linux", "x64"),
    false,
  );
});

test("does not authorize a download with no emulator to load the core", () => {
  // The predicate has to check this itself rather than leave it to callers: a
  // download cannot conjure an emulator, and a caller trusting the name would
  // fetch a core nothing can load.
  const missing = testConfig({
    retroarchPath: "/nowhere/retroarch",
    retroarchCoresPath: fakeCores([]),
  });
  assert.equal(
    canInstallCore(missing, "snes", ["snes9x"], "linux", "x64"),
    false,
  );

  const none = testConfig({ retroarchCoresPath: fakeCores([]) });
  assert.equal(canInstallCore(none, "snes", ["snes9x"], "linux", "x64"), false);

  const mappingMissing = testConfig({
    retroarchCoresPath: fakeCores([]),
    emulators: [
      {
        platformSlug: "*",
        command: "/nowhere/flatpak",
        args: ["-L", "{core}", "{rom}"],
      },
    ],
  });
  assert.equal(
    canInstallCore(mappingMissing, "snes", ["snes9x"], "linux", "x64"),
    false,
  );
});

test("accepts a response that came from the buildbot", () => {
  assertBuildbotResponse(
    { url: `${BUILDBOT_ORIGIN}/nightly/linux/x86_64/latest/a_libretro.so.zip` },
    `${BUILDBOT_ORIGIN}/nightly/linux/x86_64/latest/a_libretro.so.zip`,
  );
  // No url on the response means nothing redirected it.
  assertBuildbotResponse({}, `${BUILDBOT_ORIGIN}/stable/`);
  assertBuildbotResponse({ url: "" }, `${BUILDBOT_ORIGIN}/stable/`);
});

test("refuses a response redirected off the buildbot", () => {
  // net.fetch follows redirects, so checking only the requested URL would let
  // the bytes that actually arrive come from anywhere.
  assert.throws(
    () =>
      assertBuildbotResponse(
        { url: "https://evil.example.com/snes9x_libretro.so.zip" },
        `${BUILDBOT_ORIGIN}/nightly/linux/x86_64/latest/snes9x_libretro.so.zip`,
      ),
    /evil\.example\.com/,
  );
  // A lookalike host is a different origin, and so is plain http.
  assert.throws(
    () =>
      assertBuildbotResponse(
        { url: "https://buildbot.libretro.com.evil.example.com/x" },
        BUILDBOT_ORIGIN,
      ),
    LaunchError,
  );
  assert.throws(
    () =>
      assertBuildbotResponse(
        { url: "http://buildbot.libretro.com/x" },
        BUILDBOT_ORIGIN,
      ),
    LaunchError,
  );
  assert.throws(
    () => assertBuildbotResponse({ url: "not a url" }, BUILDBOT_ORIGIN),
    LaunchError,
  );
});

test("a missing preference is fetched even when a fallback is installed", () => {
  // The case preferredCores exists for. Someone sets psx to mednafen_psx_hw
  // because RetroAchievements does not recognise pcsx_rearmed -- and they have
  // pcsx_rearmed, which is why they need the preference at all. canInstallCore
  // says no here, because a candidate is installed; the plan has to say yes.
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores(["pcsx_rearmed"]),
    preferredCores: { psx: ["mednafen_psx_hw"] },
  });
  const cores = ["mednafen_psx_hw", "pcsx_rearmed"];
  assert.equal(canInstallCore(config, "psx", cores, "linux", "x64"), false);

  const plan = planCoreInstall(
    config,
    "psx",
    cores,
    ["mednafen_psx_hw"],
    "linux",
    "x64",
  );
  assert.deepEqual(plan?.cores, ["mednafen_psx_hw"]);
  // Not required: pcsx_rearmed still plays the game, so a preference that turns
  // out not to be published must not take the launch down with it.
  assert.equal(plan?.required, false);
});

test("nothing installed at all makes the download the launch", () => {
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores([]),
    preferredCores: { psx: ["mednafen_psx_hw"] },
  });
  const cores = ["mednafen_psx_hw", "pcsx_rearmed"];
  const plan = planCoreInstall(
    config,
    "psx",
    cores,
    ["mednafen_psx_hw"],
    "linux",
    "x64",
  );
  // The whole list, so an unpublished preference still falls through to the
  // core RomM named rather than failing.
  assert.deepEqual(plan?.cores, cores);
  assert.equal(plan?.required, true);
});

test("the order inside the preference list is honoured too", () => {
  // A preference list is ranked, so having the second one is not having the
  // one that was asked for first.
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores(["swanstation"]),
    preferredCores: { psx: ["mednafen_psx_hw", "swanstation"] },
  });
  const preferred = ["mednafen_psx_hw", "swanstation"];
  const plan = planCoreInstall(
    config,
    "psx",
    [...preferred, "pcsx_rearmed"],
    preferred,
    "linux",
    "x64",
  );
  // Only the one ranked above what is installed: swanstation is already the
  // answer if mednafen cannot be fetched, so re-downloading it is pointless.
  assert.deepEqual(plan?.cores, ["mednafen_psx_hw"]);
  assert.equal(plan?.required, false);
});

test("the top preference being installed asks for nothing", () => {
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores(["mednafen_psx_hw"]),
    preferredCores: { psx: ["mednafen_psx_hw", "swanstation"] },
  });
  assert.equal(
    planCoreInstall(
      config,
      "psx",
      ["mednafen_psx_hw", "swanstation"],
      ["mednafen_psx_hw", "swanstation"],
      "linux",
      "x64",
    ),
    null,
  );
});

test("a satisfied preference is not fetched again", () => {
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores(["mednafen_psx_hw", "pcsx_rearmed"]),
    preferredCores: { psx: ["mednafen_psx_hw"] },
  });
  assert.equal(
    planCoreInstall(
      config,
      "psx",
      ["mednafen_psx_hw", "pcsx_rearmed"],
      ["mednafen_psx_hw"],
      "linux",
      "x64",
    ),
    null,
  );
});

test("no preference means no second question", () => {
  // With nothing preferred, the plan is exactly what canInstallCore says, so
  // an installed core is still not a reason to download another one.
  const config = testConfig({
    retroarchPath: fakeEmulator(),
    retroarchCoresPath: fakeCores(["bsnes"]),
  });
  assert.equal(
    planCoreInstall(config, "snes", ["snes9x", "bsnes"], [], "linux", "x64"),
    null,
  );
});
