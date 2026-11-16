// Supply Dolphin's GameCube folder from RomM's firmware mirror.
//
// Dolphin looks for GameCube system files in GC/ inside its user folder: the
// DSP ROMs and fonts by fixed names, and the IPL as GC/<region>/IPL.bin. The
// Wii needs nothing of the kind, so only those files are placed.
//
// A mirrored IPL can carry any name the user uploaded it under, so it is
// identified by content instead, against the same Redump CRC32s Dolphin checks
// a dump with. NTSC dumps are shared by the US and Japanese consoles, so one
// goes to both USA/ and JAP/; a PAL dump goes to EUR/. Dolphin skips the IPL by
// default, so this only matters to someone who has switched that off.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { type DesktopConfig } from "../../shared/types.ts";
import { standaloneData } from "../standalone/data.ts";
import { copyIfMissing, type MirrorSummary, mirroredFiles } from "./place.ts";

/** Files Dolphin reads from GC/ by exactly these names. */
const GC_FILES = [
  "dsp_rom.bin",
  "dsp_coef.bin",
  "font_western.bin",
  "font_japanese.bin",
];

/** The size of every official IPL dump. */
export const IPL_SIZE = 2 * 1024 * 1024;

/** Redump CRC32s of the retail IPLs, as Dolphin's CBoot::Load_BS2 lists them,
 *  and the region folders each belongs in. */
const IPL_REGIONS: ReadonlyMap<number, readonly string[]> = new Map([
  [0x6dac1f2a, ["USA", "JAP"]], // NTSC 1.0
  [0xd5e6feea, ["USA", "JAP"]], // NTSC 1.1
  [0xd235e3f9, ["USA", "JAP"]], // NTSC 1.2 (DOL-001)
  [0x86573808, ["USA", "JAP"]], // NTSC 1.2 (DOL-101)
  [0x667d0b64, ["USA"]], // MPAL 1.1, a Brazilian console that plays NTSC-U
  [0x4f319f43, ["EUR"]], // PAL 1.0
  [0xad1b7f16, ["EUR"]], // PAL 1.2
]);

/** The region folders an IPL dump belongs in, or none for anything else. */
export function iplRegions(contents: Uint8Array): readonly string[] {
  if (contents.byteLength !== IPL_SIZE) return [];
  return IPL_REGIONS.get(crc32(contents)) ?? [];
}

/** The fixed GC/ name a mirrored file matches, ignoring case. */
export function gcFileName(name: string): string | null {
  const lower = name.toLowerCase();
  return GC_FILES.find((known) => known === lower) ?? null;
}

export async function supplyDolphinFirmware(options: {
  config: DesktopConfig;
  mirror: MirrorSummary | null;
  command: string;
  args: readonly string[];
  home?: string;
}): Promise<number> {
  const { config, mirror, command, args } = options;
  if (!config.useRommFirmware || !mirror || mirror.count === 0) return 0;
  const data = standaloneData({
    emulatorId: "dolphin",
    platformSlug: "ngc",
    command,
    args,
    configured: config.standaloneDataPaths,
    home: options.home ?? homedir(),
  });
  // Do not create a user folder before Dolphin has initialized itself.
  if (!data?.exists) return 0;
  const gc = join(data.folder, "GC");
  let copied = 0;
  for (const name of await mirroredFiles(mirror.directory)) {
    const source = join(mirror.directory, name);
    const fixed = gcFileName(name);
    if (fixed) {
      if (await copyIfMissing(source, gc, fixed)) copied++;
      continue;
    }
    // Only a file of the right size is read whole to be hashed.
    const info = await stat(source).catch(() => null);
    if (info?.size !== IPL_SIZE) continue;
    const contents = await readFile(source).catch(() => null);
    if (!contents) continue;
    for (const region of iplRegions(contents)) {
      if (await copyIfMissing(source, join(gc, region), "IPL.bin")) copied++;
    }
  }
  return copied;
}
