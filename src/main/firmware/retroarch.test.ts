import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  retroarchConfigCandidates,
  retroarchSystemDirectory,
  supplyRetroArchFirmware,
  systemDirectoryFrom,
} from "./retroarch.ts";

const RB_RA = "D:\\RetroBat\\emulators\\retroarch\\retroarch.exe";

test("a portable Windows RetroArch's config beside it comes before the profile's", () => {
  assert.deepEqual(
    retroarchConfigCandidates(RB_RA, "win32", "C:\\Users\\sam", {
      APPDATA: "C:\\Users\\sam\\AppData\\Roaming",
    }),
    [
      "D:\\RetroBat\\emulators\\retroarch\\retroarch.cfg",
      "C:\\Users\\sam\\AppData\\Roaming\\RetroArch\\retroarch.cfg",
    ],
  );
});

test("Linux reads the XDG config, or the Flatpak sandbox's for a Flatpak", () => {
  assert.deepEqual(retroarchConfigCandidates("/usr/bin/retroarch", "linux", "/home/sam", {}), [
    "/home/sam/.config/retroarch/retroarch.cfg",
  ]);
  assert.deepEqual(
    retroarchConfigCandidates(
      "/var/lib/flatpak/exports/bin/org.libretro.RetroArch",
      "linux",
      "/home/deck",
      {},
    ),
    ["/home/deck/.var/app/org.libretro.RetroArch/config/retroarch/retroarch.cfg"],
  );
  assert.deepEqual(
    retroarchConfigCandidates("/Applications/RetroArch.app/Contents/MacOS/RetroArch", "darwin", "/Users/sam", {}),
    ["/Users/sam/Library/Application Support/RetroArch/config/retroarch.cfg"],
  );
});

test("reads system_directory the way RetroArch writes it", () => {
  // RetroBat writes an absolute path; a portable install writes ":" for its
  // own folder; "~" is home.
  assert.equal(
    systemDirectoryFrom('system_directory = "D:\\RetroBat\\bios"\r\n', RB_RA, "win32", "C:\\Users\\sam"),
    "D:\\RetroBat\\bios",
  );
  assert.equal(
    systemDirectoryFrom('system_directory = ":\\system"', RB_RA, "win32", "C:\\Users\\sam"),
    "D:\\RetroBat\\emulators\\retroarch\\system",
  );
  assert.equal(
    systemDirectoryFrom('system_directory = "~/Emulation/bios"', "/usr/bin/retroarch", "linux", "/home/deck"),
    "/home/deck/Emulation/bios",
  );
  // The last one wins, as in RetroArch.
  assert.equal(
    systemDirectoryFrom('system_directory = "/a"\nsystem_directory = "/b"', "/usr/bin/retroarch", "linux", "/h"),
    "/b",
  );
});

test("declines a system_directory it cannot place", () => {
  for (const cfg of [
    'system_directory = "default"',
    'system_directory = ""',
    'system_directory = "bios"',
    'savefile_directory = "/saves"',
  ]) {
    assert.equal(systemDirectoryFrom(cfg, "/usr/bin/retroarch", "linux", "/h"), null, cfg);
  }
});

test("the first config that exists is the one used, even when it names nothing", () => {
  // RetroArch does not fall back to the profile's config for a value the
  // portable one lacks, so neither does this.
  const read = (path: string) =>
    ({
      "D:\\RetroBat\\emulators\\retroarch\\retroarch.cfg": 'video_driver = "gl"',
      "C:\\Users\\sam\\AppData\\Roaming\\RetroArch\\retroarch.cfg": 'system_directory = "C:\\bios"',
    })[path] ?? null;
  assert.equal(
    retroarchSystemDirectory({
      retroarchPath: RB_RA,
      platform: "win32",
      home: "C:\\Users\\sam",
      env: { APPDATA: "C:\\Users\\sam\\AppData\\Roaming" },
      read,
    }),
    null,
  );
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "romm-ra-bios-"));
  const system = join(root, "bios");
  const mirror = join(root, "mirror");
  mkdirSync(system);
  mkdirSync(mirror);
  writeFileSync(join(mirror, "scph5501.bin"), "romm");
  writeFileSync(join(mirror, "gba_bios.bin"), "romm");
  writeFileSync(join(system, "gba_bios.bin"), "mine");
  writeFileSync(join(system, "scph1001.bin"), "mine too");
  const options = {
    retroarchPath: "/usr/bin/retroarch",
    mirror: { directory: mirror, count: 2 },
    platform: "linux" as const,
    home: "/home/sam",
    env: {},
    read: () => `system_directory = "${system}"`,
  };
  return { system, options };
}

test("copies what is missing into RetroArch's directory and leaves the rest", async () => {
  const { system, options } = fixture();
  assert.deepEqual(await supplyRetroArchFirmware(options), { directory: system, copied: 1 });
  assert.equal(readFileSync(join(system, "scph5501.bin"), "utf8"), "romm");
  // The user's copy wins, and what RomM does not hold is untouched.
  assert.equal(readFileSync(join(system, "gba_bios.bin"), "utf8"), "mine");
  assert.equal(readFileSync(join(system, "scph1001.bin"), "utf8"), "mine too");
});

test("falls back to pinning when there is nothing to rely on", async () => {
  const { options } = fixture();
  assert.equal(await supplyRetroArchFirmware({ ...options, mirror: null }), null);
  assert.equal(
    await supplyRetroArchFirmware({ ...options, mirror: { ...options.mirror, count: 0 } }),
    null,
  );
  assert.equal(await supplyRetroArchFirmware({ ...options, read: () => null }), null);
  // A directory the config names but nobody made is not created.
  assert.equal(
    await supplyRetroArchFirmware({ ...options, read: () => 'system_directory = "/nowhere/bios"' }),
    null,
  );
});
