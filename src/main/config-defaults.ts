// What the shell fills in for a config value the user left unset.
//
// Kept apart from config.ts, and free of Electron imports, so it can be tested:
// config.ts needs `app` for the userData directory, which a test cannot load.
//
// The values here are never written back to desktop-config.json. A detected
// path saved into the file would read as one the user chose on every load
// after, and a chosen path outranks detection: a RetroArch found in Program
// Files on the first run would then outrank an emulator folder picked later,
// and an uninstalled one would never be looked for again. So the file holds
// only what the user set, and this view is rebuilt from it on every read.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DesktopConfig } from "../shared/types.ts";
import {
  coresCandidates,
  defaultCoresPath,
  retroarchCandidates,
} from "./emulator/locations.ts";

export interface DetectionContext {
  home: string;
  /** Electron's userData directory, which the unset storage paths sit in. */
  userData: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/** The config with every unset path filled in from the filesystem. */
export function withDetectedDefaults(
  config: DesktopConfig,
  context: DetectionContext,
): DesktopConfig {
  const { home, userData } = context;
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const exists = context.exists ?? existsSync;
  const firstExisting = (paths: string[]) => paths.find(exists) ?? null;

  const retroarchPath =
    config.retroarchPath ??
    firstExisting(
      retroarchCandidates(platform, home, env, config.emulatorsBasePath),
    );
  return {
    ...config,
    retroarchPath,
    // Falling back to where cores belong, not just where they already are: a
    // RetroArch that has never been run has no cores directory, and treating
    // that as "nowhere to put cores" would switch core downloading off for
    // exactly the fresh install the shell may have just offered to set up.
    retroarchCoresPath:
      config.retroarchCoresPath ??
      firstExisting(coresCandidates(retroarchPath, platform, home, env)) ??
      defaultCoresPath(retroarchPath, platform, home, env),
    cachePath: config.cachePath ?? join(userData, "rom-cache"),
    biosPath: config.biosPath ?? join(userData, "bios"),
    saveDataPath: config.saveDataPath ?? join(userData, "save-data"),
  };
}
