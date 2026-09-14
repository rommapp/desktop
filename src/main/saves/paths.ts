import { join } from "node:path";
import { safeFileNameComponent } from "../safety.ts";

/** Where a game's save data lives while the shell owns it. */
export interface SavePaths {
  saveDir: string;
  stateDir: string;
  /** Exact SRAM file the emulator is told to use. */
  saveFile: string;
  /** Savestate base path. RetroArch appends the slot number to it. */
  statePrefix: string;
}

/** Names Windows reserves for devices. Reserved whatever the extension, so
 *  `CON.srm` is as unopenable as `CON`. Applied on every platform so a tree
 *  written on one machine stays usable on another. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * The name a game's save data carries inside its own directory.
 *
 * The directory is keyed on the ROM id, so this only has to be stable, not
 * unique: a cached launch and an in-place library launch see the same ROM under
 * two different filenames, and deriving the save name from either one splits a
 * game's progress in half.
 */
export function saveBaseName(fileName: string): string {
  const cleaned = safeFileNameComponent(fileName);
  const dot = cleaned.lastIndexOf(".");
  const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  if (!base) return "rom";
  return WINDOWS_RESERVED.test(base) ? `_${base}` : base;
}

/** Work out where this game's saves and states belong, or null when the user
 *  has not opted into the shell managing them. */
export function resolveSavePaths(
  saveDataPath: string | null,
  romId: number,
  fileName: string,
): SavePaths | null {
  if (!saveDataPath) return null;

  const base = saveBaseName(fileName);
  const root = join(saveDataPath, String(romId));
  // Saves and states are separated by directory rather than by extension, so
  // what a file is never has to be inferred from what it is called.
  const saveDir = join(root, "saves");
  const stateDir = join(root, "states");

  return {
    saveDir,
    stateDir,
    saveFile: join(saveDir, `${base}.srm`),
    statePrefix: join(stateDir, `${base}.state`),
  };
}
