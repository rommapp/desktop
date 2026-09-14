import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  canHandOffToOs,
  pickDolphinArtifact,
  pickPcsx2Artifact,
} from "./standalone-release.ts";

/** The real payloads, captured from each project's own release index, so the
 *  selectors are checked against the shapes they will actually meet. */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"),
  );
}

const DOLPHIN = fixture("dolphin-beta.json");
const PCSX2 = fixture("pcsx2-stable.json");

test("Dolphin gives macOS a universal disk image", () => {
  for (const arch of ["arm64", "x64"]) {
    const found = pickDolphinArtifact(DOLPHIN, "darwin", arch);
    assert.match(found?.fileName ?? "", /universal\.dmg$/, arch);
    assert.equal(found?.kind, "disk-image");
    assert.ok(canHandOffToOs(found!.kind));
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

test("Dolphin publishes no Windows installer, only an archive", () => {
  // Not a gap we can close: there is nothing to hand the OS, so the caller has
  // to send the user to the download page instead.
  const found = pickDolphinArtifact(DOLPHIN, "win32", "x64");
  assert.match(found?.fileName ?? "", /\.7z$/);
  assert.equal(found?.kind, "archive");
  assert.equal(canHandOffToOs(found!.kind), false);
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
  const found = pickPcsx2Artifact(PCSX2, "darwin", "arm64");
  assert.match(found?.fileName ?? "", /\.tar\.xz$/);
  assert.equal(canHandOffToOs(found!.kind), false);
});

test("32-bit Windows is offered no PCSX2 at all", () => {
  // Only x64 is published, and handing an x64 build to a 32-bit machine would
  // fail after the download rather than before it.
  assert.equal(pickPcsx2Artifact(PCSX2, "win32", "ia32"), null);
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
