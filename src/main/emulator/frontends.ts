// Emulators that a frontend keeps in a tree of its own.
//
// RetroBat, ES-DE and EmuDeck each ship RetroArch and the standalone emulators
// in one folder, one subfolder per emulator. Their emulators are perfectly
// good ones, and finding them beats asking someone to configure what they
// already installed. What varies between them is only the subfolder and
// executable names, so this is one table rather than a path per frontend in
// every emulator's list.
//
// The names come from the frontends themselves: RetroBat's emulatorLauncher,
// ES-DE's es_find_rules.xml, and EmuDeck's own documentation, which installs
// into ES-DE's layout. All three are Windows-only. On Linux EmuDeck uses
// Flatpaks and AppImages, which the standalone table already looks for.
//
// The folder is looked for in two places: the one the user chose
// (`emulatorsBasePath`), which outranks every standard install location, and
// each frontend's default root, which comes after them. A frontend is a
// deliberate choice when picked and a guess otherwise.
//
// Platform, home and environment are parameters, like the rest of detection,
// so the Windows paths can be checked from any machine.

import { win32 } from "node:path";

interface Layout {
  /** Subfolders an emulators folder may keep it in. Matched as Windows does,
   *  without regard to case, so "RetroArch" also covers "retroarch". */
  dirs: string[];
  /** Executable names, most likely first. */
  executables: string[];
}

const LAYOUTS: Record<string, Layout> = {
  retroarch: {
    // RetroBat, then ES-DE's two spellings.
    dirs: ["retroarch", "RetroArch-Win64"],
    executables: ["retroarch.exe"],
  },
  pcsx2: {
    dirs: ["pcsx2", "PCSX2-Qt"],
    // RetroBat's own list. The suffixed names are older builds, one per CPU
    // feature level, and EmuDeck still installs pcsx2-qtx64.exe.
    executables: [
      "pcsx2-qt.exe",
      "pcsx2-qtx64.exe",
      "pcsx2-qtx64-avx2.exe",
      "pcsx2-qtx64-sse4.exe",
    ],
  },
  dolphin: {
    dirs: ["dolphin-emu", "Dolphin-x64"],
    executables: ["Dolphin.exe"],
  },
  rpcs3: { dirs: ["rpcs3"], executables: ["rpcs3.exe"] },
  cemu: { dirs: ["cemu"], executables: ["Cemu.exe"] },
};

/** The emulator ids a frontend's folder can hold. */
export const FRONTEND_EMULATOR_IDS: readonly string[] = Object.keys(LAYOUTS);

/**
 * The folders under a chosen one that may hold the emulators.
 *
 * Whichever level someone picks: the frontend's root (D:\RetroBat), its
 * emulators folder (D:\RetroBat\emulators), or EmuDeck's profile folder,
 * whose emulators sit two levels down.
 */
function emulatorFolders(chosen: string): string[] {
  return [
    win32.join(chosen, "emulators"),
    win32.join(chosen, "EmulationStation-DE\\Emulators"),
    chosen,
  ];
}

/** The emulator's own folder, picked directly, which holds the executable
 *  with no subfolder around it. */
function directly(emulatorId: string, chosen: string): string[] {
  return (LAYOUTS[emulatorId]?.executables ?? []).map((executable) =>
    win32.join(chosen, executable),
  );
}

/** Where each frontend puts its emulators when installed with its defaults. */
function defaultFolders(home: string, env: NodeJS.ProcessEnv): string[] {
  return [
    "C:\\RetroBat\\emulators",
    win32.join(env.USERPROFILE ?? home, "emudeck\\EmulationStation-DE\\Emulators"),
  ];
}

function inFolders(emulatorId: string, folders: string[]): string[] {
  const layout = LAYOUTS[emulatorId];
  if (!layout) return [];
  const paths: string[] = [];
  for (const folder of folders) {
    for (const dir of layout.dirs) {
      for (const executable of layout.executables) {
        paths.push(win32.join(folder, dir, executable));
      }
    }
  }
  return paths;
}

export interface FrontendCandidates {
  /** Under the folder the user chose, which outranks a standard install. */
  chosen: string[];
  /** Under each frontend's default root, which does not. */
  defaults: string[];
}

/** Where a frontend may keep this emulator, split by how sure that is. */
export function frontendCandidates(
  emulatorId: string,
  basePath: string | null,
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): FrontendCandidates {
  if (platform !== "win32") return { chosen: [], defaults: [] };
  const chosen = basePath
    ? [
        ...inFolders(emulatorId, emulatorFolders(basePath)),
        ...directly(emulatorId, basePath),
      ]
    : [];
  return {
    chosen,
    defaults: inFolders(emulatorId, defaultFolders(home, env)),
  };
}

/**
 * The emulators a chosen folder holds, by id.
 *
 * Asked before a folder is saved, so picking the wrong one says so at once
 * instead of leaving a setting that silently finds nothing.
 */
export function emulatorsInFolder(
  folder: string,
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string[] {
  return FRONTEND_EMULATOR_IDS.filter((id) =>
    frontendCandidates(id, folder, platform, home, env).chosen.some(exists),
  );
}
