// Where a libretro core comes from when the user does not have it yet.
//
// The libretro buildbot publishes one zip per core per platform, at a stable
// path, so a missing core is a known URL rather than a search. Only the "latest"
// nightly is used: it is the same build RetroArch's own core updater installs,
// and there is no per-core stable channel to prefer instead.

import { type DesktopConfig, LaunchError } from "../../shared/types.ts";
import {
  coreFileName,
  emulatorIsPresent,
  isSafeCoreName,
  requiresCore,
  resolveCore,
} from "./resolve.ts";

export const BUILDBOT_ORIGIN = "https://buildbot.libretro.com";

/**
 * Insist that what actually answered is still the buildbot.
 *
 * Checking the URL before the request is not enough, because redirects are
 * followed: a response can carry bytes from another origin while the origin
 * check on the request passes. Everything fetched from here is either loaded
 * into the emulator's address space or handed to the OS to run, so it is the
 * final URL that has to be right.
 */
export function assertBuildbotResponse(
  response: { url?: string },
  requestedUrl: string,
): void {
  // A response with no url has not been redirected anywhere, so the URL asked
  // for is the one that answered.
  const finalUrl = response.url || requestedUrl;
  let origin: string;
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    throw new LaunchError("download-failed", `Unreadable response URL`);
  }
  if (origin !== BUILDBOT_ORIGIN) {
    throw new LaunchError(
      "download-failed",
      `Refusing a response redirected to ${origin}`,
    );
  }
}

/**
 * The buildbot's directory for a platform and architecture, or null where it
 * publishes no cores for one.
 *
 * These are the directory names the buildbot actually uses, which are not
 * Node's: x64 is "x86_64", and macOS lives under apple/osx. A null means the
 * caller should leave the core alone rather than guess a URL.
 */
export function buildbotPlatformDir(
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  switch (platform) {
    case "darwin":
      // A universal directory exists but lags the per-arch ones, so prefer the
      // arch we are running as.
      if (arch === "arm64") return "apple/osx/arm64";
      if (arch === "x64") return "apple/osx/x86_64";
      return null;
    case "win32":
      if (arch === "x64") return "windows/x86_64";
      if (arch === "ia32") return "windows/x86";
      // There is no windows/arm64 directory. Windows on ARM runs the x64 build
      // under emulation, and the cores have to match the emulator, not us.
      if (arch === "arm64") return "windows/x86_64";
      return null;
    case "linux":
      if (arch === "x64") return "linux/x86_64";
      if (arch === "ia32") return "linux/x86";
      if (arch === "arm64") return "linux/aarch64";
      if (arch === "arm") return "linux/armhf";
      return null;
    default:
      return null;
  }
}

/**
 * The download URL for one core, or null when this machine has no buildbot
 * directory or the name is not one that may become a path.
 *
 * Core names arrive from the renderer, so the same alphabet check that guards
 * the cores directory guards the URL: a name that cannot be a filename cannot
 * be a request either.
 */
export function coreDownloadUrl(
  core: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (!isSafeCoreName(core)) return null;
  const dir = buildbotPlatformDir(platform, arch);
  if (!dir) return null;
  return `${BUILDBOT_ORIGIN}/nightly/${dir}/latest/${coreFileName(core, platform)}.zip`;
}

/** Whether this machine is one the buildbot publishes cores for at all. */
export function buildbotSupportsThisMachine(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return buildbotPlatformDir(platform, arch) !== null;
}

/**
 * Whether a launch of this platform is one core download away from working.
 *
 * Deliberately narrow. It says yes only when the user has turned the feature
 * on, the emulator itself is installed, that emulator actually loads a core,
 * the cores directory is known, none of the candidates are installed already,
 * and the buildbot publishes for this machine. Anything else stays the launch
 * failure it is today.
 */
export function canInstallCore(
  config: DesktopConfig,
  platformSlug: string,
  cores: string[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  if (!config.autoInstallCores) return false;
  if (!config.retroarchCoresPath) return false;
  if (!buildbotSupportsThisMachine(platform, arch)) return false;
  if (!requiresCore(config, platformSlug)) return false;
  // Checked here rather than left to each caller: a download cannot conjure an
  // emulator, so a predicate that authorised one without an emulator to load it
  // would be wrong for anyone who trusted its name.
  if (!emulatorIsPresent(config, platformSlug)) return false;
  if (!cores.some(isSafeCoreName)) return false;
  return resolveCore(config.retroarchCoresPath, cores) === null;
}

/** The candidate that would be tried first, for naming it before it is
 *  fetched. */
export function firstInstallableCore(cores: string[]): string | null {
  return cores.find(isSafeCoreName) ?? null;
}
