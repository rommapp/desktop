import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedDownloadOrigin } from "../safety.ts";
import { DOLPHIN_BETA, PCSX2_STABLE } from "../../test/release-fixtures.ts";
import {
  RELEASE_SOURCES,
  installsWhereDetectionLooks,
  pickDolphinArtifact,
  pickPcsx2Artifact,
  unwrapRelease,
} from "./standalone-release.ts";

const DOLPHIN = DOLPHIN_BETA;
const PCSX2 = PCSX2_STABLE;

test("Dolphin gives macOS a universal disk image", () => {
  for (const arch of ["arm64", "x64"]) {
    const found = pickDolphinArtifact(DOLPHIN, "darwin", arch);
    assert.match(found?.fileName ?? "", /universal\.dmg$/, arch);
    assert.equal(found?.kind, "disk-image");
    assert.ok(installsWhereDetectionLooks(found!.kind));
  }
});

test("Dolphin gives Linux the Flatpak for its architecture", () => {
  assert.match(
    pickDolphinArtifact(DOLPHIN, "linux", "x64")?.fileName ?? "",
    /x86_64\.flatpak$/,
  );
  assert.match(
    pickDolphinArtifact(DOLPHIN, "linux", "arm64")?.fileName ?? "",
    /aarch64\.flatpak$/,
  );
});

test("Dolphin publishes no Windows installer, only a portable archive", () => {
  // Still offered -- Windows 11 opens a .7z in Explorer -- but it leaves a
  // portable build wherever the user extracts it, which detection cannot guess,
  // so the caller has to say so.
  const found = pickDolphinArtifact(DOLPHIN, "win32", "x64");
  assert.match(found?.fileName ?? "", /\.7z$/);
  assert.equal(found?.kind, "archive");
  assert.equal(installsWhereDetectionLooks(found!.kind), false);
});

test("Dolphin's Android build is never mistaken for a desktop one", () => {
  // The system strings are prose and matched by prefix, so this checks the
  // prefix cannot stray onto the .apk sitting in the same list.
  for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
    const found = pickDolphinArtifact(DOLPHIN, platform, "x64");
    assert.doesNotMatch(found?.fileName ?? "", /\.apk$/, platform);
  }
});

test("Dolphin reports the version it would install", () => {
  // RetroAchievements requires 2407-68 or newer for GameCube, so the number
  // has to be something the user can check.
  assert.equal(
    pickDolphinArtifact(DOLPHIN, "darwin", "arm64")?.version,
    "2606a",
  );
});

test("PCSX2 gives Windows the installer, not the portable archive", () => {
  const found = pickPcsx2Artifact(PCSX2, "win32", "x64");
  assert.match(found?.fileName ?? "", /installer\.exe$/);
  assert.equal(found?.kind, "installer");
});

test("PCSX2's symbols archive is never chosen", () => {
  // It sits in the same group as the build it belongs to and is not an install.
  for (const platform of ["win32", "linux", "darwin"] as NodeJS.Platform[]) {
    assert.doesNotMatch(
      pickPcsx2Artifact(PCSX2, platform, "x64")?.fileName ?? "",
      /symbols/,
      platform,
    );
  }
});

test("PCSX2 prefers the Flatpak over the AppImage on Linux", () => {
  // Both are published; only one is something the OS installs.
  const found = pickPcsx2Artifact(PCSX2, "linux", "x64");
  assert.match(found?.fileName ?? "", /\.flatpak$/);
  assert.equal(found?.kind, "flatpak");
});

test("PCSX2 publishes only an archive for macOS", () => {
  // Archive Utility opens it, so it is still worth offering; it just needs the
  // same "and then move it yourself" note the Windows .7z does.
  const found = pickPcsx2Artifact(PCSX2, "darwin", "arm64");
  assert.match(found?.fileName ?? "", /\.tar\.xz$/);
  assert.equal(installsWhereDetectionLooks(found!.kind), false);
});

test("32-bit Windows is offered no PCSX2 at all", () => {
  // Only x64 is published, and handing an x64 build to a 32-bit machine would
  // fail after the download rather than before it.
  assert.equal(pickPcsx2Artifact(PCSX2, "win32", "ia32"), null);
});

test("32-bit Windows is offered no Dolphin either", () => {
  // The "Windows x64" group is the only one a fall-through could reach, and
  // that binary will not start on a 32-bit OS.
  assert.equal(pickDolphinArtifact(DOLPHIN, "win32", "ia32"), null);
});

test("a Linux machine PCSX2 does not build for is offered nothing", () => {
  // The Linux group holds x86_64 Flatpaks and AppImages, and PCSX2 is an x86-64
  // recompiler: there is no ARM build to fall back to, so the group must not be
  // read on an ARM machine just because the platform matches.
  assert.equal(pickPcsx2Artifact(PCSX2, "linux", "arm64"), null);
  assert.equal(pickPcsx2Artifact(PCSX2, "linux", "arm"), null);
  assert.ok(pickPcsx2Artifact(PCSX2, "linux", "x64"));
});

test("a bare executable in a release index is not offered", () => {
  // Every kind here ends at shell.openPath, which runs an .exe on Windows.
  // Classifying an unknown executable as an archive and opening it anyway would
  // have executed whatever a release index happened to list.
  const index = {
    shortrev: "2606a",
    artifacts: [
      {
        system: "Windows x64",
        url: "https://dl.dolphin-emu.org/uninstall.exe",
      },
      { system: "Windows x64", url: "https://dl.dolphin-emu.org/dolphin.7z" },
    ],
  };
  const found = pickDolphinArtifact(index, "win32", "x64");
  assert.equal(found?.fileName, "dolphin.7z");
  assert.equal(found?.kind, "archive");

  const onlyExe = { shortrev: "1", artifacts: [index.artifacts[0]] };
  assert.equal(pickDolphinArtifact(onlyExe, "win32", "x64"), null);
});

test("an unknown platform is offered nothing rather than a guess", () => {
  assert.equal(pickDolphinArtifact(DOLPHIN, "freebsd", "x64"), null);
  assert.equal(pickPcsx2Artifact(PCSX2, "freebsd", "x64"), null);
  assert.equal(pickDolphinArtifact(DOLPHIN, "linux", "s390x"), null);
});

test("a release index that cannot be read yields null, not a throw", () => {
  // These come off the network, so every wrong shape has to fall through to
  // "nothing to offer" rather than failing a launch.
  for (const junk of [
    null,
    undefined,
    "",
    42,
    {},
    { artifacts: "no" },
    { artifacts: [null, 7, { system: 1, url: 2 }] },
    { assets: null },
    { assets: { Windows: "no" } },
    { assets: { Windows: [{ url: 5 }] } },
  ]) {
    assert.equal(pickDolphinArtifact(junk, "darwin", "arm64"), null, `${junk}`);
    assert.equal(pickPcsx2Artifact(junk, "win32", "x64"), null, `${junk}`);
  }
});

test("a query string never leaks into the filename on disk", () => {
  const found = pickDolphinArtifact(
    {
      shortrev: "1",
      artifacts: [{ system: "macOS", url: "https://x/a.dmg?t=1" }],
    },
    "darwin",
    "arm64",
  );
  assert.equal(found?.fileName, "a.dmg");
});

test("each release source names an index and a page it may reach", () => {
  // The policies are what stop a redirect walking these downloads off the
  // projects' own hosts, so every source has to declare both.
  for (const [id, source] of Object.entries(RELEASE_SOURCES)) {
    assert.equal(source.id, id);
    assert.ok(isAllowedDownloadOrigin(source.indexUrl, source.indexPolicy), id);
    assert.match(source.downloadPage, /^https:\/\//, id);
    assert.ok(
      source.artifactPolicy.origins?.length ||
        source.artifactPolicy.hostSuffixes?.length,
      `${id} must restrict where artifacts come from`,
    );
  }
});

test("each source's real artifact URL passes its own policy", () => {
  // The check that would have caught pinning github.com without allowing the
  // asset host it redirects to.
  const dolphin = pickDolphinArtifact(DOLPHIN, "darwin", "arm64");
  assert.ok(
    isAllowedDownloadOrigin(
      dolphin!.url,
      RELEASE_SOURCES.dolphin!.artifactPolicy,
    ),
    dolphin!.url,
  );
  const pcsx2 = pickPcsx2Artifact(PCSX2, "win32", "x64");
  assert.ok(
    isAllowedDownloadOrigin(pcsx2!.url, RELEASE_SOURCES.pcsx2!.artifactPolicy),
    pcsx2!.url,
  );
  // And GitHub's asset host, which is where that one actually redirects.
  assert.ok(
    isAllowedDownloadOrigin(
      "https://release-assets.githubusercontent.com/x?sig=y",
      RELEASE_SOURCES.pcsx2!.artifactPolicy,
    ),
  );
});

test("PCSX2's index envelope is unwrapped before picking", () => {
  const wrapped = { stableReleases: { data: [PCSX2] } };
  const found = pickPcsx2Artifact(
    unwrapRelease("pcsx2", wrapped),
    "win32",
    "x64",
  );
  assert.match(found?.fileName ?? "", /installer\.exe$/);
  // Dolphin's index is the release itself, so unwrapping is a no-op there.
  assert.equal(unwrapRelease("dolphin", DOLPHIN), DOLPHIN);
});

test("a malformed PCSX2 envelope unwraps to nothing rather than throwing", () => {
  for (const junk of [
    null,
    {},
    { stableReleases: null },
    { stableReleases: { data: [] } },
  ]) {
    assert.equal(
      pickPcsx2Artifact(unwrapRelease("pcsx2", junk), "win32", "x64"),
      null,
    );
  }
});
