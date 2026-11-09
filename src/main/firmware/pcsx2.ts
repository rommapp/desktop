// Supply PCSX2's default BIOS folder from RomM's existing firmware mirror.
// Never replace a file the user already has, or touch PCSX2's settings.
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { type DesktopConfig } from "../../shared/types.ts";
import { standaloneData } from "../standalone/data.ts";
import { type FirmwareMirror } from "./sync.ts";

export async function supplyPcsx2Firmware(options: {
  config: DesktopConfig;
  mirror: FirmwareMirror | null;
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
  const target = join(data.folder, "bios");
  const entries = await readdir(mirror.directory, { withFileTypes: true });
  let copied = 0;
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const source = join(mirror.directory, entry.name);
    // The mirror may change while a launch is being prepared.
    if (!(await stat(source).catch(() => null))) continue;
    try {
      await copyFile(source, join(target, entry.name), constants.COPYFILE_EXCL);
      copied++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return copied;
}
