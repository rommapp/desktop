// Hand the firmware mirror to whichever standalone emulator a launch runs.
//
// "{bios}" and "{biosconfig}" reach RetroArch and hand-written rows, but a
// detected standalone emulator's template names only "{rom}", and none of
// these four can be pointed at a firmware directory per launch anyway. Each
// one gets what its own module knows to do instead.

import { type DesktopConfig } from "../../shared/types.ts";
import { supplyCemuFirmware } from "./cemu.ts";
import { supplyDolphinFirmware } from "./dolphin.ts";
import { supplyPcsx2Firmware } from "./pcsx2.ts";
import { type MirrorSummary } from "./place.ts";
import { supplyRpcs3Firmware } from "./rpcs3.ts";

export async function supplyStandaloneFirmware(options: {
  emulatorId: string | null;
  config: DesktopConfig;
  mirror: MirrorSummary | null;
  command: string;
  args: readonly string[];
  signal: AbortSignal;
  onInstall?: (fileName: string) => void;
}): Promise<void> {
  const { emulatorId, ...rest } = options;
  switch (emulatorId) {
    case "pcsx2":
      await supplyPcsx2Firmware(rest);
      return;
    case "dolphin":
      await supplyDolphinFirmware(rest);
      return;
    case "cemu":
      await supplyCemuFirmware(rest);
      return;
    case "rpcs3":
      await supplyRpcs3Firmware(rest);
      return;
  }
}
