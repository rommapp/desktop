// Supply Cemu's keys and console files from RomM's firmware mirror.
//
// Cemu reads three such files from its user folder: keys.txt, the disc keys an
// encrypted WUD or WUX needs, and otp.bin and seeprom.bin, which only online
// play needs. The two binaries are copied when missing, like every other
// emulator's firmware.
//
// keys.txt cannot be handled that way. Cemu writes a template one the first
// time it looks, so a file is almost always there already, holding nothing but
// an example key. It is a list Cemu reads line by line, though, so the keys
// RomM holds that the file lacks are appended under a comment, and the user's
// own lines are never changed or reordered.

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { standaloneData } from "../standalone/data.ts";
import { copyIfMissing, type MirrorSummary, mirroredFiles } from "./place.ts";

/** The console files and the size Cemu rejects any other size of. */
const CONSOLE_FILES: ReadonlyMap<string, number> = new Map([
  ["otp.bin", 1024],
  ["seeprom.bin", 512],
]);

const KEYS_FILE = "keys.txt";

const APPENDED_HEADER = "# Added by RomM Desktop from the keys.txt in RomM";

/**
 * The keys a keys.txt holds, read the way Cemu reads it: anything after "#"
 * or ";" is a comment, spaces, tabs, dashes and underscores are dropped, and
 * a line counts when what is left is 32 hex digits. Lowercased, so the same
 * key written two ways is one key.
 */
export function parseCemuKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").replace(/[ \t\-_]/g, "");
    if (/^[0-9a-fA-F]{32}$/.test(line)) keys.push(line.toLowerCase());
  }
  return keys;
}

/**
 * The user's keys.txt with RomM's missing keys appended, or null when it
 * already has them all. A missing file is the same as an empty one.
 */
export function mergeCemuKeys(
  existing: string | null,
  incoming: string,
): string | null {
  const have = new Set(parseCemuKeys(existing ?? ""));
  const missing = [...new Set(parseCemuKeys(incoming))].filter(
    (key) => !have.has(key),
  );
  if (missing.length === 0) return null;
  const base = existing ?? "";
  // Cemu writes its template with CRLF, so keep whatever the file uses.
  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const separator = base === "" || base.endsWith("\n") ? "" : eol;
  return base + separator + [APPENDED_HEADER, ...missing, ""].join(eol);
}

async function readIfPresent(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function supplyKeys(source: string, folder: string): Promise<boolean> {
  const incoming = await readIfPresent(source);
  if (incoming === null) return false;
  const target = join(folder, KEYS_FILE);
  const merged = mergeCemuKeys(await readIfPresent(target), incoming);
  if (merged === null) return false;
  // Renamed into place, so an interrupted write never leaves a truncated file.
  const temporary = `${target}.romm-part`;
  await writeFile(temporary, merged, "utf8");
  await rename(temporary, target);
  return true;
}

export async function supplyCemuFirmware(options: {
  config: DesktopConfig;
  mirror: MirrorSummary | null;
  command: string;
  args: readonly string[];
  home?: string;
}): Promise<number> {
  const { config, mirror, command, args } = options;
  if (!config.useRommFirmware || !mirror || mirror.count === 0) return 0;
  const data = standaloneData({
    emulatorId: "cemu",
    platformSlug: "wiiu",
    command,
    args,
    configured: config.standaloneDataPaths,
    home: options.home ?? homedir(),
  });
  // Do not create a user folder before Cemu has initialized itself.
  if (!data?.exists) return 0;
  let placed = 0;
  for (const name of await mirroredFiles(mirror.directory)) {
    const source = join(mirror.directory, name);
    const lower = name.toLowerCase();
    if (lower === KEYS_FILE) {
      if (await supplyKeys(source, data.folder)) placed++;
      continue;
    }
    const size = CONSOLE_FILES.get(lower);
    if (size === undefined) continue;
    if ((await stat(source).catch(() => null))?.size !== size) continue;
    if (await copyIfMissing(source, data.folder, lower)) placed++;
  }
  return placed;
}
