import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type DesktopConfig,
  type EmulatorMapping,
  LaunchError,
} from "../../shared/types.ts";
import { type BiosPaths, resolveBiosPaths } from "../firmware/paths.ts";
import { type SavePaths } from "../saves/paths.ts";
import { detectedMappingFor } from "./standalone.ts";

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
  /** The libretro core this launch runs, when it runs one. Null for a
   *  standalone emulator, which has no core to name. */
  core: string | null;
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
    biosPaths?: BiosPaths | null;
  },
): string[] {
  const { savePaths, biosPaths } = tokens;
  const values: Record<string, string> = {
    rom: tokens.rom,
    core: tokens.core ?? "",
    saves: savePaths?.saveDir ?? "",
    states: savePaths?.stateDir ?? "",
    savefile: savePaths?.saveFile ?? "",
    statefile: savePaths?.statePrefix ?? "",
    bios: biosPaths?.directory ?? "",
    // Only once the file is actually there. It exists whenever the mirror is
    // on, so the empty case means the user switched the mirror off and left the
    // token in their arguments.
    biosconfig: generatedSystemConfig(biosPaths ?? null) ?? "",
  };
  // One pass with a replacer, never chained replaceAll calls with string
  // replacements: a path is inserted verbatim, and token-looking text inside
  // one is left alone rather than substituted by a later pass.
  return args.map((arg) =>
    arg.replace(TOKEN_PATTERN, (match, name: string) => values[name] ?? match),
  );
}

const TOKEN_PATTERN =
  /\{(rom|core|saves|states|savefile|statefile|bios|biosconfig)\}/g;

/** The tokens that only mean something once the shell owns the save data. */
const SAVE_TOKENS = ["{saves}", "{states}", "{savefile}", "{statefile}"];

/**
 * The generated RetroArch config for this platform, if the mirror wrote one.
 *
 * Gated on the file existing, which is what makes this answerable without
 * asking the server: the sync writes it whenever the mirror is on and deletes
 * it when the mirror is switched off. What is inside decides whether anything
 * is overridden -- a platform with no firmware gets a file of comments -- so
 * its mere presence is safe to act on, for the launch and the support probe
 * alike.
 */
function generatedSystemConfig(biosPaths: BiosPaths | null): string | null {
  if (!biosPaths || !existsSync(biosPaths.appendConfig)) return null;
  return biosPaths.appendConfig;
}

/**
 * The extra arguments naming the configs the shell generates: this platform's
 * firmware directory, and the save interval this launch asks for.
 *
 * --appendconfig layers them over the user's own for one run rather than
 * editing their retroarch.cfg, so switching the mirror off switches the first
 * off with it and nothing of theirs is rewritten.
 *
 * Only for the built-in RetroArch path, because that is the only launch whose
 * argument list the shell writes: a mapping's arguments are the user's, and the
 * shell cannot know whether "flatpak run org.libretro.RetroArch" is RetroArch,
 * nor where in someone else's argv a flag of its own would be safe to insert.
 * A mapping asks for the firmware config with "{biosconfig}" instead, and sets
 * its own interval in the config it already keeps.
 */
function appendConfigArgs(
  biosPaths: BiosPaths | null,
  launchConfig: string | null,
): string[] {
  // RetroArch takes several, delimited by "|", and reads them all after the
  // user's own config, so each layers on top for this run alone.
  const generated = [generatedSystemConfig(biosPaths), launchConfig].filter(
    (file): file is string => file !== null,
  );
  return generated.length > 0 ? [`--appendconfig=${generated.join("|")}`] : [];
}

function findMapping(
  config: DesktopConfig,
  platformSlug: string,
): EmulatorMapping | null {
  const exact = config.emulators.find(
    (entry) => entry.platformSlug.toLowerCase() === platformSlug.toLowerCase(),
  );
  if (exact) return exact;

  // A standalone emulator sitting in its usual place, between the user's own
  // rows and the wildcard. It loses to anything written by hand, so configuring
  // one still overrides it, and it beats the wildcard because a row meant as a
  // catch-all should not claim a platform that has a real emulator installed
  // for it. Detection is what makes PS2 and GameCube launchable at all under
  // RetroAchievements, which recognises no libretro core for either.
  if (config.useDetectedEmulators) {
    const detected = detectedMappingFor(platformSlug, undefined, homedir());
    if (detected) return detected;
  }

  return (
    config.emulators.find((entry) => entry.platformSlug === WILDCARD_SLUG) ??
    null
  );
}

/**
 * Whether anything specific to this platform would handle it.
 *
 * Deliberately not emulatorIsPresent, which answers "would this launch find an
 * executable" and so says yes for every platform the moment RetroArch exists.
 * That is the wrong question when deciding whether to offer PCSX2: RetroArch
 * being installed is exactly the normal case, and a libretro core is not a
 * substitute when RetroAchievements recognises none for PS2 or GameCube.
 *
 * A wildcard row does not count either. It is a catch-all for platforms with
 * nothing better, not a considered choice for this one -- the same reason
 * detection outranks it in findMapping.
 */
export function hasPlatformSpecificEmulator(
  config: DesktopConfig,
  platformSlug: string,
): boolean {
  const wanted = platformSlug.toLowerCase();
  if (config.emulators.some((row) => row.platformSlug.toLowerCase() === wanted))
    return true;
  if (!config.useDetectedEmulators) return false;
  return detectedMappingFor(platformSlug, undefined, homedir()) !== null;
}

/** Emulators known to boot an .m3u, for a mapping that does not say. Matched
 *  against the command and its arguments together, so "flatpak run
 *  org.duckstation.DuckStation" counts the same as an executable name. */
const PLAYLIST_EMULATORS = ["retroarch", "duckstation", "dolphin"];

/**
 * Whether the emulator this platform would use boots an .m3u playlist.
 *
 * It decides what a multi-disc game is handed: the playlist, or the first disc
 * with the rest of the set beside it for the emulator's own disc menu. PCSX2
 * reads no playlist, and handing one over would fail the launch.
 *
 * A mapping written by hand says so itself, or is inferred: arguments naming
 * "{core}" are RetroArch driving a libretro core, and the emulators above are
 * recognised where they are named. Anything else is assumed not to, since a
 * disc that boots beats a playlist that might not.
 */
export function emulatorReadsPlaylist(
  config: DesktopConfig,
  platformSlug: string,
): boolean {
  const mapping = findMapping(config, platformSlug);
  if (!mapping) return true; // The RetroArch default path.
  if (mapping.playlist !== undefined) return mapping.playlist;
  if (mapping.args.some((arg) => arg.includes("{core}"))) return true;
  const named = [mapping.command, ...mapping.args].join(" ").toLowerCase();
  return PLAYLIST_EMULATORS.some((emulator) => named.includes(emulator));
}

/**
 * Whether this platform would launch through the built-in RetroArch path, whose
 * argument list the shell writes itself.
 *
 * Asked before a launch generates a config for itself: a mapping's arguments
 * are the user's, so nothing generated is ever named on that path, and writing
 * a file no launch reads would leave the user a stray config to wonder about.
 */
export function usesBuiltInRetroArch(
  config: DesktopConfig,
  platformSlug: string,
): boolean {
  return findMapping(config, platformSlug) === null;
}

/**
 * Whether this platform's launch will actually read and write the save file the
 * shell owns.
 *
 * Sync moves `<saveDataPath>/<romId>/saves/<name>.srm`, and that is only the
 * emulator's save if the launch points the emulator at it. A mapping's
 * arguments are the user's: they are free to name no save token at all, and
 * such a launch keeps its saves wherever the emulator puts them by default.
 * Syncing around one would pull RomM's copy into a file nothing reads and then
 * hash that same untouched file on the way out -- a sync that reports itself as
 * having happened and did nothing.
 *
 * "{savefile}" is the only form that counts, because it is the only one that
 * pins the name. "{saves}" hands over the directory and leaves the emulator to
 * derive the filename from the content -- which is exactly what differs between
 * a cached launch and an in-library one, and the reason the built-in path below
 * passes -s rather than setting savefile_directory. Syncing a "{saves}" mapping
 * would pull into a name the emulator may not read and offer RomM a file it may
 * never have written. A user who wants sync on such a mapping names
 * "{savefile}" and gets it. The state tokens are their own question, answered
 * by emulatorUsesStateDir.
 */
export function emulatorUsesSaveFile(
  config: DesktopConfig,
  platformSlug: string,
): boolean {
  const mapping = findMapping(config, platformSlug);
  // The RetroArch default path, whose arguments the shell writes itself: it
  // passes -s, naming the exact file.
  if (!mapping) return true;
  return mapping.args.some((arg) => arg.includes("{savefile}"));
}

/**
 * Whether this platform's launch will write its savestates where the shell can
 * find them.
 *
 * The directory is enough here, unlike the save file above, because the mirror
 * reads it whole: the directory is this ROM's own, so everything in it is a
 * state of this game, and the mirror never has to predict the name the emulator
 * will choose. A mapping that names neither state token keeps its states
 * wherever the emulator puts them, and there is nothing to mirror.
 */
export function emulatorUsesStateDir(
  config: DesktopConfig,
  platformSlug: string,
): boolean {
  const mapping = findMapping(config, platformSlug);
  // The built-in RetroArch path, whose generated config pins
  // savestate_directory and turns the sorting options off.
  if (!mapping) return true;
  return mapping.args.some(
    (arg) => arg.includes("{states}") || arg.includes("{statefile}"),
  );
}

/**
 * Whether this platform's launch pins what its states are called, rather than
 * only the directory they land in.
 *
 * The restore is the one half of the mirror that does have to name a file, for
 * a slot the directory holds nothing under yet, and this is which name to try
 * first. A launch naming `{statefile}` has told the emulator what to call them;
 * one naming only `{states}` leaves the emulator to derive a name from the
 * content it was handed, which for a disc set is the playlist rather than the
 * game.
 */
export function emulatorPinsStateFile(
  config: DesktopConfig,
  platformSlug: string,
): boolean {
  const mapping = findMapping(config, platformSlug);
  // The built-in RetroArch path passes -S, naming the exact file.
  if (!mapping) return true;
  return mapping.args.some((arg) => arg.includes("{statefile}"));
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
 * they can become a path or a request. A name repeated by hand is honoured
 * once, so a redundant list cannot make an install attempt the same download
 * twice.
 */
export function findPreferredCores(
  config: DesktopConfig,
  platformSlug: string,
): string[] {
  const table: unknown = config.preferredCores;
  if (typeof table !== "object" || table === null) return [];
  const wanted = platformSlug.toLowerCase();
  for (const [slug, cores] of Object.entries(table)) {
    if (slug.toLowerCase() !== wanted) continue;
    if (!Array.isArray(cores)) return [];
    // De-duplicated here rather than at one caller: the install plan reads this
    // list directly, and a name repeated by hand would become the same download
    // attempted twice.
    return [
      ...new Set(
        cores.filter(
          (core): core is string =>
            typeof core === "string" && isSafeCoreName(core),
        ),
      ),
    ];
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
  launchConfig = null,
  fullscreen = false,
  assumeMissingCoreInstalled = false,
}: {
  config: DesktopConfig;
  platformSlug: string;
  cores: string[];
  romPath: string;
  savePaths: SavePaths | null;
  /** A generated RetroArch config for this run, appended after the firmware
   *  one. Null when the launch asked for nothing. */
  launchConfig?: string | null;
  /** What the launch asked for. Honoured only on the built-in RetroArch path,
   *  since a mapping's arguments are the user's and an emulator's fullscreen
   *  flag is its own. */
  fullscreen?: boolean;
  /** Treat a core that is about to be downloaded as already installed, so a
   *  launch can be validated in full before the transfer. Validation only: the
   *  result names a core that is not on disk yet and must not be spawned. */
  assumeMissingCoreInstalled?: boolean;
}): ResolvedLaunch {
  // Derived rather than passed in, so the launch and the support probe agree
  // without either of them having synced anything: the directory is a pure
  // function of the config and the slug, and "{bios}" resolves to it whether or
  // not the server turned out to have firmware to put there.
  const biosPaths = resolveBiosPaths(config.biosPath, platformSlug);
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
        biosPaths,
      }),
      label: mapping.label ?? mapping.command,
      core: core?.name ?? null,
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

  // Asked for per launch, so the page offering the choice for its own player
  // offers the same thing here. There is no opposite flag: a launch that does
  // not ask leaves the user's own fullscreen setting to decide.
  const displayArgs = fullscreen ? ["-f"] : [];

  // Only worth asking for when someone is reading it: RetroArch names the save
  // file it resolved and whether it wrote one at this level, which is the
  // account the shell cannot produce by watching a file.
  const logArgs = config.logEmulatorOutput ? ["--verbose"] : [];

  return {
    command: config.retroarchPath,
    // The generated configs first: --appendconfig is read as RetroArch starts
    // up, and the core and content that follow are what the run is about.
    args: [
      ...appendConfigArgs(biosPaths, launchConfig),
      "-L",
      core.path,
      ...saveArgs,
      ...displayArgs,
      ...logArgs,
      romPath,
    ],
    label: `RetroArch (${core.name})`,
    core: core.name,
  };
}
