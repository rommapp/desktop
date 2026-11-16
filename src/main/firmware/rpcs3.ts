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
import { flatpakAppId, standaloneData } from "../standalone/data.ts";
import { type MirrorSummary, mirroredFiles } from "./place.ts";
import { oneAtATime } from "./queue.ts";

/** What RPCS3 checks before it boots anything. */
const FIRMWARE_MARKER = ["sys", "external", "liblv2.sprx"];

/** Long enough for a slow disk to unpack the firmware, short enough that a
 *  build that ignores the flags does not hold the launch for good. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A scalar as YAML writes it: quoted, or plain with an optional trailing
 * comment. Undefined for a form this does not decode, so the caller can
 * decline rather than guess.
 */
export function yamlScalar(raw: string): string | undefined {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end < 0) return undefined;
    const value = text.slice(1, end);
    // Escapes and doubled quotes are not decoded.
    if (quote === '"' && value.includes("\\")) return undefined;
    if (text[end + 1] === quote) return undefined;
    const rest = text.slice(end + 1).trim();
    return rest === "" || rest.startsWith("#") ? value : undefined;
  }
  // A plain scalar's comment starts at a "#" after whitespace.
  return text.replace(/(^|\s)#.*$/, "").trim();
}

/** One value out of vfs.yml's flat `key: value` lines: null when the key is
 *  absent, undefined when its value cannot be decoded. */
function vfsValue(yml: string, key: string): string | null | undefined {
  for (const line of yml.split(/\r?\n/)) {
    const separator = line.indexOf(": ");
    if (separator < 0) continue;
    if (yamlScalar(line.slice(0, separator)) !== key) continue;
    return yamlScalar(line.slice(separator + 2));
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
  const emulatorDirValue = vfsYml ? vfsValue(vfsYml, "$(EmulatorDir)") : null;
  const devFlashValue = vfsYml ? vfsValue(vfsYml, "/dev_flash/") : null;
  if (emulatorDirValue === undefined || devFlashValue === undefined) {
    return null;
  }
  const emulatorDir = emulatorDirValue || folder;
  const withSlash = /[/\\]$/.test(emulatorDir)
    ? emulatorDir
    : `${emulatorDir}/`;
  const configured = devFlashValue || "$(EmulatorDir)dev_flash/";
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
 * launch's own, or null when they cannot be told apart. A `flatpak run` row
 * keeps everything up to RPCS3's app id, which also skips any option values
 * between them.
 */
export function rpcs3Invocation(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } | null {
  if (posix.basename(command) !== "flatpak") return { command, args: [] };
  const appId = flatpakAppId("rpcs3");
  const run = args.indexOf("run");
  const at = appId ? args.indexOf(appId, run + 1) : -1;
  return run < 0 || at < 0 ? null : { command, args: args.slice(0, at + 1) };
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
  const invocation = rpcs3Invocation(command, args);
  if (!invocation) return false;
  const marker = join(devFlash, ...FIRMWARE_MARKER);
  // Two PS3 launches would otherwise both find the marker missing and run
  // two installers into one dev_flash. The second waits for the first, and
  // checks again only if that one failed.
  return oneAtATime(`rpcs3:${devFlash}`, options.signal, async () => {
    if (existsSync(marker)) return false;
    const pup = pickPup(await mirroredFiles(mirror.directory));
    if (!pup) return false;

    options.onInstall?.(pup);
    await (options.run ?? runInstaller)(
      invocation.command,
      [
        ...invocation.args,
        "--headless",
        "--installfw",
        join(mirror.directory, pup),
      ],
      options.signal,
    );
    // An exit code says little about a build that predates the flag, so the
    // firmware itself is what counts.
    if (!existsSync(marker)) {
      throw new Error(`RPCS3 exited without installing ${pup}`);
    }
    return true;
  });
}
