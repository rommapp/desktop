// Install the PS3 firmware RomM holds into RPCS3.
//
// RPCS3 boots nothing until PS3UPDAT.PUP has been installed into its
// dev_flash, and that is an install, not a file it can be pointed at: the PUP
// is decrypted and unpacked. RPCS3 does it itself when run as
// `--headless --installfw <pup>`, which installs without a dialog and exits,
// so the shell runs that once, before the launch that needs it.
//
// Whether it is needed is read the way RPCS3 decides a boot is missing
// firmware: dev_flash/sys/external/liblv2.sprx is absent. dev_flash is inside
// RPCS3's own folder unless vfs.yml moves it, so that is read too. When the
// answer is unclear nothing is run, because an install on every launch would
// cost more than the one launch it might save.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { standaloneData } from "../standalone/data.ts";
import { type MirrorSummary, mirroredFiles } from "./place.ts";

/** What RPCS3 checks before it boots anything. */
const FIRMWARE_MARKER = ["sys", "external", "liblv2.sprx"];

/** Long enough for a slow disk to unpack the firmware, short enough that a
 *  build that ignores the flags does not hold the launch for good. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** One value out of vfs.yml's flat `key: value` lines, unquoted. */
function vfsValue(yml: string, key: string): string | null {
  for (const line of yml.split(/\r?\n/)) {
    const separator = line.indexOf(": ");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().replace(/^"(.*)"$/, "$1");
    if (name !== key) continue;
    return line
      .slice(separator + 2)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
  }
  return null;
}

/**
 * Where RPCS3's dev_flash is, given its folder and its vfs.yml, or null when
 * the configured path cannot be resolved to an absolute one.
 */
export function devFlashDirectory(
  folder: string,
  vfsYml: string | null,
): string | null {
  const emulatorDir = (vfsYml && vfsValue(vfsYml, "$(EmulatorDir)")) || folder;
  const withSlash = /[/\\]$/.test(emulatorDir)
    ? emulatorDir
    : `${emulatorDir}/`;
  const configured =
    (vfsYml && vfsValue(vfsYml, "/dev_flash/")) || "$(EmulatorDir)dev_flash/";
  const path = configured.split("$(EmulatorDir)").join(withSlash);
  return isAbsolute(path) || win32.isAbsolute(path) ? path : null;
}

/** The PUP to install: PS3UPDAT.PUP when it is there, any .pup otherwise. */
export function pickPup(names: readonly string[]): string | null {
  return (
    names.find((name) => name.toLowerCase() === "ps3updat.pup") ??
    names.find((name) => name.toLowerCase().endsWith(".pup")) ??
    null
  );
}

/**
 * The command and leading arguments that start RPCS3 itself, without the
 * launch's own. A `flatpak run` row keeps everything up to the app id.
 */
export function rpcs3Invocation(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (posix.basename(command) !== "flatpak") return { command, args: [] };
  const run = args.indexOf("run");
  if (run < 0) return { command, args: [] };
  const appId = args.findIndex((arg, i) => i > run && !arg.startsWith("-"));
  return { command, args: appId < 0 ? [] : args.slice(0, appId + 1) };
}

async function readVfsYml(folder: string): Promise<string | null> {
  // Newer builds keep it under config/, older ones beside everything else.
  for (const path of [join(folder, "config", "vfs.yml"), join(folder, "vfs.yml")]) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) return text;
  }
  return null;
}

export type RunInstaller = (
  command: string,
  args: string[],
  signal: AbortSignal,
) => Promise<void>;

const runInstaller: RunInstaller = (command, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { signal, timeout: INSTALL_TIMEOUT_MS, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });

/**
 * Install the mirrored PUP when RPCS3 has no firmware. Returns whether
 * firmware is installed afterwards because of it.
 */
export async function supplyRpcs3Firmware(options: {
  config: DesktopConfig;
  mirror: MirrorSummary | null;
  command: string;
  args: readonly string[];
  signal: AbortSignal;
  home?: string;
  run?: RunInstaller;
  /** Told the PUP's name before the install starts, which takes a while. */
  onInstall?: (fileName: string) => void;
}): Promise<boolean> {
  const { config, mirror, command, args } = options;
  if (!config.useRommFirmware || !mirror || mirror.count === 0) return false;
  const data = standaloneData({
    emulatorId: "rpcs3",
    platformSlug: "ps3",
    command,
    args,
    configured: config.standaloneDataPaths,
    home: options.home ?? homedir(),
  });
  if (!data) return false;
  const devFlash = devFlashDirectory(data.folder, await readVfsYml(data.folder));
  if (!devFlash) return false;
  const marker = join(devFlash, ...FIRMWARE_MARKER);
  if (existsSync(marker)) return false;
  const pup = pickPup(await mirroredFiles(mirror.directory));
  if (!pup) return false;

  options.onInstall?.(pup);
  const invocation = rpcs3Invocation(command, args);
  await (options.run ?? runInstaller)(
    invocation.command,
    [...invocation.args, "--headless", "--installfw", join(mirror.directory, pup)],
    options.signal,
  );
  // An exit code says little about a build that predates the flag, so the
  // firmware itself is what counts.
  if (!existsSync(marker)) {
    throw new Error(`RPCS3 exited without installing ${pup}`);
  }
  return true;
}
