import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedDownloadOrigin } from "../safety.ts";
import {
  CEMU_LATEST,
  DOLPHIN_BETA,
  PCSX2_STABLE,
  RPCS3_LATEST,
} from "../../test/release-fixtures.ts";
import {
  RELEASE_SOURCES,
  installsWhereDetectionLooks,
  pickCemuArtifact,
  pickDolphinArtifact,
  pickPcsx2Artifact,
  pickRpcs3Artifact,
  rpcs3LatestBuild,
  unwrapRelease,
} from "./standalone-release.ts";

const DOLPHIN = DOLPHIN_BETA;
const PCSX2 = PCSX2_STABLE;
// RPCS3's index wraps the build in a status envelope, and every selector below
// wants the build itself.
const RPCS3 = unwrapRelease("rpcs3", RPCS3_LATEST);
const CEMU = CEMU_LATEST;

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

test("an uninstaller is not mistaken for an installer", () => {
  // "uninstaller.exe".endsWith("installer.exe") is true, and the installer kind
  // is the one thing that is meant to be run.
  const index = {
    version: "2.8.2",
    assets: {
      Windows: [
        {
          url: "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-uninstaller.exe",
        },
        {
          url: "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-windows-x64-installer.exe",
        },
      ],
    },
  };
  const found = pickPcsx2Artifact(index, "win32", "x64");
  assert.equal(found?.fileName, "pcsx2-v2.8.2-windows-x64-installer.exe");
  assert.equal(found?.kind, "installer");

  // On its own it is not an artifact at all, so nothing opens it.
  const onlyUninstaller = {
    version: "2.8.2",
    assets: { Windows: [index.assets.Windows[0]] },
  };
  assert.equal(pickPcsx2Artifact(onlyUninstaller, "win32", "x64"), null);
});

test("an asset that is not PCSX2's own release is not offered", () => {
  // The origin policy has to allow all of github.com, because a release
  // download redirects to an asset host whose name has changed before. An index
  // entry naming someone else's repository would otherwise be downloaded, and
  // for an installer, run.
  const elsewhere = (url: string) => ({
    version: "2.8.2",
    assets: { Windows: [{ url }] },
  });
  for (const url of [
    "https://github.com/someone/else/releases/download/v1/pcsx2-installer.exe",
    "https://raw.githubusercontent.com/PCSX2/pcsx2/main/pcsx2-installer.exe",
    "https://github.com/PCSX2/pcsx2/releases/download/../../../evil/x-installer.exe",
    "https://pcsx2.net.evil.example.com/PCSX2/pcsx2/releases/download/v1/x.7z",
    "not a url",
  ]) {
    assert.equal(pickPcsx2Artifact(elsewhere(url), "win32", "x64"), null, url);
  }

  // And the real one still is.
  assert.ok(pickPcsx2Artifact(PCSX2, "win32", "x64"));
});

test("RPCS3 publishes a portable build for every platform it has", () => {
  // Nothing the OS installs on its own: a .7z on Windows and macOS, an
  // AppImage on Linux. Still worth offering, but the caller has to say that
  // detection will not find whatever the user ends up with.
  for (const [platform, arch, pattern, kind] of [
    ["win32", "x64", /_win64_msvc\.7z$/, "archive"],
    ["linux", "x64", /_linux64\.AppImage$/, "appimage"],
    ["darwin", "arm64", /_macos\.7z$/, "archive"],
    ["darwin", "x64", /_macos\.7z$/, "archive"],
  ] as [NodeJS.Platform, string, RegExp, string][]) {
    const found = pickRpcs3Artifact(RPCS3, platform, arch);
    assert.match(found?.fileName ?? "", pattern, platform);
    assert.equal(found?.kind, kind, platform);
    assert.equal(installsWhereDetectionLooks(found!.kind), false);
  }
});

test("RPCS3 reports the build it would install", () => {
  assert.equal(
    pickRpcs3Artifact(RPCS3, "win32", "x64")?.version,
    "0.0.42-20004",
  );
});

test("a machine RPCS3 does not build for is offered nothing", () => {
  // The index carries three builds and no more, so an ARM Linux box and a
  // 32-bit Windows one have to fall through to the download page rather than
  // be handed the x86-64 one.
  assert.equal(pickRpcs3Artifact(RPCS3, "linux", "arm64"), null);
  assert.equal(pickRpcs3Artifact(RPCS3, "win32", "ia32"), null);
  assert.equal(pickRpcs3Artifact(RPCS3, "freebsd", "x64"), null);
});

test("RPCS3's status envelope is unwrapped before picking", () => {
  assert.ok(
    pickRpcs3Artifact(unwrapRelease("rpcs3", RPCS3_LATEST), "linux", "x64"),
  );
  for (const junk of [null, {}, { latest_build: null }, { return_code: 0 }]) {
    assert.equal(
      pickRpcs3Artifact(unwrapRelease("rpcs3", junk), "linux", "x64"),
      null,
    );
  }
});

test("a build RPCS3's endpoint declined to stand behind is not offered", () => {
  // Its own updater bails on a negative code: -2 is maintenance mode, -3 an
  // illegal search, and -255 is what a response missing the code reads as. A
  // build sitting beside one of those is not something to download.
  const build = (RPCS3_LATEST as { latest_build: unknown }).latest_build;
  for (const code of [-1, -2, -3, -255]) {
    assert.equal(
      rpcs3LatestBuild({ return_code: code, latest_build: build }),
      null,
      `${code}`,
    );
  }
  // A code that is absent, or not a number at all, reads the same way.
  assert.equal(rpcs3LatestBuild({ latest_build: build }), null);
  assert.equal(
    rpcs3LatestBuild({ return_code: "0", latest_build: build }),
    null,
  );
  assert.equal(
    rpcs3LatestBuild({ return_code: null, latest_build: build }),
    null,
  );

  // Zero and above are both answers, and both carry the build to fetch: their
  // client reads 0 as "already on it" and 1 as "there is a newer one". This
  // shell sends no commit hash and is told 0, so demanding exactly 0 would
  // break the offer the day that changes.
  for (const code of [0, 1, 2]) {
    assert.equal(
      rpcs3LatestBuild({ return_code: code, latest_build: build }),
      build,
      `${code}`,
    );
  }
});

test("an asset that is not RPCS3's own release is not offered", () => {
  // Its builds live in three repositories of their own, separate from the
  // source, and the artifact policy has to allow all of github.com -- so the
  // repository is what pins the download.
  const elsewhere = (url: string) => ({
    version: "0.0.42",
    windows: { download: url },
  });
  for (const url of [
    "https://github.com/someone/else/releases/download/build-1/rpcs3_win64.7z",
    "https://github.com/RPCS3/rpcs3/releases/download/build-1/x-installer.exe",
    "https://update.rpcs3.net.evil.example.com/RPCS3/rpcs3-binaries-win/releases/download/b/x.7z",
    "not a url",
  ]) {
    assert.equal(pickRpcs3Artifact(elsewhere(url), "win32", "x64"), null, url);
  }
  assert.ok(pickRpcs3Artifact(RPCS3, "win32", "x64"));
});

test("Cemu gives Windows the installer, not the portable zip", () => {
  // The installer lands in LOCALAPPDATA\\Cemu, which is where detection looks,
  // so the launch can wait for it and start the game itself.
  const found = pickCemuArtifact(CEMU, "win32", "x64");
  assert.equal(found?.fileName, "cemu-2.6-windows-x64-installer.exe");
  assert.equal(found?.kind, "installer");
  assert.ok(installsWhereDetectionLooks(found!.kind));
  // arm64 Windows runs the x64 build under emulation, as it does for PCSX2.
  assert.equal(
    pickCemuArtifact(CEMU, "win32", "arm64")?.fileName,
    found?.fileName,
  );
});

test("Cemu is chosen by preference, not by the order the release lists", () => {
  // The portable zip is listed before the installer in the real release, so
  // taking the first asset that matched the platform would take the zip.
  const assets = (CEMU as { assets: { name: string }[] }).assets;
  assert.ok(
    assets.findIndex((asset) => asset.name.endsWith("windows-x64.zip")) <
      assets.findIndex((asset) => asset.name.includes("installer")),
  );
  assert.equal(pickCemuArtifact(CEMU, "win32", "x64")?.kind, "installer");
});

test("Cemu gives each macOS architecture its own disk image", () => {
  assert.match(
    pickCemuArtifact(CEMU, "darwin", "arm64")?.fileName ?? "",
    /arm64\.dmg$/,
  );
  assert.match(
    pickCemuArtifact(CEMU, "darwin", "x64")?.fileName ?? "",
    /x86_64\.dmg$/,
  );
  // An Intel Mac must never be handed the arm64 build, so the x86-64 image is
  // the only one its pattern can reach.
  assert.doesNotMatch(
    pickCemuArtifact(CEMU, "darwin", "x64")?.fileName ?? "",
    /arm64/,
  );
});

test("Cemu falls back to the Intel disk image on Apple silicon", () => {
  // Rosetta runs it, so a release that skipped the arm64 build is still worth
  // offering rather than sending someone to the download page.
  const intelOnly = {
    tag_name: "v2.6",
    assets: (CEMU as { assets: { name: string }[] }).assets.filter(
      (asset) => !asset.name.includes("arm64"),
    ),
  };
  assert.match(
    pickCemuArtifact(intelOnly, "darwin", "arm64")?.fileName ?? "",
    /x86_64\.dmg$/,
  );
});

test("Cemu gives Linux the AppImage, not the Ubuntu zip", () => {
  // The zip is a bare binary against that release's system libraries; the
  // AppImage is the build the project points people at.
  const found = pickCemuArtifact(CEMU, "linux", "x64");
  assert.match(found?.fileName ?? "", /-x86_64\.AppImage$/);
  // Its own kind, not an archive: there is nothing inside it to extract, and
  // the offer has to make it executable rather than open it.
  assert.equal(found?.kind, "appimage");
  assert.equal(installsWhereDetectionLooks("appimage"), false);
  // No ARM Linux build exists, and the x86-64 AppImage would not run.
  assert.equal(pickCemuArtifact(CEMU, "linux", "arm64"), null);
  assert.equal(pickCemuArtifact(CEMU, "win32", "ia32"), null);
});

test("a checksum file beside a Cemu build is never chosen", () => {
  for (const platform of ["win32", "linux", "darwin"] as NodeJS.Platform[]) {
    assert.doesNotMatch(
      pickCemuArtifact(CEMU, platform, "x64")?.fileName ?? "",
      /sha256sums/,
      platform,
    );
  }
});

test("an asset that is not Cemu's own release is not offered", () => {
  const elsewhere = (url: string) => ({
    tag_name: "v2.6",
    assets: [
      { name: "cemu-2.6-windows-x64-installer.exe", browser_download_url: url },
    ],
  });
  for (const url of [
    "https://github.com/someone/else/releases/download/v2.6/cemu-2.6-windows-x64-installer.exe",
    "https://github.com/cemu-project/Cemu/archive/refs/tags/v2.6.zip",
    "not a url",
  ]) {
    assert.equal(pickCemuArtifact(elsewhere(url), "win32", "x64"), null, url);
  }
  assert.ok(pickCemuArtifact(CEMU, "win32", "x64"));
});

test("a Cemu asset whose name promises what its URL does not is refused", () => {
  // The name is what the platform is matched on, but the file on disk is named
  // after the URL and that is what shell.openPath will be handed.
  const mismatched = {
    tag_name: "v2.6",
    assets: [
      {
        name: "cemu-2.6-windows-x64-installer.exe",
        browser_download_url:
          "https://github.com/cemu-project/Cemu/releases/download/v2.6/setup",
      },
    ],
  };
  assert.equal(pickCemuArtifact(mismatched, "win32", "x64"), null);
});

test("an unknown platform is offered nothing rather than a guess", () => {
  assert.equal(pickDolphinArtifact(DOLPHIN, "freebsd", "x64"), null);
  assert.equal(pickPcsx2Artifact(PCSX2, "freebsd", "x64"), null);
  assert.equal(pickRpcs3Artifact(RPCS3, "freebsd", "x64"), null);
  assert.equal(pickCemuArtifact(CEMU, "freebsd", "x64"), null);
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
    { assets: [null, 7, { name: 1, browser_download_url: 2 }] },
    { windows: "no" },
    { windows: { download: 5 } },
  ]) {
    assert.equal(pickDolphinArtifact(junk, "darwin", "arm64"), null, `${junk}`);
    assert.equal(pickPcsx2Artifact(junk, "win32", "x64"), null, `${junk}`);
    assert.equal(pickRpcs3Artifact(junk, "win32", "x64"), null, `${junk}`);
    assert.equal(pickCemuArtifact(junk, "win32", "x64"), null, `${junk}`);
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
  for (const [id, artifact] of [
    ["rpcs3", pickRpcs3Artifact(RPCS3, "linux", "x64")],
    ["cemu", pickCemuArtifact(CEMU, "win32", "x64")],
  ] as const) {
    assert.ok(
      isAllowedDownloadOrigin(
        artifact!.url,
        RELEASE_SOURCES[id]!.artifactPolicy,
      ),
      artifact!.url,
    );
  }
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
