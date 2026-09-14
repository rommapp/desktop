// Where RetroArch itself comes from, for a machine that has none.
//
// Unlike a libretro core, RetroArch is not something this shell can unpack and
// place: the buildbot publishes it only as a .7z (LZMA, which node:zlib cannot
// read) and a macOS .dmg (a filesystem image). Both would mean either a runtime
// dependency or a bundled extractor, and on macOS stripping a quarantine flag
// off a binary we then execute.
//
// So nothing here installs anything. It names the project's own installer so it
// can be handed to the operating system, which runs the install flow the user
// already recognises: UAC and SmartScreen on Windows, a mounted disk image on
// macOS. The user consents there, and RetroArch keeps ownership of its own
// updates.
//
// Kept free of Electron imports so the URL building and the policy below stay
// unit-testable; the fetching lives in bootstrap.ts.

import { type DesktopConfig } from "../../shared/types.ts";
import { BUILDBOT_ORIGIN } from "./buildbot.ts";

// The emulator and its cores come from the same host, so the origin is defined
// once, next to the core downloading, rather than twice.
export { BUILDBOT_ORIGIN };

/** Where a user is sent when there is nothing to download for their system. */
export const RETROARCH_DOWNLOAD_PAGE = "https://retroarch.com/?page=platforms";

/**
 * Used when the stable index cannot be read.
 *
 * Verified to publish an installer for every platform below, so a buildbot that
 * is unreachable or has changed its index layout degrades to an older
 * RetroArch rather than to nothing.
 */
export const PINNED_STABLE_VERSION = "1.22.2";

/** Nothing sane is this large; a wrong URL should not become a disk-filling
 *  write. The installers are a little over 200MB. */
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

/** Compare dotted numeric versions, shorter ones padded with zeroes. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Pick the newest release out of the buildbot's stable index.
 *
 * The buildbot has no API, so this reads the directory listing. Kept tolerant:
 * an unrecognised page yields null and the caller falls back to the pinned
 * version rather than failing.
 */
export function latestStableVersion(html: string): string | null {
  const found = new Set<string>();
  for (const match of html.matchAll(/href="\/stable\/(\d+(?:\.\d+)*)\/"/g)) {
    const version = match[1];
    if (version) found.add(version);
  }
  if (found.size === 0) return null;
  return [...found].sort(compareVersions).at(-1) ?? null;
}

export interface RetroArchInstaller {
  url: string;
  /** What to call the file on disk. Also what the user sees when it opens. */
  fileName: string;
  /** How the OS will treat it, for wording the prompt honestly. */
  kind: "installer" | "disk-image";
}

/**
 * The installer for a machine, or null where handing one over is the wrong
 * move.
 *
 * Linux is deliberately null. The buildbot ships only a 179MB .7z portable
 * build there, and a distribution's own package is both smaller and the thing
 * that will actually receive updates; dropping a second copy beside it would be
 * a disservice.
 */
export function retroarchInstaller(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RetroArchInstaller | null {
  const base = `${BUILDBOT_ORIGIN}/stable/${version}`;
  switch (platform) {
    case "darwin":
      // The universal build covers both arches, which also sidesteps handing an
      // arm64 build to an x86_64 install or the reverse.
      return {
        url: `${base}/apple/osx/universal/RetroArch_Metal.dmg`,
        fileName: "RetroArch_Metal.dmg",
        kind: "disk-image",
      };
    case "win32":
      // No arm64 installer is published; Windows on ARM runs the x64 build.
      if (arch === "ia32") {
        return {
          url: `${base}/windows/x86/RetroArch-Win32-setup.exe`,
          fileName: "RetroArch-Win32-setup.exe",
          kind: "installer",
        };
      }
      if (arch === "x64" || arch === "arm64") {
        return {
          url: `${base}/windows/x86_64/RetroArch-Win64-setup.exe`,
          fileName: "RetroArch-Win64-setup.exe",
          kind: "installer",
        };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Whether this machine has no way to launch anything at all.
 *
 * Deliberately about the whole config rather than one platform: a user with a
 * single standalone emulator configured has made a choice, and an unprompted
 * dialog offering them a different one would be presumptuous.
 */
export function hasNoEmulator(config: DesktopConfig): boolean {
  return !config.retroarchPath && config.emulators.length === 0;
}

/**
 * How the offer opens, given the standalone emulators detection found.
 *
 * Detection can turn up PCSX2 or Dolphin, which play one platform each and
 * leave the rest of a library unplayable -- so the offer is still worth making,
 * and the reason for it is still true. What would not be true is the sentence
 * it used to open with. Saying "could not find an emulator" to someone looking
 * at PCSX2 in their Applications folder is the kind of wrongness that makes a
 * user stop believing the next thing the app tells them.
 */
export function noEmulatorMessage(detected: string[]): string {
  if (detected.length === 0) {
    return "RomM Desktop could not find an emulator on this machine.";
  }
  const found =
    detected.length === 1
      ? detected[0]
      : `${detected.slice(0, -1).join(", ")} and ${detected.at(-1)}`;
  return `RomM Desktop found ${found}, but nothing that plays the rest of your library.`;
}

/** Whether to raise the offer at all. */
export function shouldOfferRetroArch(config: DesktopConfig): boolean {
  // Nothing to say before the server address is even known: that window is
  // already asking the user for something.
  if (!config.serverUrl) return false;
  if (!config.offerRetroArchInstall) return false;
  return hasNoEmulator(config);
}
