import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type DesktopConfig,
  type EmulatorMapping,
  LaunchError,
} from "../../shared/types.ts";

/** Fallback row applied to any platform without its own mapping. */
const WILDCARD_SLUG = "*";

/** Core names come from the renderer and end up in a filesystem path, so
 *  anything outside this alphabet is rejected rather than escaped. */
const SAFE_CORE_NAME = /^[a-z0-9_]+$/;

export function isSafeCoreName(core: string): boolean {
  return SAFE_CORE_NAME.test(core);
}

function coreFileExtension(): string {
  switch (process.platform) {
    case "darwin":
      return "dylib";
    case "win32":
      return "dll";
    default:
      return "so";
  }
}

export function coreFileName(core: string): string {
  return `${core}_libretro.${coreFileExtension()}`;
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
  tokens: { rom: string; core: string | null },
): string[] {
  return args.map((arg) =>
    arg.replaceAll("{rom}", tokens.rom).replaceAll("{core}", tokens.core ?? ""),
  );
}

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
}: {
  config: DesktopConfig;
  platformSlug: string;
  cores: string[];
  romPath: string;
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
    const core = config.retroarchCoresPath
      ? resolveCore(config.retroarchCoresPath, cores)
      : null;
    // Substituting an empty {core} would hand the emulator a blank argument and
    // fail somewhere far less legible, so refuse here instead.
    if (!core && mapping.args.some((arg) => arg.includes("{core}"))) {
      throw new LaunchError(
        "no-emulator-configured",
        `${mapping.label ?? mapping.command} needs a libretro core, but ${describeMissingCore(config, platformSlug, cores)}.`,
      );
    }
    return {
      command,
      args: applyTokens(mapping.args, {
        rom: romPath,
        core: core?.path ?? null,
      }),
      label: mapping.label ?? mapping.command,
    };
  }

  if (!config.retroarchPath || !config.retroarchCoresPath) {
    throw new LaunchError(
      "no-emulator-configured",
      "No emulator is configured for this platform and RetroArch was not found.",
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

  const core = resolveCore(config.retroarchCoresPath, cores);
  if (!core) {
    throw new LaunchError(
      "no-emulator-configured",
      `None of the cores for ${platformSlug} are installed (${cores.join(", ")}).`,
    );
  }

  return {
    command: config.retroarchPath,
    args: ["-L", core.path, romPath],
    label: `RetroArch (${core.name})`,
  };
}
