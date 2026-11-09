import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DesktopConfig } from "../../shared/types.ts";
import { supplyPcsx2Firmware } from "./pcsx2.ts";
import { type FirmwareMirror } from "./sync.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "romm-pcsx2-bios-"));
  const profile = join(root, "PCSX2");
  const mirrorDir = join(root, "mirror");
  mkdirSync(profile);
  mkdirSync(mirrorDir);
  writeFileSync(join(mirrorDir, "SCPH.bin"), "romm");
  const config = {
    useRommFirmware: true,
    standaloneDataPaths: { pcsx2: profile },
  } as DesktopConfig;
  const mirror = { directory: mirrorDir, count: 1 } as FirmwareMirror;
  return { root, profile, mirrorDir, config, mirror };
}

test("copies RomM firmware to an existing PCSX2 profile", async () => {
  const f = fixture();
  assert.equal(await supplyPcsx2Firmware({ config: f.config, mirror: f.mirror, command: "/usr/bin/pcsx2-qt", args: [] }), 1);
  assert.equal(readFileSync(join(f.profile, "bios", "SCPH.bin"), "utf8"), "romm");
});

test("does not overwrite existing BIOS images", async () => {
  const f = fixture();
  mkdirSync(join(f.profile, "bios"));
  writeFileSync(join(f.profile, "bios", "SCPH.bin"), "mine");
  assert.equal(await supplyPcsx2Firmware({ config: f.config, mirror: f.mirror, command: "/usr/bin/pcsx2-qt", args: [] }), 0);
  assert.equal(readFileSync(join(f.profile, "bios", "SCPH.bin"), "utf8"), "mine");
});

test("does not initialize missing PCSX2 profiles", async () => {
  const f = fixture();
  const missing = join(f.root, "not-initialized");
  f.config.standaloneDataPaths.pcsx2 = missing;
  assert.equal(await supplyPcsx2Firmware({ config: f.config, mirror: f.mirror, command: "/usr/bin/pcsx2-qt", args: [] }), 0);
  assert.equal(existsSync(missing), false);
});

test("does not provision when firmware mirroring is disabled", async () => {
  const f = fixture();
  f.config.useRommFirmware = false;
  assert.equal(await supplyPcsx2Firmware({ config: f.config, mirror: f.mirror, command: "/usr/bin/pcsx2-qt", args: [] }), 0);
  assert.equal(existsSync(join(f.profile, "bios")), false);
});
