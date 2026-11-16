// Copying mirrored firmware into a standalone emulator's own folders.
//
// RetroArch can be pointed at the mirror per launch. The standalone emulators
// cannot, short of moving their whole user folder, so the files are copied to
// where each one already looks. The rule every caller shares: a file the user
// already has wins, and nothing here edits a setting.

import { constants } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** The mirror fields placement needs, so these modules stay clear of the
 *  Electron-backed sync module. */
export interface MirrorSummary {
  directory: string;
  count: number;
}

/** The firmware files in a mirror directory, by name. */
export async function mirroredFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/**
 * Copy a file unless the target already exists. Returns whether it copied.
 *
 * The source is checked first because the mirror may change while a launch is
 * being prepared.
 */
export async function copyIfMissing(
  source: string,
  targetDirectory: string,
  targetName: string,
): Promise<boolean> {
  if (!(await stat(source).catch(() => null))) return false;
  await mkdir(targetDirectory, { recursive: true });
  try {
    await copyFile(
      source,
      join(targetDirectory, targetName),
      constants.COPYFILE_EXCL,
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
