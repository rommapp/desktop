// Standalone emulators the shell can find on its own.
//
// Two reasons a platform ends up here. RetroAchievements only recognises the
// standalone PCSX2 and Dolphin, not their libretro cores, so for PS2 and
// GameCube/Wii there is no core that will ever unlock an achievement. PS3 and
// Wii U are simpler still: libretro has no core for either, so RetroArch cannot
// play them at all and RPCS3 and Cemu are the only way they launch.
//
// The emulators config has always been able to point at all four; what nobody
// can reasonably do is guess the executable name and argument template, which
// is the part that keeps people stuck.
//
// So this is the same idea as detecting RetroArch, extended: probe the usual
// locations, and launch what is there. It carries no downloading and no
// configuration writing -- an emulator installed by any means, a package
// manager or a frontend's own tree, is found the same way.
//
// Platform, home and environment are parameters rather than read from the
// process, so all three platforms' paths can be exercised from any machine.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { type EmulatorMapping } from "../../shared/types.ts";
import { compareVersions } from "../version.ts";

export interface StandaloneEmulator {
  /** Stable identifier, used in config and messages. */
  id: string;
  label: string;
  /** RomM platform slugs this emulator is used for. */
  platformSlugs: string[];
  /** Argument template, in the same form an emulators entry takes. */
  args: string[];
  /** Whether it boots an .m3u playlist, for a multi-disc game. */
  playlist: boolean;
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
  const found: { path: string; version: string | null }[] = [];
  for (const root of roots) {
    for (const entry of readDir(root)) {
      if (!entry.endsWith(".app")) continue;
      const name = entry.slice(0, -".app".length);
      if (!name.startsWith(bundle)) continue;
      // The bare name, or the name and a version: "PCSX2", "PCSX2-v2.8.2" and
      // "PCSX2 2.8" all count. "PCSX2Something" does not, and neither does
      // "PCSX2-Manager" -- a separator alone would let any application whose
      // name begins with this one be launched as the emulator.
      const suffix = name.slice(bundle.length);
      const version = versionIn(suffix);
      if (suffix !== "" && version === null) continue;
      found.push({
        path: posix.join(root, entry, "Contents/MacOS", binary),
        version,
      });
    }
  }
  // A versioned name means an upgrade does not replace the old bundle, so a
  // machine can hold PCSX2-v2.8.2.app and PCSX2-v2.9.0.app at once and the
  // directory order decides nothing. Newest first, so a stale copy left behind
  // does not keep being the one that launches -- and RetroAchievements has
  // minimum versions, which is exactly what launching the old one would fail.
  //
  // The bare name wins outright: it is what Dolphin's disk image installs and
  // updates in place, and someone who has renamed a bundle to it has said which
  // one they mean.
  found.sort((a, b) => {
    if ((a.version === null) !== (b.version === null)) {
      return a.version === null ? -1 : 1;
    }
    if (a.version === null || b.version === null) return 0;
    return compareVersions(b.version, a.version);
  });
  return found.map((entry) => entry.path);
}

/**
 * The version a bundle's name suffix carries, if it is one.
 *
 * Anchored, so the suffix has to *be* a version rather than merely contain a
 * digit somewhere: this is what separates "PCSX2-v2.8.2" from "PCSX2-Manager".
 * Anything after the number is left alone, since a build can add to it.
 */
function versionIn(suffix: string): string | null {
  return /^[-_ ]v?(\d+(?:\.\d+)*)/.exec(suffix)?.[1] ?? null;
}

/** A Flatpak's exported launcher, system-wide and per-user. */
function flatpak(home: string, appId: string): string[] {
  return [
    `/var/lib/flatpak/exports/bin/${appId}`,
    posix.join(home, `.local/share/flatpak/exports/bin/${appId}`),
  ];
}

/**
 * The two Windows roots an installer picks between, with their defaults.
 *
 * Both are read from the environment rather than assumed, because a machine
 * with Windows on a drive other than C: has neither where this would guess --
 * and every emulator here needs the same pair.
 */
function windowsRoots(home: string, env: NodeJS.ProcessEnv) {
  return {
    programFiles: env.ProgramFiles ?? "C:\\Program Files",
    localAppData: env.LOCALAPPDATA ?? win32.join(home, "AppData\\Local"),
  };
}

export const STANDALONE_EMULATORS: StandaloneEmulator[] = [
  {
    id: "pcsx2",
    label: "PCSX2",
    platformSlugs: ["ps2"],
    // PCSX2 reads no playlist: the request for one was closed as not planned
    // and automatic swapping is still open, so changing disc is by hand.
    playlist: false,
    // -batch exits when the game stops, so the shell's window comes back. Never
    // -nogui, which hides the menu bar a multi-disc game changes disc from.
    args: ["-batch", "{rom}"],
    paths(platform, home, env, readDir) {
      switch (platform) {
        case "darwin":
          return macApp(home, "PCSX2", "PCSX2", readDir);
        case "win32": {
          const { programFiles, localAppData } = windowsRoots(home, env);
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
    playlist: true,
    // -b exits when the game stops; -e names the file to run.
    args: ["-b", "-e", "{rom}"],
    paths(platform, home, env, readDir) {
      switch (platform) {
        case "darwin":
          return macApp(home, "Dolphin", "Dolphin", readDir);
        case "win32": {
          const { programFiles, localAppData } = windowsRoots(home, env);
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
  {
    id: "rpcs3",
    label: "RPCS3",
    platformSlugs: ["ps3"],
    playlist: false,
    // --no-gui boots what it is handed and quits when the game stops, so the
    // shell's window comes back instead of a game list being left behind.
    args: ["--no-gui", "{rom}"],
    paths(platform, home, env, readDir) {
      switch (platform) {
        case "darwin":
          // The bundle is RPCS3.app but the binary inside it is lowercase.
          return macApp(home, "RPCS3", "rpcs3", readDir);
        case "win32": {
          const { programFiles, localAppData } = windowsRoots(home, env);
          return [
            win32.join(programFiles, "RPCS3\\rpcs3.exe"),
            win32.join(localAppData, "Programs\\RPCS3\\rpcs3.exe"),
            win32.join(home, "scoop\\apps\\rpcs3\\current\\rpcs3.exe"),
            "C:\\RetroBat\\emulators\\rpcs3\\rpcs3.exe",
          ];
        }
        default:
          return [
            "/usr/bin/rpcs3",
            "/usr/local/bin/rpcs3",
            ...flatpak(home, "net.rpcs3.RPCS3"),
          ];
      }
    },
  },
  {
    id: "cemu",
    label: "Cemu",
    platformSlugs: ["wiiu"],
    playlist: false,
    // -g names the game to launch. Cemu has no flag that closes it when the
    // game stops, so unlike the other three its window stays until the user
    // closes it -- the launch is still tracked the same way, by the process.
    args: ["-g", "{rom}"],
    paths(platform, home, env, readDir) {
      switch (platform) {
        case "darwin":
          return macApp(home, "Cemu", "Cemu", readDir);
        case "win32": {
          const { programFiles, localAppData } = windowsRoots(home, env);
          return [
            // Cemu's own installer defaults to LOCALAPPDATA\Cemu, not the
            // Programs directory the others use, so that one comes first.
            win32.join(localAppData, "Cemu\\Cemu.exe"),
            win32.join(programFiles, "Cemu\\Cemu.exe"),
            win32.join(localAppData, "Programs\\Cemu\\Cemu.exe"),
            win32.join(home, "scoop\\apps\\cemu\\current\\Cemu.exe"),
            "C:\\RetroBat\\emulators\\cemu\\Cemu.exe",
          ];
        }
        default:
          // Capitalised, which is what Cemu's own build installs: cemu is not
          // it, and a case-insensitive filesystem is not something to count on.
          return [
            "/usr/bin/Cemu",
            "/usr/local/bin/Cemu",
            ...flatpak(home, "info.cemu.Cemu"),
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
      playlist: emulator.playlist,
      emulatorId: emulator.id,
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

  // A remembered path can stop being one: PCSX2-v2.8.2.app becomes
  // PCSX2-v2.9.0.app on the next release, and the bundle the memo names is
  // gone. One stat per emulator found -- the memo exists to avoid the scan and
  // the dozen probes, not this -- and forgetting is enough, because the rescan
  // below then looks for it under whatever it is called now.
  for (const [id, found] of memo.found) {
    if (!exists(found.command)) memo.found.delete(id);
  }

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
  // findMapping asks this for every platform, and detection is a directory scan
  // plus a dozen stats per emulator. Only the handful of platforms in the table
  // above can ever match, so answering from it costs nothing and keeps the scan
  // off the main process for every SNES game in a library.
  if (!emulatorForPlatform(platformSlug)) return null;
  const wanted = platformSlug.toLowerCase();
  return (
    toEmulatorMappings(
      detectStandaloneCached(platform, home, env, exists, readDir),
    ).find((mapping) => mapping.platformSlug === wanted) ?? null
  );
}

/**
 * Whether a named standalone emulator is on this machine now.
 *
 * Asked while the user installs one, so the memo is deliberately dropped
 * first: the whole point of the question is that the answer is expected to
 * change.
 */
export function standaloneIsInstalled(
  emulatorId: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  readDir: ReadDir = readDirSafe,
): boolean {
  resetStandaloneDetection();
  return detectStandalone(platform, home, env, exists, readDir).some(
    ({ emulator }) => emulator.id === emulatorId,
  );
}

/** What to call a standalone emulator in a message, whether or not it is
 *  installed. */
export function standaloneLabel(emulatorId: string): string | null {
  return (
    STANDALONE_EMULATORS.find((entry) => entry.id === emulatorId)?.label ?? null
  );
}

/** Every standalone emulator this machine turns out to have, by label. */
export function detectedStandaloneLabels(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  readDir: ReadDir = readDirSafe,
): string[] {
  return detectStandalone(platform, home, env, exists, readDir).map(
    ({ emulator }) => emulator.label,
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
