import { join } from "node:path";
import { safeFileName } from "../safety.ts";

/** Where a game's save data lives while the shell owns it. */
export interface SavePaths {
  saveDir: string;
  stateDir: string;
  /** Exact SRAM file the emulator is told to use. */
  saveFile: string;
  /** Savestate base path. RetroArch appends the slot number to it. */
  statePrefix: string;
}

/**
 * The name a game's save data carries inside its own directory.
 *
 * The directory is keyed on the ROM id, so this only has to be stable, not
 * unique: a cached launch and an in-place library launch see the same ROM under
 * two different filenames, and deriving the save name from either one splits a
 * game's progress in half.
 */
export function saveBaseName(fileName: string): string {
  const cleaned = safeFileName(fileName);
  const dot = cleaned.lastIndexOf(".");
  return dot > 0 ? cleaned.slice(0, dot) : cleaned;
}

/** One file in a save directory, as far as this module cares. */
export interface SaveEntry {
  name: string;
  modifiedAt: number;
}

/**
 * The save file in this directory that was written more recently than the
 * launch's own, or null when nothing was.
 *
 * The emulator names the save, not the shell: the flags and settings a launch
 * hands over pin the directory, but a name derived from the content can still
 * differ from the one the shell pulled into place. When it does, the shell's
 * file sits untouched next to the one the game is really writing, and this is
 * how that says something rather than reading as a save nobody made.
 */
export function newerSibling(
  ours: SaveEntry,
  entries: readonly SaveEntry[],
): string | null {
  const newest = entries
    .filter(
      (entry) =>
        entry.name !== ours.name &&
        entry.name.toLowerCase().endsWith(".srm") &&
        entry.modifiedAt > ours.modifiedAt,
    )
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  return newest[0]?.name ?? null;
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
