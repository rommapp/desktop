import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type DesktopConfig,
  type EmulatorMapping,
  LaunchError,
} from "../../shared/types.ts";
import { type SavePaths } from "../saves/paths.ts";

/** Fallback row applied to any platform without its own mapping. */
const WILDCARD_SLUG = "*";

/** Core names come from the renderer and end up in a filesystem path, so
 *  anything outside this alphabet is rejected rather than escaped. */
const SAFE_CORE_NAME = /^[a-z0-9_]+$/;

export function isSafeCoreName(core: string): boolean {
  return SAFE_CORE_NAME.test(core);
}

/** Platform is a parameter rather than read straight from process, so the
 *  naming can be exercised for all three from one machine. */
export function coreFileExtension(
  platform: NodeJS.Platform = process.platform,
): string {
  switch (platform) {
    case "darwin":
      return "dylib";
    case "win32":
      return "dll";
    default:
      return "so";
  }
}

export function coreFileName(
  core: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${core}_libretro.${coreFileExtension(platform)}`;
}

export interface ResolvedLaunch {
  command: string;
  args: string[];
  label: string;
}

/**
 * Substitute the launch tokens inside each argv entry. Entries stay separate,
 * so a path containing spaces or quotes can never become extra arguments.
 */
export function applyTokens(
  args: string[],
  tokens: {
    rom: string;
    core: string | null;
    savePaths: SavePaths | null;
  },
): string[] {
  const { savePaths } = tokens;
  const values: Record<string, string> = {
    rom: tokens.rom,
    core: tokens.core ?? "",
    saves: savePaths?.saveDir ?? "",
    states: savePaths?.stateDir ?? "",
    savefile: savePaths?.saveFile ?? "",
    statefile: savePaths?.statePrefix ?? "",
  };
  // One pass with a replacer, never chained replaceAll calls with string
  // replacements: a path is inserted verbatim, and token-looking text inside
  // one is left alone rather than substituted by a later pass.
  return args.map((arg) =>
    arg.replace(TOKEN_PATTERN, (match, name: string) => values[name] ?? match),
  );
}

const TOKEN_PATTERN = /\{(rom|core|saves|states|savefile|statefile)\}/g;

/** The tokens that only mean something once the shell owns the save data. */
const SAVE_TOKENS = ["{saves}", "{states}", "{savefile}", "{statefile}"];

function findMapping(
  config: DesktopConfig,
  platformSlug: string,
): EmulatorMapping | null {
  const exact = config.emulators.find(
    (entry) => entry.platformSlug.toLowerCase() === platformSlug.toLowerCase(),
  );
  if (exact) return exact;
  return (
    config.emulators.find((entry) => entry.platformSlug === WILDCARD_SLUG) ??
    null
  );
}

/** What to call the emulator this platform would use, before a launch has
 *  resolved a core to name alongside it. */
export function emulatorLabel(
  config: DesktopConfig,
  platformSlug: string,
): string {
  const mapping = findMapping(config, platformSlug);
  if (!mapping) return "RetroArch";
  return mapping.label ?? mapping.command;
}

/**
 * Whether the executable this platform would run is actually on disk.
 *
 * Separate from resolveLaunch because a missing core and a missing emulator
 * raise the same error code, and only the first of the two is worth trying to
 * fix by downloading something.
 */
export function emulatorIsPresent(
  config: DesktopConfig,
  platformSlug: string,
): boolean {
  const mapping = findMapping(config, platformSlug);
  if (mapping) {
    return existsSync(
      resolveEmulatorCommand(mapping.command, config.emulatorsBasePath),
    );
  }
  return Boolean(config.retroarchPath && existsSync(config.retroarchPath));
}

/**
 * Whether launching this platform needs a libretro core at all.
 *
 * A standalone emulator mapping does not, even for a platform whose candidate
 * core list is non-empty, so this is what keeps a PCSX2 row from triggering a
 * core download it would never load.
 */
export function requiresCore(
  config: DesktopConfig,
  platformSlug: string,
): boolean {
  const mapping = findMapping(config, platformSlug);
  if (!mapping) return true; // The RetroArch default path always needs one.
  return mapping.args.some((arg) => arg.includes("{core}"));
}

/**
 * The cores the user asked for on this platform, ahead of the frontend's.
 *
 * RomM's map names cores that will play the game; it has no opinion about which
 * ones RetroAchievements recognises, and no way to know a preference. Naming a
 * core here puts it first for both resolving and installing.
 *
 * The config is hand-edited JSON, so every shape it could be in is tolerated
 * rather than trusted, and names still have to survive isSafeCoreName before
 * they can become a path or a request.
 */
function findPreferredCores(
  config: DesktopConfig,
  platformSlug: string,
): string[] {
  const table: unknown = config.preferredCores;
  if (typeof table !== "object" || table === null) return [];
  const wanted = platformSlug.toLowerCase();
  for (const [slug, cores] of Object.entries(table)) {
    if (slug.toLowerCase() !== wanted) continue;
    if (!Array.isArray(cores)) return [];
    return cores.filter(
      (core): core is string =>
        typeof core === "string" && isSafeCoreName(core),
    );
  }
  return [];
}

/**
 * Put the user's preferred cores at the front of the candidate list.
 *
 * A preferred core the frontend never offered is kept, which is deliberate: the
 * point is to reach a core RomM's map does not name. Everything the frontend
 * did offer stays, in its original order, so this narrows nothing -- a
 * preference that turns out not to be published still falls through to what
 * RomM suggested.
 */
export function applyCorePreference(
  config: DesktopConfig,
  platformSlug: string,
  cores: string[],
): string[] {
  const preferred = findPreferredCores(config, platformSlug);
  if (preferred.length === 0) return cores;
  const seen = new Set(preferred);
  return [...preferred, ...cores.filter((core) => !seen.has(core))];
}

/**
 * Resolve the core, optionally pretending a missing one is already installed.
 *
 * The pretence exists so a launch that is about to download a core can still
 * have everything else validated first: without it, a mapping that also needs a
 * save path it does not have would only fail after the transfer. The stand-in
 * is the path the install will actually write to, so what is validated is the
 * shape of the real launch.
 *
 * A result produced this way describes a launch that cannot run yet, so it is
 * for validation only and must never be spawned.
 */
function resolveOrAssumeCore(
  config: DesktopConfig,
  cores: string[],
  assumeMissingCoreInstalled: boolean,
): { name: string; path: string } | null {
  if (!config.retroarchCoresPath) return null;
  const installed = resolveCore(config.retroarchCoresPath, cores);
  if (installed || !assumeMissingCoreInstalled) return installed;
  const candidate = cores.find(isSafeCoreName);
  if (!candidate) return null;
  return {
    name: candidate,
    path: join(config.retroarchCoresPath, coreFileName(candidate)),
  };
}

/** Pick the first candidate core that is installed, so a missing preferred core
 *  falls back instead of failing the launch. */
export function resolveCore(
  coresPath: string,
  cores: string[],
): { name: string; path: string } | null {
  for (const core of cores) {
    if (!isSafeCoreName(core)) continue;
    const path = join(coresPath, coreFileName(core));
    if (existsSync(path)) return { name: core, path };
  }
  return null;
}

/** Explain why no core could be resolved, for a mapping that needs one. */
function describeMissingCore(
  config: DesktopConfig,
  platformSlug: string,
  cores: string[],
): string {
  if (!config.retroarchCoresPath)
    return "no libretro cores directory is configured";
  if (cores.length === 0)
    return `no libretro core is known for ${platformSlug}`;
  return `none of ${cores.join(", ")} are installed in ${config.retroarchCoresPath}`;
}

/**
 * Resolve a mapping's command against the configured emulator directory.
 *
 * A frontend like RetroBat keeps every emulator under one tree, so entries can
 * name "pcsx2/pcsx2-qt.exe" and moving the whole install becomes a one-line
 * change. An absolute command is always left alone, so existing configs and
 * emulators installed anywhere else keep working untouched.
 */
export function resolveEmulatorCommand(
  command: string,
  basePath: string | null,
): string {
  if (!basePath || isAbsolute(command)) return command;
  return join(basePath, command);
}

/** Work out what to run for a platform. A user mapping wins over the RetroArch
 *  default. */
export function resolveLaunch({
  config,
  platformSlug,
  cores,
  romPath,
  savePaths,
  assumeMissingCoreInstalled = false,
}: {
  config: DesktopConfig;
  platformSlug: string;
  cores: string[];
  romPath: string;
  savePaths: SavePaths | null;
  /** Treat a core that is about to be downloaded as already installed, so a
   *  launch can be validated in full before the transfer. Validation only: the
   *  result names a core that is not on disk yet and must not be spawned. */
  assumeMissingCoreInstalled?: boolean;
}): ResolvedLaunch {
  const mapping = findMapping(config, platformSlug);
  if (mapping) {
    const command = resolveEmulatorCommand(
      mapping.command,
      config.emulatorsBasePath,
    );
    if (!existsSync(command)) {
      throw new LaunchError(
        "emulator-not-found",
        `Configured emulator for ${platformSlug} is missing: ${command}`,
      );
    }
    // A mapping may still reference {core}, so resolve one when cores are
    // available; standalone emulators simply never use the token.
    const core = resolveOrAssumeCore(config, cores, assumeMissingCoreInstalled);
    // Substituting an empty {core} would hand the emulator a blank argument and
    // fail somewhere far less legible, so refuse here instead.
    if (!core && mapping.args.some((arg) => arg.includes("{core}"))) {
      throw new LaunchError(
        "no-emulator-configured",
        `${mapping.label ?? mapping.command} needs a libretro core, but ${describeMissingCore(config, platformSlug, cores)}.`,
      );
    }
    // Same reasoning as {core}: an empty save directory would be handed to the
    // emulator as a blank argument and fail somewhere far less legible.
    const saveToken = mapping.args.find((arg) =>
      SAVE_TOKENS.some((token) => arg.includes(token)),
    );
    if (!savePaths && saveToken) {
      throw new LaunchError(
        "no-emulator-configured",
        `${mapping.label ?? mapping.command} names ${saveToken}, but no saveDataPath is set.`,
      );
    }
    return {
      command,
      args: applyTokens(mapping.args, {
        rom: romPath,
        core: core?.path ?? null,
        savePaths,
      }),
      label: mapping.label ?? mapping.command,
    };
  }

  if (!config.retroarchPath || !config.retroarchCoresPath) {
    throw new LaunchError(
      "no-emulator-configured",
      "No emulator is configured for this platform and RetroArch was not found. Install RetroArch from https://retroarch.com, or set retroarchPath in the settings if it is somewhere unusual.",
    );
  }
  if (!existsSync(config.retroarchPath)) {
    throw new LaunchError(
      "emulator-not-found",
      `RetroArch is missing: ${config.retroarchPath}`,
    );
  }
  if (cores.length === 0) {
    throw new LaunchError(
      "unsupported-platform",
      `No libretro core is known for ${platformSlug}.`,
    );
  }

  const core = resolveOrAssumeCore(config, cores, assumeMissingCoreInstalled);
  if (!core) {
    throw new LaunchError(
      "no-emulator-configured",
      `None of the cores for ${platformSlug} are installed (${cores.join(", ")}).`,
    );
  }

  // -s and -S override whatever savefile_directory the user's retroarch.cfg
  // sets, which is the point: the same game launched from the cache and from
  // the library then writes to one place instead of two. RetroArch's man page
  // marks both deprecated, but they are the only mechanism that pins the file
  // name; savefile_directory only picks the directory, and RetroArch would
  // still name the save after the content, which is what differs between the
  // two launch paths.
  const saveArgs = savePaths
    ? ["-s", savePaths.saveFile, "-S", savePaths.statePrefix]
    : [];

  return {
    command: config.retroarchPath,
    args: ["-L", core.path, ...saveArgs, romPath],
    label: `RetroArch (${core.name})`,
  };
}
