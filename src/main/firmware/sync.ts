// Bringing RomM's firmware down to where an emulator will look for it.
//
// The same shape as the ROM cache: ask the bound server, over the window's own
// session, write to a .part file, rename on success, and skip whatever already
// matches. What it adds is that nothing here can fail a launch. A ROM that will
// not download means there is no game to start; firmware that will not download
// may not have been needed at all -- most platforms have none, a user may lack
// the scope to read the library, and a server too old to have the endpoint
// answers 404. All of those end the same way: no mirror, and a launch that
// proceeds exactly as it did before any of this existed.

import { type Session } from "electron";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl } from "../safety.ts";
import {
  type BiosPaths,
  resolveBiosPaths,
  retroarchSystemConfig,
} from "./paths.ts";
import { oneAtATime } from "./queue.ts";
import {
  type LocalFirmware,
  platformIdFor,
  planFirmwareSync,
  readFirmwareList,
} from "./plan.ts";

/**
 * A PS3 firmware PUP is the largest thing anyone uploads here, at a few hundred
 * megabytes. A BIOS is usually a few.
 */
const MAX_FIRMWARE_BYTES = 1024 * 1024 * 1024;

/**
 * Ask the server for JSON, or `undefined` when it could not be asked.
 *
 * The distinction matters, and it is the only reason this does not simply
 * return null on failure. "The server says this platform has no firmware" is
 * something to act on -- the mirror empties and RetroArch stops being pointed
 * at it. "The server could not be reached" is not: offline, a 403 from a user
 * without the firmware read scope, a 404 from a server predating the endpoint
 * and a body that is not JSON all leave what is already on disk alone. Treating
 * the second as the first would mean one offline launch undoing a setup that
 * was working.
 *
 * Either way nothing throws. None of this is a reason to stop a launch.
 */
async function getJson(
  serverUrl: string,
  session: Session,
  path: string,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  let url: URL;
  try {
    // The same guard the ROM download uses: on-origin, under /api/, or refused.
    url = resolveDownloadUrl(serverUrl, path);
  } catch {
    return undefined;
  }
  try {
    // The session's own fetch, so the romm_session cookie the window already
    // holds is what authenticates this. The shell never handles credentials
    // itself, exactly as the ROM download does not.
    const response = await session.fetch(url.toString(), {
      credentials: "include",
      signal,
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * The temporary name a download writes to.
 *
 * Leading dot, so it can never collide with a firmware name: readFirmwareList
 * refuses anything safeFileName would rewrite, and safeFileName strips leading
 * dots -- so no file the server lists can be spelled this way. Suffixing
 * ".part" alone would collide with a firmware legitimately called "bios.part",
 * which readMirror would then skip and re-download on every launch.
 */
function tempNameFor(fileName: string): string {
  return `.${fileName}.part`;
}

/** Whether a directory entry is one of those temporary files. */
function isTempName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(".part");
}

/** What the mirror holds now, or nothing when it does not exist yet. */
async function readMirror(directory: string): Promise<LocalFirmware[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // A first launch, which is not a condition worth distinguishing: an empty
    // mirror and a missing one both mean everything has to be fetched.
    return [];
  }
  const files: LocalFirmware[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // A half-written transfer is not firmware. Skipped rather than reported, so
    // it can never be counted as a file the server no longer lists and deleted
    // out from under the download still writing it; swept separately below,
    // once the server's list is known.
    if (isTempName(entry.name)) continue;
    const info = await stat(join(directory, entry.name)).catch(() => null);
    if (!info) continue;
    files.push({ fileName: entry.name, size: info.size });
  }
  return files;
}

export interface FirmwareMirror extends BiosPaths {
  /** How many firmware files the platform has here. Zero is the usual answer:
   *  most platforms need none. */
  count: number;
}

/**
 * Mirror this platform's firmware, and say where it went.
 *
 * Returns the paths even when nothing was fetched, because "{bios}" expands to
 * that directory whether or not the server had anything to put in it -- an
 * emulator pointed at an empty directory simply finds no BIOS, which is what it
 * would have found anyway.
 *
 * The generated RetroArch config is the one thing that does depend on the
 * outcome: written when the mirror has files and removed when it does not, so
 * its presence on disk is what tells the launch whether pointing RetroArch's
 * system_directory here would mean anything.
 */
interface SyncOptions {
  config: DesktopConfig;
  session: Session;
  platformSlug: string;
  signal: AbortSignal;
  /** Reported per file, so a 200MB PUP does not look like a hung launch. */
  onProgress?: (
    fileName: string,
    received: number,
    total: number | null,
  ) => void;
}

export function syncPlatformFirmware(
  options: SyncOptions,
): Promise<FirmwareMirror | null> {
  const paths = resolveBiosPaths(options.config.biosPath, options.platformSlug);
  if (!paths) return Promise.resolve(null);
  // Firmware belongs to the platform, so two launches of two games can ask for
  // this at once; the second takes the first's answer instead of racing it.
  return oneAtATime(paths.directory, options.signal, () =>
    runSync(paths, options),
  );
}

async function runSync(
  paths: BiosPaths,
  { config, session, platformSlug, signal, onProgress }: SyncOptions,
): Promise<FirmwareMirror | null> {
  const { serverUrl, useRommFirmware } = config;
  if (!useRommFirmware || !serverUrl) {
    // Switching the mirror off has to switch the RetroArch pointer off with it.
    // A config generated while it was on would otherwise keep overriding the
    // user's own system_directory with a directory nothing maintains any more.
    await forgetAppendConfig(paths);
    return { ...paths, count: 0 };
  }

  const platforms = await getJson(serverUrl, session, "/api/platforms", signal);
  // Nothing below this line is allowed to delete anything unless the server
  // actually answered the question. "Could not ask" covers being offline, a 403
  // without the firmware read scope, a 404 from an older server -- and a 200
  // whose body is not the list it should be, which says just as little. All of
  // them leave the mirror and its pointer exactly as they were: a launch on a
  // train should not undo a setup that worked at home.
  if (!Array.isArray(platforms)) return untouched(paths);

  const platformId = platformIdFor(platforms, platformSlug);
  // The server has no platform by this slug. That is a disagreement about what
  // this platform even is, not a statement that it has no firmware, so it is
  // not something to delete a mirror over either.
  if (platformId === null) return untouched(paths);

  const listed = await getJson(
    serverUrl,
    session,
    `/api/firmware?platform_id=${platformId}`,
    signal,
  );
  if (!Array.isArray(listed)) return untouched(paths);

  // From here on the answer is authoritative: this is the platform's firmware,
  // and an empty list means it has none.
  const remote = readFirmwareList(listed);
  const plan = planFirmwareSync(remote, await readMirror(paths.directory));

  if (plan.fetch.length > 0) await mkdir(paths.directory, { recursive: true });
  for (const file of plan.fetch) {
    // The server names the download route after the file, which is also the
    // name it lands under: the emulator looks for that name and nothing else.
    const path = `/api/firmware/${file.id}/content/${encodeURIComponent(file.fileName)}`;
    let url: URL;
    try {
      url = resolveDownloadUrl(serverUrl, path);
    } catch {
      continue;
    }
    // A row claiming more than any real firmware is not one to start fetching.
    if (file.size > MAX_FIRMWARE_BYTES) continue;
    const target = join(paths.directory, file.fileName);
    const temp = join(paths.directory, tempNameFor(file.fileName));
    try {
      await downloadFromServer({
        url,
        session,
        destination: temp,
        signal,
        // The size the row declared is the size this is allowed to be. Enforced
        // as the bytes arrive, so a body that disagrees is stopped rather than
        // written to the end of the disk and inspected afterwards.
        maxBytes: file.size,
        onProgress: (received, total) =>
          onProgress?.(file.fileName, received, total),
      });
      // And short is as wrong as long. A truncated 2xx is a plausible thing for
      // a proxy to produce, and renaming it would publish an incomplete BIOS
      // that every later launch would consider up to date, because its name and
      // its presence are all the next plan would see. The existing file, if
      // there is one, is left alone rather than replaced by this.
      const written = await stat(temp).catch(() => null);
      if (!written || written.size !== file.size) {
        await rm(temp, { force: true });
        continue;
      }
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      // A cancel is the user's and belongs to the launch; anything else is one
      // file the emulator will not find, which is not this code's call to make
      // fatal. The next launch tries again.
      if (signal.aborted) throw error;
    }
  }

  for (const fileName of plan.remove) {
    await rm(join(paths.directory, fileName), { force: true }).catch(() => {});
  }
  await sweepOrphanedTemporaries(paths.directory, plan.fetch.length > 0);

  // Counted from disk rather than from the server's list, because a fetch that
  // failed leaves one fewer file than the server listed. The count is what
  // decides whether the generated config names a system directory at all, and
  // pointing RetroArch at a directory that turned out to be empty would
  // override a system_directory the user had set and working.
  const mirrored = await readMirror(paths.directory);
  await writeAppendConfig(paths, mirrored.length > 0 ? paths.directory : null);
  return { ...paths, count: mirrored.length };
}

/**
 * Delete the leftovers of transfers that died.
 *
 * A launch interrupted partway through a 200MB PUP leaves one of these behind,
 * and nothing else would ever look at it again: the next sync writes to the
 * same name and overwrites it, but only if that file is still listed. Dropped
 * from RomM instead, and it would sit there for good.
 *
 * Skipped entirely while this run was fetching, because a concurrent sync of
 * the same platform is serialised behind this one rather than running beside
 * it -- but a sweep that cannot tell a live transfer from a dead one is not
 * worth being clever about, and the next launch that fetches nothing will do
 * it.
 */
async function sweepOrphanedTemporaries(
  directory: string,
  fetched: boolean,
): Promise<void> {
  if (fetched) return;
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isFile() || !isTempName(entry.name)) continue;
    await rm(join(directory, entry.name), { force: true }).catch(() => {});
  }
}

/** Report what is mirrored without changing any of it, for the answers that
 *  were never given. */
async function untouched(paths: BiosPaths): Promise<FirmwareMirror> {
  return { ...paths, count: (await readMirror(paths.directory)).length };
}

/**
 * Keep the generated config in step with the mirror.
 *
 * Written whether or not there is firmware, and that is the point: a row naming
 * "{biosconfig}" names it on every platform, so the file has to exist on every
 * platform. What changes is what is in it -- a system_directory when there is
 * something to find, and nothing but comments when there is not, because an
 * appended config that sets nothing leaves the user's own system_directory
 * exactly as it was.
 *
 * Passing null is therefore not the same as deleting it. Deleting is for the
 * mirror being switched off, which is the one case where the shell should leave
 * no trace of itself in a RetroArch launch.
 */
async function writeAppendConfig(
  paths: BiosPaths,
  directory: string | null,
): Promise<void> {
  const contents = retroarchSystemConfig(directory);
  if (!contents) return;
  try {
    await mkdir(dirname(paths.appendConfig), { recursive: true });
    await writeFile(paths.appendConfig, contents, "utf8");
  } catch {
    // Without it RetroArch simply is not pointed anywhere, which is where it
    // was before. Not a launch failure.
  }
}

/** Leave no trace of the shell in a RetroArch launch, for the mirror being
 *  switched off outright. */
async function forgetAppendConfig(paths: BiosPaths): Promise<void> {
  await rm(paths.appendConfig, { force: true }).catch(() => {});
}
