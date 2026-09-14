// Standalone emulators the shell can find on its own.
//
// RetroAchievements only recognises the standalone PCSX2 and Dolphin, not their
// libretro cores, so for PS2 and GameCube/Wii there is no core that will ever
// unlock an achievement. The emulators config has always been able to point at
// them; what nobody can reasonably do is guess the executable name and argument
// template, which is the part that keeps people stuck.
//
// So this is the same idea as detecting RetroArch, extended: probe the usual
// locations, and launch what is there. It carries no downloading and no
// configuration writing -- an emulator installed by any means, a package
// manager or a frontend's own tree, is found the same way.
//
// Platform, home and environment are parameters rather than read from the
// process, so all three platforms' paths can be exercised from any machine.

import { existsSync, readdirSync } from "node:fs";
import { posix, win32 } from "node:path";
import { type EmulatorMapping } from "../../shared/types.ts";

export interface StandaloneEmulator {
  /** Stable identifier, used in config and messages. */
  id: string;
  label: string;
  /** RomM platform slugs this emulator is used for. */
  platformSlugs: string[];
  /** Argument template, in the same form an emulators entry takes. */
  args: string[];
  /** Where it lands on each platform, most likely first. */
  paths(
    platform: NodeJS.Platform,
    home: string,
    env: NodeJS.ProcessEnv,
    readDir: ReadDir,
  ): string[];
}

/** Entries of a directory, or none when it cannot be read. */
export type ReadDir = (directory: string) => string[];

const readDirSafe: ReadDir = (directory) => {
  try {
    return readdirSync(directory);
  } catch {
    // /Applications always exists; ~/Applications often does not.
    return [];
  }
};

/**
 * A .app bundle in either of the two places macOS puts them.
 *
 * Scanned rather than named, because the bundle carries its version: PCSX2
 * ships PCSX2-v2.8.2.app, so the path changes with every release and no fixed
 * string can match it. The binary inside is stable, so the version only affects
 * the directory around it.
 */
function macApp(
  home: string,
  bundle: string,
  binary: string,
  readDir: ReadDir,
): string[] {
  const roots = ["/Applications", posix.join(home, "Applications")];
  const found: string[] = [];
  for (const root of roots) {
    for (const entry of readDir(root)) {
      if (!entry.endsWith(".app")) continue;
      const name = entry.slice(0, -".app".length);
      if (!name.startsWith(bundle)) continue;
      // "PCSX2", "PCSX2-v2.8.2" and "PCSX2 2.8" all count; "PCSX2Something"
      // does not, so a differently named application cannot be mistaken for it.
      const suffix = name.slice(bundle.length);
      if (suffix !== "" && !/^[-_ ]/.test(suffix)) continue;
      found.push(posix.join(root, entry, "Contents/MacOS", binary));
    }
  }
  return found;
}

/** A Flatpak's exported launcher, system-wide and per-user. */
function flatpak(home: string, appId: string): string[] {
  return [
    `/var/lib/flatpak/exports/bin/${appId}`,
    posix.join(home, `.local/share/flatpak/exports/bin/${appId}`),
  ];
}

export const STANDALONE_EMULATORS: StandaloneEmulator[] = [
  {
    id: "pcsx2",
    label: "PCSX2",
    platformSlugs: ["ps2"],
    // -batch skips the GUI and exits when the game stops, which is what the
    // shell wants: the window comes back rather than a launcher being left open.
    args: ["-batch", "{rom}"],
    paths(platform, home, env, readDir) {
      switch (platform) {
        case "darwin":
          return macApp(home, "PCSX2", "PCSX2", readDir);
        case "win32": {
          const programFiles = env.ProgramFiles ?? "C:\\Program Files";
          const localAppData =
            env.LOCALAPPDATA ?? win32.join(home, "AppData\\Local");
          return [
            win32.join(programFiles, "PCSX2\\pcsx2-qt.exe"),
            win32.join(localAppData, "Programs\\PCSX2\\pcsx2-qt.exe"),
            win32.join(home, "scoop\\apps\\pcsx2\\current\\pcsx2-qt.exe"),
            // A frontend's own tree. Its emulators are perfectly good ones, and
            // finding them beats asking someone to configure what they already
            // installed.
            "C:\\RetroBat\\emulators\\pcsx2\\pcsx2-qt.exe",
          ];
        }
        default:
          return [
            "/usr/bin/pcsx2-qt",
            "/usr/local/bin/pcsx2-qt",
            ...flatpak(home, "net.pcsx2.PCSX2"),
          ];
      }
    },
  },
  {
    id: "dolphin",
    label: "Dolphin",
    // One emulator, two platforms, so both slugs get a row.
    platformSlugs: ["ngc", "wii"],
    // -b exits when the game stops; -e names the file to run.
    args: ["-b", "-e", "{rom}"],
    paths(platform, home, env, readDir) {
      switch (platform) {
        case "darwin":
          return macApp(home, "Dolphin", "Dolphin", readDir);
        case "win32": {
          const programFiles = env.ProgramFiles ?? "C:\\Program Files";
          const localAppData =
            env.LOCALAPPDATA ?? win32.join(home, "AppData\\Local");
          return [
            win32.join(programFiles, "Dolphin\\Dolphin.exe"),
            win32.join(localAppData, "Programs\\Dolphin\\Dolphin.exe"),
            win32.join(home, "scoop\\apps\\dolphin\\current\\Dolphin.exe"),
            "C:\\RetroBat\\emulators\\dolphin-emu\\Dolphin.exe",
          ];
        }
        default:
          return [
            "/usr/bin/dolphin-emu",
            "/usr/games/dolphin-emu",
            "/usr/local/bin/dolphin-emu",
            ...flatpak(home, "org.DolphinEmu.dolphin-emu"),
          ];
      }
    },
  },
];

export interface DetectedEmulator {
  emulator: StandaloneEmulator;
  command: string;
}

/**
 * Find the standalone emulators that are actually installed.
 *
 * Only ever reads: nothing is downloaded and no config is written. An emulator
 * that is not there is simply not offered, so a machine without one behaves
 * exactly as it did before.
 */
export function detectStandalone(
  platform: NodeJS.Platform = process.platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  readDir: ReadDir = readDirSafe,
  only?: ReadonlySet<string>,
): DetectedEmulator[] {
  const found: DetectedEmulator[] = [];
  for (const emulator of STANDALONE_EMULATORS) {
    if (only && !only.has(emulator.id)) continue;
    const command = emulator.paths(platform, home, env, readDir).find(exists);
    if (command) found.push({ emulator, command });
  }
  return found;
}

/**
 * The emulators row a detected emulator stands in for.
 *
 * Shaped exactly like one written by hand, so a detected emulator and a
 * configured one travel the same path from here on and there is no second
 * launch mechanism to keep in step.
 */
export function toEmulatorMappings(
  detected: DetectedEmulator[],
): EmulatorMapping[] {
  return detected.flatMap(({ emulator, command }) =>
    emulator.platformSlugs.map((platformSlug) => ({
      platformSlug,
      command,
      args: emulator.args,
      label: emulator.label,
    })),
  );
}

/**
 * Detection is repeated far more often than it changes.
 *
 * findMapping runs several times per launch and once per platform the frontend
 * probes, and each pass is a directory scan and a handful of existsSync calls
 * per emulator.
 *
 * Remembered per emulator, not in one lump. Remembering "something was found"
 * would stop the ones that were not found from ever being looked for again --
 * so installing PCSX2 on a machine that already had Dolphin would go unnoticed
 * until a restart, which is exactly the case this has to handle.
 */
let memo: { key: string; found: Map<string, DetectedEmulator> } | null = null;

function detectStandaloneCached(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  readDir: ReadDir = readDirSafe,
): DetectedEmulator[] {
  const key = `${platform}\u0000${home}`;
  if (!memo || memo.key !== key) memo = { key, found: new Map() };

  // Only the ones not already found are looked for again.
  const missing = new Set(
    STANDALONE_EMULATORS.map((entry) => entry.id).filter(
      (id) => !memo!.found.has(id),
    ),
  );
  if (missing.size > 0) {
    for (const detected of detectStandalone(
      platform,
      home,
      env,
      exists,
      readDir,
      missing,
    )) {
      memo.found.set(detected.emulator.id, detected);
    }
  }
  // Kept in table order, so two emulators never swap places between calls.
  return STANDALONE_EMULATORS.map((entry) => memo!.found.get(entry.id)).filter(
    (entry): entry is DetectedEmulator => entry !== undefined,
  );
}

/** Forget the memo, so a test can change what is on disk between cases. */
export function resetStandaloneDetection(): void {
  memo = null;
}

/** The detected row for one platform, or null when nothing was found. */
export function detectedMappingFor(
  platformSlug: string,
  platform: NodeJS.Platform = process.platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  readDir: ReadDir = readDirSafe,
): EmulatorMapping | null {
  const wanted = platformSlug.toLowerCase();
  return (
    toEmulatorMappings(
      detectStandaloneCached(platform, home, env, exists, readDir),
    ).find((mapping) => mapping.platformSlug === wanted) ?? null
  );
}

/** Which standalone emulator, if any, serves this platform. */
export function emulatorForPlatform(platformSlug: string): string | null {
  const wanted = platformSlug.toLowerCase();
  return (
    STANDALONE_EMULATORS.find((entry) => entry.platformSlugs.includes(wanted))
      ?.id ?? null
  );
}
