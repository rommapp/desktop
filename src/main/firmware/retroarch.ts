// Supply RetroArch's own system directory from RomM's firmware mirror.
//
// The mirror used to reach RetroArch by replacing system_directory for the
// launch, through the generated config layered on with --appendconfig. That
// works when the mirror is the only firmware there is, and hides everything
// else when it is not. A system directory holds the user's whole collection:
// BIOS files RomM has never been given, and the assets some cores keep there
// (PPSSPP's, ScummVM's, Dolphin's Sys tree). A frontend makes that the normal
// case, since RetroBat's bios folder or EmuDeck's Emulation/bios is where a
// user has put everything. One BIOS uploaded to RomM for a platform then left
// that platform's launch able to see only that one file.
//
// So this does what the standalone emulators already get: the mirrored files
// are copied into the directory RetroArch's own config names, a file already
// there wins, and nothing of the user's settings is edited. The launch then
// passes no system_directory of its own.
//
// Replacing the directory remains the answer when the config cannot say where
// it is: none found, unreadable, a value this cannot resolve, or "default",
// which RetroArch takes to mean the content's own folder and so has no one
// place to copy to. It is also still what a hand-written row asks for with
// "{biosconfig}", since the shell cannot know which RetroArch such a row runs.
//
// The path logic is pure and takes platform, home and environment as
// parameters, so every platform's answer can be checked from any machine.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { copyIfMissing, type MirrorSummary, mirroredFiles } from "./place.ts";

/** Reads a file's text, or null when it is not there. */
export type ReadText = (path: string) => string | null;

const readTextSafe: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const FLATPAK_ID = "org.libretro.RetroArch";

/**
 * Where RetroArch reads retroarch.cfg from, given the executable, most
 * specific first.
 *
 * On Windows a retroarch.cfg beside the executable is the one used, which is
 * how every portable and frontend-bundled copy keeps its settings; an install
 * without one falls back to the profile. Elsewhere it is the platform's
 * config folder, or the Flatpak sandbox's copy of it.
 */
export function retroarchConfigCandidates(
  retroarchPath: string,
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string[] {
  switch (platform) {
    case "win32":
      return [
        win32.join(win32.dirname(retroarchPath), "retroarch.cfg"),
        win32.join(
          env.APPDATA ?? win32.join(home, "AppData\\Roaming"),
          "RetroArch\\retroarch.cfg",
        ),
      ];
    case "darwin":
      return [
        posix.join(
          home,
          "Library/Application Support/RetroArch/config/retroarch.cfg",
        ),
      ];
    default:
      if (posix.basename(retroarchPath) === FLATPAK_ID) {
        return [
          posix.join(
            home,
            `.var/app/${FLATPAK_ID}/config/retroarch/retroarch.cfg`,
          ),
        ];
      }
      return [
        posix.join(
          env.XDG_CONFIG_HOME || posix.join(home, ".config"),
          "retroarch/retroarch.cfg",
        ),
      ];
  }
}

/**
 * The system directory a retroarch.cfg names, as an absolute path, or null
 * when it names none this can use.
 *
 * RetroArch writes `key = "value"`. A value starting with ":" is relative to
 * the executable's folder, which is how a portable install spells it, and "~"
 * is the home folder. "default", an empty value and any other relative path
 * are declined.
 */
export function systemDirectoryFrom(
  cfg: string,
  retroarchPath: string,
  platform: NodeJS.Platform,
  home: string,
): string | null {
  const path = platform === "win32" ? win32 : posix;
  let value: string | null = null;
  // The last one wins, as it does when RetroArch reads the file.
  for (const line of cfg.split(/\r?\n/)) {
    const match = /^\s*system_directory\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (match) value = match[1] ?? "";
  }
  if (!value || value === "default") return null;
  if (value.startsWith(":")) {
    return path.join(path.dirname(retroarchPath), value.slice(1));
  }
  if (value.startsWith("~")) return path.join(home, value.slice(1));
  return win32.isAbsolute(value) || posix.isAbsolute(value) ? value : null;
}

/** The system directory this RetroArch is configured with, or null. */
export function retroarchSystemDirectory(options: {
  retroarchPath: string;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  read?: ReadText;
}): string | null {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const read = options.read ?? readTextSafe;
  for (const candidate of retroarchConfigCandidates(
    options.retroarchPath,
    platform,
    home,
    options.env ?? process.env,
  )) {
    const cfg = read(candidate);
    // The first config that exists is the one RetroArch uses, whatever it
    // says; a later candidate is not a fallback for a value it lacks.
    if (cfg !== null) {
      return systemDirectoryFrom(cfg, options.retroarchPath, platform, home);
    }
  }
  return null;
}

/**
 * Copy the mirror into RetroArch's own system directory. Returns that
 * directory when the launch can rely on it, or null when the launch should
 * point RetroArch at the mirror instead.
 *
 * A directory that does not exist is declined rather than created: the
 * config naming one nobody has made is more likely stale than meant.
 */
export async function supplyRetroArchFirmware(options: {
  retroarchPath: string;
  mirror: MirrorSummary | null;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  read?: ReadText;
  exists?: (path: string) => boolean;
}): Promise<{ directory: string; copied: number } | null> {
  const { mirror } = options;
  if (!mirror || mirror.count === 0) return null;
  const directory = retroarchSystemDirectory(options);
  if (!directory || !(options.exists ?? existsSync)(directory)) return null;
  let copied = 0;
  for (const name of await mirroredFiles(mirror.directory)) {
    if (await copyIfMissing(join(mirror.directory, name), directory, name)) {
      copied++;
    }
  }
  return { directory, copied };
}
