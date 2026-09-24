// Where a standalone emulator keeps a game's saves and states.
//
// RetroArch can be told where to write, per launch, and the shell uses that to
// give every game a directory of its own. PCSX2, Dolphin, RPCS3 and Cemu cannot
// be told the same thing without also moving their settings, shaders and
// controller bindings, which live in the same user folder: Dolphin's `-u` and
// Cemu's `-m` exist, but a launch pointed at a folder of its own boots an
// emulator nobody has configured. So their saves are handled where the
// emulator already keeps them, and this is the part that knows where that is.
//
// Three things decide the folder, in order. A path the user configured, for an
// install nothing here can predict. A portable install, which each of these
// marks with a file or folder beside the executable. And otherwise the
// emulator's own default for the platform, including the Flatpak sandbox's
// copy on Linux, which is a different folder from the native package's.
//
// Inside it, each emulator keeps saves and states in folders of fixed names.
// Those are the defaults; PCSX2 and Cemu let the memory card or MLC folder be
// moved in their settings, and a moved one is not followed here yet.
//
// Platform, home and environment are parameters, like the detection beside it,
// so every platform's answer can be exercised from any machine.

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { STANDALONE_EMULATORS } from "../emulator/standalone.ts";

/** Where a data folder came from, for the log. */
export type DataFolderSource =
  | "configured"
  | "portable"
  | "flatpak"
  | "default";

export interface StandaloneData {
  emulatorId: string;
  /** The emulator's user folder. */
  folder: string;
  source: DataFolderSource;
  /** Whether the folder is there. One that is not means the emulator has
   *  never run on this machine, which is not the same as not knowing. */
  exists: boolean;
  /** Where this platform's saves sit inside the folder, "/"-separated. */
  saveRoot: string;
  /** Where its states sit, or null for an emulator that writes none. */
  stateRoot: string | null;
}

interface PathContext {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** The executable a launch runs, which is where a portable install is. */
  command: string;
  exists: (path: string) => boolean;
}

interface EmulatorData {
  /** A portable install's folder, or null when this one is not portable. */
  portable(context: PathContext): string | null;
  /** The default folders, the one the emulator would pick first. */
  defaults(context: PathContext): string[];
  /** The Flatpak's folder, for a launch through its exported launcher. */
  flatpak: string;
  saveRoot(platformSlug: string): string;
  stateRoot: string | null;
}

/** The directory an executable sits in, on the platform it belongs to. */
function executableDir({ platform, command }: PathContext): string {
  return platform === "win32" ? win32.dirname(command) : posix.dirname(command);
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.join(...parts) : posix.join(...parts);
}

function xdg(context: PathContext, variable: string, fallback: string): string {
  return context.env[variable] || posix.join(context.home, fallback);
}

const macSupport = (home: string, name: string) =>
  posix.join(home, "Library/Application Support", name);

/** Windows' Documents folder. A redirected one (OneDrive, a second drive) is
 *  not in the environment, which is what `standaloneDataPaths` is for. */
const documents = ({ env, home }: PathContext) =>
  win32.join(env.USERPROFILE ?? home, "Documents");

const appData = ({ env, home }: PathContext) =>
  env.APPDATA ?? win32.join(home, "AppData\\Roaming");

const DATA: Record<string, EmulatorData> = {
  dolphin: {
    // portable.txt beside the executable puts the user folder in User/ there.
    portable(context) {
      const dir = executableDir(context);
      return context.platform !== "darwin" &&
        context.exists(joinFor(context.platform, dir, "portable.txt"))
        ? joinFor(context.platform, dir, "User")
        : null;
    },
    defaults(context) {
      switch (context.platform) {
        case "darwin":
          return [macSupport(context.home, "Dolphin")];
        case "win32": {
          // An older install's Documents folder is still used while it exists,
          // and a new one goes to AppData.
          const legacy = win32.join(documents(context), "Dolphin Emulator");
          const current = win32.join(appData(context), "Dolphin Emulator");
          return context.exists(legacy) ? [legacy, current] : [current];
        }
        default: {
          // Likewise ~/.dolphin-emu, for as long as it exists.
          const legacy = posix.join(context.home, ".dolphin-emu");
          const current = posix.join(
            xdg(context, "XDG_DATA_HOME", ".local/share"),
            "dolphin-emu",
          );
          return context.exists(legacy) ? [legacy, current] : [current];
        }
      }
    },
    flatpak: ".var/app/org.DolphinEmu.dolphin-emu/data/dolphin-emu",
    // GameCube memory cards and the Wii's own storage are separate trees.
    saveRoot: (platformSlug) => (platformSlug === "wii" ? "Wii/title" : "GC"),
    stateRoot: "StateSaves",
  },
  pcsx2: {
    portable(context) {
      const dir = executableDir(context);
      return context.platform !== "darwin" &&
        ["portable.ini", "portable.txt"].some((marker) =>
          context.exists(joinFor(context.platform, dir, marker)),
        )
        ? dir
        : null;
    },
    defaults(context) {
      switch (context.platform) {
        case "darwin":
          return [macSupport(context.home, "PCSX2")];
        case "win32":
          return [win32.join(documents(context), "PCSX2")];
        default:
          return [
            posix.join(xdg(context, "XDG_CONFIG_HOME", ".config"), "PCSX2"),
          ];
      }
    },
    flatpak: ".var/app/net.pcsx2.PCSX2/config/PCSX2",
    saveRoot: () => "memcards",
    stateRoot: "sstates",
  },
  rpcs3: {
    // Every Windows build keeps its data beside the executable.
    portable: (context) =>
      context.platform === "win32" ? executableDir(context) : null,
    defaults(context) {
      switch (context.platform) {
        case "darwin":
          return [macSupport(context.home, "rpcs3")];
        case "win32":
          return [];
        default:
          return [
            posix.join(xdg(context, "XDG_CONFIG_HOME", ".config"), "rpcs3"),
          ];
      }
    },
    flatpak: ".var/app/net.rpcs3.RPCS3/config/rpcs3",
    saveRoot: () => "dev_hdd0/home/00000001/savedata",
    stateRoot: "savestates",
  },
  cemu: {
    // A portable/ folder beside the executable, or a 1.x install that kept
    // everything there, which its settings.xml gives away.
    portable(context) {
      const dir = executableDir(context);
      const portable = joinFor(context.platform, dir, "portable");
      if (context.exists(portable)) return portable;
      return context.platform === "win32" &&
        context.exists(win32.join(dir, "settings.xml"))
        ? dir
        : null;
    },
    defaults(context) {
      switch (context.platform) {
        case "darwin":
          return [macSupport(context.home, "Cemu")];
        case "win32":
          return [win32.join(appData(context), "Cemu")];
        default:
          return [
            posix.join(xdg(context, "XDG_DATA_HOME", ".local/share"), "Cemu"),
          ];
      }
    },
    flatpak: ".var/app/info.cemu.Cemu/data/Cemu",
    saveRoot: () => "mlc01/usr/save",
    // Cemu has no savestates.
    stateRoot: null,
  },
};

/** The ids this module knows the data of, for the detection table's test. */
export const STANDALONE_DATA_IDS: readonly string[] = Object.keys(DATA);

/** Whether a launch runs a Flatpak, through the launcher its export puts on
 *  the path. */
function isFlatpakLauncher(command: string): boolean {
  return /[/\\]flatpak[/\\]exports[/\\]bin[/\\]/.test(command);
}

/**
 * Where this emulator keeps this platform's saves and states, or null for an
 * emulator this module knows nothing about.
 *
 * Returned even when the folder is not there: an emulator that has never run
 * has nothing to send, but its folder is still where a save from another
 * machine belongs.
 */
export function standaloneData(options: {
  emulatorId: string;
  platformSlug: string;
  command: string;
  configured?: Readonly<Record<string, string>>;
  platform?: NodeJS.Platform;
  home: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): StandaloneData | null {
  const data = DATA[options.emulatorId];
  if (!data) return null;
  const context: PathContext = {
    platform: options.platform ?? process.platform,
    home: options.home,
    env: options.env ?? process.env,
    command: options.command,
    exists: options.exists ?? existsSync,
  };

  const located = ((): { folder: string; source: DataFolderSource } => {
    const configured = options.configured?.[options.emulatorId];
    if (configured) return { folder: configured, source: "configured" };
    const portable = data.portable(context);
    if (portable) return { folder: portable, source: "portable" };
    if (context.platform === "linux" && isFlatpakLauncher(context.command)) {
      return {
        folder: posix.join(context.home, data.flatpak),
        source: "flatpak",
      };
    }
    const defaults = data.defaults(context);
    return {
      folder:
        defaults.find(context.exists) ?? defaults[0] ?? executableDir(context),
      source: "default",
    };
  })();

  return {
    emulatorId: options.emulatorId,
    ...located,
    exists: context.exists(located.folder),
    saveRoot: data.saveRoot(options.platformSlug.toLowerCase()),
    stateRoot: data.stateRoot,
  };
}

/** The id of a standalone emulator this shell knows, or null for any other
 *  string, so a typo in a hand-written row switches nothing on. */
export function knownStandaloneId(id: string | undefined): string | null {
  return id &&
    STANDALONE_EMULATORS.some((entry) => entry.id === id) &&
    id in DATA
    ? id
    : null;
}
