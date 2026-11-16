import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { type DesktopConfig } from "../../shared/types.ts";
import { gcFileName, IPL_SIZE, iplRegions, supplyDolphinFirmware } from "./dolphin.ts";

/**
 * A buffer of IPL_SIZE whose CRC32 is `target`. CRC32 is affine over GF(2) in
 * the last four bytes, so they are solved for with crc32 itself as the oracle.
 */
function bufferWithCrc(target: number): Buffer {
  const data = Buffer.alloc(IPL_SIZE);
  const at = IPL_SIZE - 4;
  const base = crc32(data);
  // Each row: the CRC change one bit of the tail causes, and that bit.
  const rows: { effect: number; bits: number }[] = [];
  for (let bit = 0; bit < 32; bit++) {
    data.writeUInt32LE((1 << bit) >>> 0, at);
    rows.push({ effect: (crc32(data) ^ base) >>> 0, bits: (1 << bit) >>> 0 });
  }
  // Gaussian elimination, then combine the rows that make up the difference.
  const basis: ({ effect: number; bits: number } | undefined)[] = [];
  for (const row of rows) {
    let { effect, bits } = row;
    for (let pivot = 31; pivot >= 0 && effect; pivot--) {
      if (!((effect >>> pivot) & 1)) continue;
      const known = basis[pivot];
      if (!known) {
        basis[pivot] = { effect, bits };
        break;
      }
      effect = (effect ^ known.effect) >>> 0;
      bits = (bits ^ known.bits) >>> 0;
    }
  }
  let want = (target ^ base) >>> 0;
  let tail = 0;
  for (let pivot = 31; pivot >= 0; pivot--) {
    if (!((want >>> pivot) & 1)) continue;
    const known = basis[pivot]!;
    want = (want ^ known.effect) >>> 0;
    tail = (tail ^ known.bits) >>> 0;
  }
  data.writeUInt32LE(tail, at);
  return data;
}

const NTSC_1_0 = 0x6dac1f2a;
const PAL_1_2 = 0xad1b7f16;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "romm-dolphin-bios-"));
  const user = join(root, "Dolphin");
  const mirrorDir = join(root, "mirror");
  mkdirSync(user);
  mkdirSync(mirrorDir);
  const config = {
    useRommFirmware: true,
    standaloneDataPaths: { dolphin: user },
  } as unknown as DesktopConfig;
  const mirror = { directory: mirrorDir, count: 1 };
  const supply = () =>
    supplyDolphinFirmware({ config, mirror, command: "/usr/bin/dolphin-emu", args: [] });
  return { root, user, mirrorDir, config, supply };
}

test("the forged buffers really carry the CRCs they are meant to", () => {
  assert.equal(crc32(bufferWithCrc(NTSC_1_0)), NTSC_1_0);
  assert.equal(crc32(bufferWithCrc(PAL_1_2)), PAL_1_2);
});

test("an NTSC IPL belongs to both NTSC regions and a PAL one to EUR", () => {
  assert.deepEqual(iplRegions(bufferWithCrc(NTSC_1_0)), ["USA", "JAP"]);
  assert.deepEqual(iplRegions(bufferWithCrc(PAL_1_2)), ["EUR"]);
  assert.deepEqual(iplRegions(Buffer.alloc(IPL_SIZE)), []);
  assert.deepEqual(iplRegions(Buffer.alloc(16)), []);
});

test("GC file names match any case, at the size Dolphin accepts", () => {
  assert.equal(gcFileName("DSP_ROM.BIN", 8192), "dsp_rom.bin");
  assert.equal(gcFileName("dsp_coef.bin", 4096), "dsp_coef.bin");
  assert.equal(gcFileName("dsp_rom.bin", 100), null);
  // Dolphin reads loose fonts only from its own install.
  assert.equal(gcFileName("font_western.bin", 0x3000), null);
  assert.equal(gcFileName("IPL.bin", IPL_SIZE), null);
});

test("places DSP ROMs and an IPL under its region folders", async () => {
  const f = fixture();
  writeFileSync(join(f.mirrorDir, "DSP_ROM.bin"), Buffer.alloc(8192, 7));
  writeFileSync(join(f.mirrorDir, "gc-ntsc-10.bin"), bufferWithCrc(NTSC_1_0));
  writeFileSync(join(f.mirrorDir, "gc-pal-12.bin"), bufferWithCrc(PAL_1_2));
  assert.equal(await f.supply(), 4);
  assert.equal(readFileSync(join(f.user, "GC", "dsp_rom.bin"))[0], 7);
  for (const region of ["USA", "JAP", "EUR"]) {
    assert.ok(existsSync(join(f.user, "GC", region, "IPL.bin")), region);
  }
  assert.equal(crc32(readFileSync(join(f.user, "GC", "EUR", "IPL.bin"))), PAL_1_2);
});

test("ignores unknown and wrong-sized files and keeps the user's own", async () => {
  const f = fixture();
  writeFileSync(join(f.mirrorDir, "dsp_coef.bin"), Buffer.alloc(4096, 1));
  writeFileSync(join(f.mirrorDir, "dsp_rom.bin"), "truncated");
  writeFileSync(join(f.mirrorDir, "font_western.bin"), "font");
  writeFileSync(join(f.mirrorDir, "unknown.bin"), Buffer.alloc(IPL_SIZE));
  mkdirSync(join(f.user, "GC"));
  writeFileSync(join(f.user, "GC", "dsp_coef.bin"), "mine");
  assert.equal(await f.supply(), 0);
  assert.equal(readFileSync(join(f.user, "GC", "dsp_coef.bin"), "utf8"), "mine");
  assert.equal(existsSync(join(f.user, "GC", "dsp_rom.bin")), false);
  assert.equal(existsSync(join(f.user, "GC", "font_western.bin")), false);
  assert.equal(existsSync(join(f.user, "GC", "USA")), false);
});

test("does not create a user folder Dolphin has not", async () => {
  const f = fixture();
  writeFileSync(join(f.mirrorDir, "dsp_rom.bin"), Buffer.alloc(8192));
  const missing = join(f.root, "not-initialized");
  f.config.standaloneDataPaths.dolphin = missing;
  assert.equal(await f.supply(), 0);
  assert.equal(existsSync(missing), false);
});
