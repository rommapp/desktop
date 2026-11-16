// Supply PCSX2's default BIOS folder from RomM's existing firmware mirror.
// Never replace a file the user already has, or touch PCSX2's settings.
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { type DesktopConfig } from "../../shared/types.ts";
import { standaloneData } from "../standalone/data.ts";
import { copyIfMissing, type MirrorSummary, mirroredFiles } from "./place.ts";
export type Pcsx2FirmwareMirror = MirrorSummary;


/** Read PCSX2's configured BIOS search directory without modifying its INI. */
export function configuredBiosDirectory(ini: string): string | null {
  let section = "";
  for (const line of ini.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) { section = (header[1] ?? "").trim().toLowerCase(); continue; }
    if (section !== "folders") continue;
    const setting = /^([^=]+)=(.*)$/.exec(trimmed);
    if (!setting || (setting[1] ?? "").trim().toLowerCase() !== "bios") continue;
    const value = (setting[2] ?? "").trim().replace(/^"(.+)"$/, "$1");
    return value || null;
  }
  return null;
}

async function biosDestination(profile: string): Promise<string> {
  const ini = await readFile(join(profile, "inis", "PCSX2.ini"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const override = ini ? configuredBiosDirectory(ini) : null;
  if (!override) return join(profile, "bios");
  return isAbsolute(override) || win32.isAbsolute(override)
    ? override
    : resolve(profile, override);
}

export async function supplyPcsx2Firmware(options: {
  config: DesktopConfig;
  mirror: Pcsx2FirmwareMirror | null;
  command: string;
  args: readonly string[];
  home?: string;
}): Promise<number> {
  const { config, mirror, command, args } = options;
  if (!config.useRommFirmware || !mirror || mirror.count === 0) return 0;
  const data = standaloneData({
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    command,
    args,
    configured: config.standaloneDataPaths,
    home: options.home ?? homedir(),
  });
  // Do not create an emulator profile before PCSX2 has initialized itself.
  if (!data?.exists) return 0;
  const target = await biosDestination(data.folder);
  let copied = 0;
  for (const name of await mirroredFiles(mirror.directory)) {
    if (await copyIfMissing(join(mirror.directory, name), target, name)) {
      copied++;
    }
  }
  return copied;
}
