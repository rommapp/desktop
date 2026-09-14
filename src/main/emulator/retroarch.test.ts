import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CACHE_LIMIT_BYTES,
  type DesktopConfig,
} from "../../shared/types.ts";
import {
  BUILDBOT_ORIGIN,
  PINNED_STABLE_VERSION,
  compareVersions,
  hasNoEmulator,
  latestStableVersion,
  retroarchInstaller,
  shouldOfferRetroArch,
} from "./retroarch.ts";

/** The shape the buildbot's stable index actually has, trimmed. */
const STABLE_INDEX = `
<div id="content"><table>
<tr><td><a href=".."></a></td></tr>
<tr><td><a href="/stable/1.9.5/">1.9.5</a></td></tr>
<tr><td><a href="/stable/1.9.14/">1.9.14</a></td></tr>
<tr><td><a href="/stable/1.10.0/">1.10.0</a></td></tr>
<tr><td><a href="/stable/1.22.1/">1.22.1</a></td></tr>
<tr><td><a href="/stable/1.22.2/">1.22.2</a></td></tr>
<tr><td><a href="/stable/altstore.json">altstore.json</a></td></tr>
</table></div>`;

test("takes the newest version out of the stable index", () => {
  assert.equal(latestStableVersion(STABLE_INDEX), "1.22.2");
});

test("orders versions numerically rather than as text", () => {
  // The whole reason not to sort these as strings: "1.9.14" sorts above
  // "1.10.0" alphabetically, and would pin users to a release from years back.
  assert.ok(compareVersions("1.10.0", "1.9.14") > 0);
  assert.ok(compareVersions("1.22.2", "1.22.10") < 0);
  assert.equal(compareVersions("1.22.2", "1.22.2"), 0);
  // Shorter versions pad with zeroes rather than counting as smaller segments.
  assert.ok(compareVersions("1.22", "1.22.1") < 0);
  assert.equal(compareVersions("1.22.0", "1.22"), 0);
});

test("an index it cannot read yields null rather than a wrong version", () => {
  assert.equal(latestStableVersion(""), null);
  assert.equal(latestStableVersion("<html><body>503</body></html>"), null);
  // Only the stable directories count, not every number on the page.
  assert.equal(
    latestStableVersion('<a href="/nightly/linux/x86_64/">2026-09-14</a>'),
    null,
  );
});

test("builds the Windows installer URL", () => {
  const installer = retroarchInstaller("1.22.2", "win32", "x64");
  assert.equal(
    installer?.url,
    "https://buildbot.libretro.com/stable/1.22.2/windows/x86_64/RetroArch-Win64-setup.exe",
  );
  assert.equal(installer?.fileName, "RetroArch-Win64-setup.exe");
  assert.equal(installer?.kind, "installer");
});

test("Windows on ARM is offered the x64 installer it can run", () => {
  assert.equal(
    retroarchInstaller("1.22.2", "win32", "arm64")?.fileName,
    "RetroArch-Win64-setup.exe",
  );
  assert.equal(
    retroarchInstaller("1.22.2", "win32", "ia32")?.fileName,
    "RetroArch-Win32-setup.exe",
  );
});

test("macOS gets the universal disk image whatever the arch", () => {
  for (const arch of ["arm64", "x64"]) {
    const installer = retroarchInstaller("1.22.2", "darwin", arch);
    assert.equal(
      installer?.url,
      "https://buildbot.libretro.com/stable/1.22.2/apple/osx/universal/RetroArch_Metal.dmg",
      arch,
    );
    // Universal, so there is no way to hand an arm64 build to an x86_64 install.
    assert.equal(installer?.kind, "disk-image");
  }
});

test("Linux is offered nothing to download", () => {
  // Deliberate: the buildbot ships only a portable .7z there, and the
  // distribution's own package is what will actually receive updates.
  assert.equal(retroarchInstaller("1.22.2", "linux", "x64"), null);
  assert.equal(retroarchInstaller("1.22.2", "linux", "arm64"), null);
  assert.equal(retroarchInstaller("1.22.2", "freebsd", "x64"), null);
});

test("every installer URL stays on the buildbot", () => {
  for (const [platform, arch] of [
    ["win32", "x64"],
    ["win32", "ia32"],
    ["win32", "arm64"],
    ["darwin", "arm64"],
  ] as [NodeJS.Platform, string][]) {
    const installer = retroarchInstaller("1.22.2", platform, arch);
    assert.equal(new URL(installer!.url).origin, BUILDBOT_ORIGIN);
  }
});

test("the pinned fallback resolves to a real installer on every platform", () => {
  // The pinned version exists so an unreachable index degrades to an older
  // RetroArch rather than to nothing, which only works if it names one.
  for (const [platform, arch] of [
    ["win32", "x64"],
    ["darwin", "arm64"],
  ] as [NodeJS.Platform, string][]) {
    assert.ok(
      retroarchInstaller(PINNED_STABLE_VERSION, platform, arch),
      `${platform}/${arch}`,
    );
  }
});

function baseConfig(patch: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverUrl: "https://romm.example.com",
    retroarchPath: null,
    retroarchCoresPath: null,
    autoInstallCores: true,
    offerRetroArchInstall: true,
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

test("offers when the machine has nothing to launch with", () => {
  assert.ok(shouldOfferRetroArch(baseConfig()));
});

test("says nothing once RetroArch has been found", () => {
  const config = baseConfig({ retroarchPath: "/usr/bin/retroarch" });
  assert.equal(hasNoEmulator(config), false);
  assert.equal(shouldOfferRetroArch(config), false);
});

test("says nothing to someone who configured their own emulator", () => {
  // Configuring PCSX2 and nothing else is a choice, and an unprompted dialog
  // pushing a different emulator would be presumptuous.
  const config = baseConfig({
    emulators: [
      { platformSlug: "ps2", command: "/usr/bin/pcsx2", args: ["{rom}"] },
    ],
  });
  assert.equal(hasNoEmulator(config), false);
  assert.equal(shouldOfferRetroArch(config), false);
});

test("respects having been told not to ask again", () => {
  assert.equal(
    shouldOfferRetroArch(baseConfig({ offerRetroArchInstall: false })),
    false,
  );
});

test("stays quiet until the server address is known", () => {
  // The setup window is already asking for something; stacking a second dialog
  // on top of it would be the first thing a new user sees.
  assert.equal(shouldOfferRetroArch(baseConfig({ serverUrl: null })), false);
});
