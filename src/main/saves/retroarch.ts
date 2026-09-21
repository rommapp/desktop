// What the shell asks RetroArch for, for the length of one launch.
//
// Two things, and neither can be asked for any other way. The shell cannot tell
// a running emulator to flush its SRAM: there is no flag and no IPC for it,
// unlike the browser player, which calls EmulatorJS' saveSaveFiles() every
// second. And RetroArch has a flag for starting fullscreen but none for
// starting windowed, so a launch that asks not to be fullscreen has only the
// setting to say it with.
//
// Without the first, RetroArch writes the save once, when the content closes,
// and that is a single moment to miss: a crash, a kill, or a launcher that
// exits before the emulator does all leave the file holding whatever the pull
// put there, and a launch that wrote a save reports having moved nothing.
//
// Layered with --appendconfig, like the firmware mirror's system_directory, so
// the user's own retroarch.cfg is never edited. Per ROM rather than one file
// for every launch, because what is in it differs per launch: two games running
// at once would otherwise overwrite each other's answer, and a launch reads
// this file as it starts. One game cannot race itself, since a second launch of
// a ROM already running is refused.

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

/**
 * Floor on the interval the shell asks for.
 *
 * RetroArch takes any whole number of seconds, but the watcher looks at a third
 * of the cadence and no oftener than every two seconds, and it has to see the
 * same bytes twice before offering them. Six is the fastest cadence whose third
 * is that floor rather than shorter than it: ask for less and the looks are
 * further apart than the writes, so a game that writes on every flush is never
 * caught at rest and nothing is sent until the exit.
 */
export const MIN_RETROARCH_AUTOSAVE_SECONDS = 6;

/**
 * Ceiling on the interval a hand-edited config can ask for.
 *
 * An hour is already longer than the cadence is useful at, and the number is
 * not only RetroArch's business: the watcher looks at a fraction of it, so an
 * absurd value here becomes an absurd timer there.
 */
export const MAX_RETROARCH_AUTOSAVE_SECONDS = 3600;

/** The header the generated config carries, so anyone who opens one knows
 *  where it came from and that editing it is pointless. */
const GENERATED_HEADER = [
  "# Written by RomM Desktop before a launch it has something to ask for.",
  "# Layered over your own settings with --appendconfig, so nothing here",
  "# changes your retroarch.cfg. Editing it is pointless.",
];

/**
 * Where a launch's generated config lives.
 *
 * Beside the saves it sits with, under a dotted directory: a game's own
 * directory is named with the ROM id, so no launch can resolve to this name and
 * collide with it.
 */
export function launchConfigPath(saveDataPath: string, romId: number): string {
  return join(saveDataPath, ".retroarch", `launch-${romId}.cfg`);
}

/** What a launch has to say to the emulator it is about to start. */
export interface LaunchSettings {
  /** How often to write the save, or zero to leave RetroArch's own interval
   *  alone. */
  autosaveSeconds: number;
  /** Whether to start fullscreen. Undefined asks for nothing, which is what
   *  leaves the user's own setting to decide. */
  fullscreen?: boolean;
  /** Where this game's saves and states belong. Undefined leaves the
   *  directories to the user's own settings. */
  saveDir?: string;
  stateDir?: string;
}

/**
 * Where a launch's save data belongs, as settings rather than as flags.
 *
 * `-s` and `-S` name the files, which is what the shell wants, but they are
 * deprecated and lose: a `savefile_directory`, a sorting option or "save files
 * in content directory" in the user's own retroarch.cfg redirects the write
 * while the read still comes from the named file, so a game loads the shell's
 * save and writes its own somewhere else, and the launch reports the save as
 * unchanged for the rest of time. A config appended for this run is the one
 * thing that outranks those settings.
 *
 * So the directory is pinned here and every redirect off it is turned off. The
 * name is RetroArch's own (it derives one from the content), which is why the
 * flags stay too: where the two agree, the file is the one the shell pulled
 * into place.
 */
function saveDirectoryLines(settings: LaunchSettings): string[] {
  const { saveDir, stateDir } = settings;
  const lines: string[] = [];

  // A retroarch.cfg value is a quoted string with no escape for a quote inside
  // it, so a path holding one cannot be named at all. Saying nothing leaves the
  // user's settings standing, which is where they were.
  if (saveDir && !saveDir.includes('"')) {
    lines.push(
      `savefile_directory = "${saveDir}"`,
      'sort_savefiles_enable = "false"',
      'sort_savefiles_by_content_enable = "false"',
      'savefiles_in_content_dir = "false"',
    );
  }
  if (stateDir && !stateDir.includes('"')) {
    lines.push(
      `savestate_directory = "${stateDir}"`,
      'sort_savestates_enable = "false"',
      'sort_savestates_by_content_enable = "false"',
      'savestates_in_content_dir = "false"',
    );
  }
  return lines;
}

/**
 * The config for one launch, or null when it would set nothing.
 *
 * A file that asks for nothing is not the same as no file: an interval of zero,
 * an unanswered display mode and no directories to pin are all the user's own
 * settings standing, so the launch names no config at all rather than naming an
 * empty one.
 *
 * `video_fullscreen` is written for both answers, not just for "no". The flag
 * covers starting fullscreen, but nothing on the command line can ask for the
 * opposite, and a switch the page turned off has to mean something on a machine
 * whose retroarch.cfg turns fullscreen on.
 */
export function retroarchLaunchConfig(settings: LaunchSettings): string | null {
  const lines: string[] = [];

  const { autosaveSeconds, fullscreen } = settings;
  if (Number.isInteger(autosaveSeconds) && autosaveSeconds > 0) {
    lines.push(`autosave_interval = "${autosaveSeconds}"`);
  }
  if (fullscreen !== undefined) {
    lines.push(`video_fullscreen = "${fullscreen ? "true" : "false"}"`);
  }
  lines.push(...saveDirectoryLines(settings));

  if (lines.length === 0) return null;
  return [...GENERATED_HEADER, ...lines, ""].join("\n");
}

/** Coerce the configured interval, the way minimumPlayMs does: zero is the user
 *  asking the shell to leave the setting alone, anything that is not a whole
 *  number of seconds is not an answer, and the bounds are what keep a
 *  hand-edited number from becoming a cadence the watcher cannot work with. */
export function autosaveSeconds(seconds: number | null | undefined): number {
  if (seconds === 0) return 0;
  if (!Number.isInteger(seconds) || (seconds as number) < 0) {
    return DEFAULT_RETROARCH_AUTOSAVE_SECONDS;
  }
  return Math.min(
    Math.max(seconds as number, MIN_RETROARCH_AUTOSAVE_SECONDS),
    MAX_RETROARCH_AUTOSAVE_SECONDS,
  );
}

/**
 * Write this launch's config and hand back its path, or null when there is
 * nothing to append.
 *
 * Rewritten every launch rather than once, so a changed setting takes effect on
 * the next game rather than on the next install. Nothing here can fail a
 * launch: without the file RetroArch keeps its own settings, which is where
 * they were.
 */
export async function writeLaunchConfig(
  saveDataPath: string,
  romId: number,
  settings: LaunchSettings,
): Promise<string | null> {
  const contents = retroarchLaunchConfig(settings);
  if (!contents) return null;

  const target = launchConfigPath(saveDataPath, romId);
  // An --appendconfig list is delimited by "|", with no escape for one inside a
  // path. Declining costs these settings; naming it anyway would cost the
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
