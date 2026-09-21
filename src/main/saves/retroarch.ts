// Asking RetroArch to write the save while the game is still running.
//
// The shell cannot tell a running emulator to flush its SRAM. There is no flag
// and no IPC for it, unlike the browser player, which calls EmulatorJS'
// saveSaveFiles() every second. RetroArch's own equivalent is a setting, so the
// only way to ask is to hand it one for the run.
//
// Without it RetroArch writes the save once, when the content closes, and that
// is a single moment to miss: a crash, a kill, or a launcher that exits before
// the emulator does all leave the file holding whatever the pull put there, and
// a launch that wrote a save reports having moved nothing.
//
// Layered with --appendconfig, like the firmware mirror's system_directory, so
// the user's own retroarch.cfg is never edited.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * How often the shell asks RetroArch to write the save.
 *
 * Short enough that an in-game save is on disk while the player is still in
 * the game, which is what the push during a run has to work with, and long
 * enough that a game writing nothing is not rewriting a file every second.
 * `retroarchAutosaveSeconds` overrides it, and zero leaves RetroArch's own
 * setting alone.
 */
export const DEFAULT_RETROARCH_AUTOSAVE_SECONDS = 10;

/** The header the generated config carries, so anyone who opens one knows
 *  where it came from and that editing it is pointless. */
const GENERATED_HEADER = [
  "# Written by RomM Desktop before each launch that syncs saves. Layered over",
  "# your own settings with --appendconfig, so nothing here changes your",
  "# retroarch.cfg. Editing it is pointless.",
];

/**
 * Where the generated config lives.
 *
 * Beside the saves it exists for, under a dotted directory: a game's directory
 * is named with the ROM id, so no launch can resolve to this name and collide
 * with it.
 */
export function autosaveConfigPath(saveDataPath: string): string {
  return join(saveDataPath, ".retroarch", "autosave.cfg");
}

/**
 * The config that asks RetroArch to write SRAM every `seconds`.
 *
 * Null when there is nothing to ask for, which is not the same as a file that
 * asks for nothing: an interval of zero is the user saying to leave their own
 * setting as it is, so the file is not named at all rather than named and
 * empty.
 */
export function retroarchAutosaveConfig(seconds: number): string | null {
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  return [...GENERATED_HEADER, `autosave_interval = "${seconds}"`, ""].join(
    "\n",
  );
}

/** Coerce the configured interval, the way minimumPlayMs does: zero is the user
 *  asking the shell to leave the setting alone, and anything that is not a whole
 *  number of seconds is not an answer, so the default stands. */
export function autosaveSeconds(seconds: number | null | undefined): number {
  if (seconds === 0) return 0;
  return Number.isInteger(seconds) && (seconds as number) > 0
    ? (seconds as number)
    : DEFAULT_RETROARCH_AUTOSAVE_SECONDS;
}

/**
 * Write the config for this launch and hand back its path, or null when there
 * is nothing to append.
 *
 * Rewritten every launch rather than once, so a changed setting takes effect on
 * the next game rather than on the next install. Nothing here can fail a
 * launch: without the file RetroArch keeps its own interval, which is where it
 * was.
 */
export async function writeAutosaveConfig(
  saveDataPath: string,
  seconds: number,
): Promise<string | null> {
  const contents = retroarchAutosaveConfig(seconds);
  if (!contents) return null;

  const target = autosaveConfigPath(saveDataPath);
  // An --appendconfig list is delimited by "|", with no escape for one inside a
  // path. Declining costs the interval; naming it anyway would cost the
  // firmware config appended beside it.
  if (target.includes("|")) return null;

  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    return target;
  } catch {
    return null;
  }
}
