// Where RetroArch and its cores live on each platform.
//
// Split out of config.ts and given platform, home and environment as
// parameters rather than reading them from the process: these are three
// different sets of paths that a contributor can only ever exercise one of, and
// getting one wrong is a silent failure to find an install that is right there.
// As parameters they can all be checked from any machine.

import { win32, posix } from "node:path";

// Each branch joins with its own platform's separator -- win32 for the Windows
// paths, posix for the rest -- rather than with node:path's default, which
// follows the host. It never differs in production, where the two agree, but it
// made the Windows branch impossible to check anywhere except Windows, which is
// exactly the branch most likely to be wrong.

/** Common install locations, most specific first. */
export function retroarchCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  switch (platform) {
    case "darwin":
      return [
        "/Applications/RetroArch.app/Contents/MacOS/RetroArch",
        posix.join(home, "Applications/RetroArch.app/Contents/MacOS/RetroArch"),
      ];
    case "win32": {
      const p = win32;
      // RetroArch ships portable about as often as it is installed, and
      // frontends bundle their own copy, so cover the usual roots. An install
      // on another drive still needs retroarchPath set by hand.
      const programFiles = env.ProgramFiles ?? "C:\\Program Files";
      const programFilesX86 =
        env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      const localAppData = env.LOCALAPPDATA ?? p.join(home, "AppData\\Local");
      return [
        "C:\\RetroArch-Win64\\retroarch.exe",
        p.join(programFiles, "RetroArch\\retroarch.exe"),
        p.join(programFilesX86, "RetroArch\\retroarch.exe"),
        p.join(localAppData, "Programs\\RetroArch\\retroarch.exe"),
        p.join(home, "scoop\\apps\\retroarch\\current\\retroarch.exe"),
        p.join(
          programFilesX86,
          "Steam\\steamapps\\common\\RetroArch\\retroarch.exe",
        ),
        p.join(
          programFiles,
          "Steam\\steamapps\\common\\RetroArch\\retroarch.exe",
        ),
        "C:\\RetroBat\\emulators\\retroarch\\retroarch.exe",
      ];
    }
    default:
      return [
        "/usr/bin/retroarch",
        "/usr/local/bin/retroarch",
        posix.join(home, ".local/bin/retroarch"),
      ];
  }
}

/** Directories that may already hold cores, most specific first. */
export function coresCandidates(
  retroarchPath: string | null,
  platform: NodeJS.Platform = process.platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  switch (platform) {
    case "darwin":
      return [posix.join(home, "Library/Application Support/RetroArch/cores")];
    case "win32": {
      const p = win32;
      // A portable install keeps cores beside the binary; an installed one puts
      // them under the user profile. Probe both, so the cores directory can
      // still be found when the binary was set by hand or not found at all.
      const appData = env.APPDATA ?? p.join(home, "AppData\\Roaming");
      const localAppData = env.LOCALAPPDATA ?? p.join(home, "AppData\\Local");
      return [
        ...(retroarchPath ? [p.join(p.dirname(retroarchPath), "cores")] : []),
        p.join(appData, "RetroArch\\cores"),
        p.join(localAppData, "RetroArch\\cores"),
      ];
    }
    default:
      return [
        posix.join(home, ".config/retroarch/cores"),
        posix.join(
          home,
          ".var/app/org.libretro.RetroArch/config/retroarch/cores",
        ),
        "/usr/lib/libretro",
        "/usr/lib/x86_64-linux-gnu/libretro",
      ];
  }
}

/**
 * Where cores should go when RetroArch is installed but has no cores directory
 * yet, which is every RetroArch that has not been run once.
 *
 * Without this a fresh install is a dead end: no directory means no
 * retroarchCoresPath, which means core downloading stays switched off until the
 * user has opened RetroArch themselves, right after the shell has walked them
 * through installing it. The directory itself is created when the first core is
 * written, not here.
 *
 * Only offered for an install this shell recognised. A hand-configured emulator
 * -- a Flatpak RetroArch, whose sandbox could not read these paths anyway --
 * keeps needing retroarchCoresPath set, rather than being handed a guess that
 * silently does not work.
 *
 * Deliberately the writable per-user location rather than a portable layout
 * beside the binary: an installed RetroArch on Windows reads the former, and
 * the latter usually sits somewhere that needs an administrator. An install
 * that really is portable ships a cores directory already, so coresCandidates
 * finds it and this never runs.
 */
export function defaultCoresPath(
  retroarchPath: string | null,
  platform: NodeJS.Platform = process.platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!retroarchPath) return null;
  switch (platform) {
    case "darwin":
      return posix.join(home, "Library/Application Support/RetroArch/cores");
    case "win32":
      return win32.join(
        env.APPDATA ?? win32.join(home, "AppData\\Roaming"),
        "RetroArch\\cores",
      );
    default:
      return posix.join(home, ".config/retroarch/cores");
  }
}
