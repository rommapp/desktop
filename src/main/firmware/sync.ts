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
    // A .part is a transfer that died. Left for its own download to overwrite
    // rather than reported as firmware, so it can never be counted as a file
    // the server no longer lists and deleted out from under a live transfer.
    if (entry.name.endsWith(".part")) continue;
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
export async function syncPlatformFirmware({
  config,
  session,
  platformSlug,
  signal,
  onProgress,
}: {
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
}): Promise<FirmwareMirror | null> {
  const paths = resolveBiosPaths(config.biosPath, platformSlug);
  if (!paths) return null;
  const { serverUrl, useRommFirmware } = config;
  if (!useRommFirmware || !serverUrl) {
    // Switching the mirror off has to switch the RetroArch pointer off with it.
    // A config generated while it was on would otherwise keep overriding the
    // user's own system_directory with a directory nothing maintains any more.
    await writeAppendConfig(paths, false);
    return { ...paths, count: 0 };
  }

  const platforms = await getJson(serverUrl, session, "/api/platforms", signal);
  // Could not ask. Whatever is mirrored is still the last thing the server did
  // say, so it stays, pointer included: a launch on a train should not undo a
  // setup that worked at home.
  if (platforms === undefined) return untouched(paths);

  const platformId = platformIdFor(platforms, platformSlug);
  // Answered, and has no platform by this slug -- so nothing to point at.
  if (platformId === null) {
    await writeAppendConfig(paths, false);
    return { ...paths, count: 0 };
  }

  const listed = await getJson(
    serverUrl,
    session,
    `/api/firmware?platform_id=${platformId}`,
    signal,
  );
  if (listed === undefined) return untouched(paths);
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
    // Bounded like any other download, so a mislabelled row cannot fill the
    // disk with what it claimed was a BIOS.
    if (file.size > MAX_FIRMWARE_BYTES) continue;
    const target = join(paths.directory, file.fileName);
    const temp = `${target}.part`;
    try {
      await downloadFromServer({
        url,
        session,
        destination: temp,
        signal,
        onProgress: (received, total) =>
          onProgress?.(file.fileName, received, total),
      });
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

  // Counted from disk rather than from the server's list, because a fetch that
  // failed leaves a file the emulator will not find. Writing the pointer for a
  // directory that turned out to be empty would override a system_directory the
  // user had set and working, which is the one thing this must not do.
  const mirrored = await readMirror(paths.directory);
  await writeAppendConfig(paths, mirrored.length > 0);
  return { ...paths, count: mirrored.length };
}

/** Report what is mirrored without changing any of it, for the answers that
 *  were never given. */
async function untouched(paths: BiosPaths): Promise<FirmwareMirror> {
  return { ...paths, count: (await readMirror(paths.directory)).length };
}

/**
 * Keep the generated config in step with the mirror.
 *
 * Removed rather than left stale when a platform's firmware goes away, because
 * a config naming an empty system directory would override whatever the user
 * had set in their own retroarch.cfg -- taking away a system directory that was
 * working before the shell involved itself.
 */
async function writeAppendConfig(
  paths: BiosPaths,
  hasFirmware: boolean,
): Promise<void> {
  if (!hasFirmware) {
    await rm(paths.appendConfig, { force: true }).catch(() => {});
    return;
  }
  const contents = retroarchSystemConfig(paths.directory);
  if (!contents) return;
  try {
    await mkdir(dirname(paths.appendConfig), { recursive: true });
    await writeFile(paths.appendConfig, contents, "utf8");
  } catch {
    // Without it RetroArch simply is not pointed anywhere, which is where it
    // was before. Not a launch failure.
  }
}
