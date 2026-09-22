// Making a multi-disc game launchable.
//
// RomM serves a folder rom as one archive, and an archive is not something an
// emulator can boot a disc set out of: RetroArch cannot resolve a playlist's
// sibling references inside a zip, and PCSX2, Dolphin and RPCS3 cannot open one
// at all. So the discs are fetched as the individual files the server already
// has, one request each, and an .m3u naming them is written for the emulators
// that read one. The rest are handed the first disc, with the set beside it.
//
// Nothing here can fail a launch. A server that will not answer, a rom whose
// files cannot be read, a set with fewer than two discs, and a transfer that
// fails all return null, and the caller falls back to the single-payload
// download it would have done. Only a cancellation stays fatal, that one being
// the user's own.

import { type Session } from "electron";
import { mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_DISCS, type DesktopConfig } from "../../shared/types.ts";
import { noteSignedOut } from "../auth/recover.ts";
import { evictToLimit } from "../cache/evict.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl, resolveLibraryRom } from "../safety.ts";
import {
  type DiscFile,
  ownPlaylist,
  readRomFiles,
  renderM3u,
  selectDiscs,
  selectPickedDisc,
  selectStagedFiles,
  selectStagedForDisc,
} from "./m3u.ts";

/** The playlist's own name inside the rom's cache directory. */
const PLAYLIST_NAME = "discs.m3u";

interface SyncOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  signal: AbortSignal;
  /** Whether this launch's emulator boots an .m3u. When it does not, the first
   *  disc is what starts the game and the rest of the set is a disc change away
   *  in the emulator's own menu, so no playlist is written. */
  playlist: boolean;
  /** The disc the play page picked, `"all"` for the whole set, or undefined
   *  from a caller that was never asked. */
  disc?: number | typeof ALL_DISCS;
  onProgress?: (
    fileName: string,
    received: number,
    total: number | null,
    /** 1-based place in the set of files being fetched. */
    index: number,
    count: number,
  ) => void;
}

async function getJson(
  serverUrl: string,
  session: Session,
  path: string,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  let url: URL;
  try {
    url = resolveDownloadUrl(serverUrl, path);
  } catch {
    return undefined;
  }
  try {
    // The window's own session, so the cookie it already holds authenticates
    // this and the shell never handles a credential itself.
    const response = await session.fetch(url.toString(), {
      credentials: "include",
      signal,
    });
    noteSignedOut(serverUrl, response.status);
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Fetch a rom's discs and return what the emulator should be handed, or null
 * when this rom is not a disc set or the set could not be staged.
 */
export async function syncDiscSet({
  config,
  session,
  romId,
  signal,
  playlist,
  disc,
  onProgress,
}: SyncOptions): Promise<string | null> {
  const { serverUrl, cachePath } = config;
  if (!serverUrl || !cachePath) return null;

  const body = await getJson(serverUrl, session, `/api/roms/${romId}`, signal);
  if (body === undefined) return null;

  const files = readRomFiles(body);
  const discs = selectDiscs(files);
  // One disc is an ordinary launch, and the caller's own download handles it
  // without a playlist in the way.
  if (discs.length < 2) return null;

  // One disc of the set, where the page's disc selector picked one. Booted on
  // its own with no playlist in front of it, which is what that choice means:
  // the rest of the set is not fetched, so a four-disc game the player is only
  // replaying disc one of costs one transfer.
  const picked =
    disc === undefined || disc === ALL_DISCS
      ? null
      : selectPickedDisc(files, disc);
  if (disc !== undefined && disc !== ALL_DISCS && !picked) {
    // A pick the rom does not answer to, which a page whose view of the rom
    // predates a rescan can send. The whole set still plays the game.
    console.warn(
      `[discs] rom ${romId}: file ${disc} is not a disc of this rom, booting the whole set`,
    );
  }

  const staged = picked
    ? selectStagedForDisc(files, picked)
    : selectStagedFiles(files);

  // The set comes from one place: all of it from the library, in one
  // directory, or all of it from the cache.
  const paths =
    libraryPaths(staged, config.libraryPath) ??
    (await cachePaths({
      staged,
      serverUrl,
      session,
      romId,
      cachePath,
      cacheLimitBytes: config.cacheLimitBytes,
      signal,
      onProgress,
    }));
  if (!paths) return null;

  // The pick is the whole of what was staged, so it is the whole of what boots.
  if (picked) return paths.get(picked.id) ?? null;

  const bootPaths: string[] = [];
  for (const entry of discs) {
    const path = paths.get(entry.id);
    // A disc the staged set does not hold is a set that cannot be launched.
    if (!path) return null;
    bootPaths.push(path);
  }

  if (!playlist) return bootPaths[0] as string;

  // A set that ships its own playlist has an order nobody should be guessing
  // at, and it was staged with the discs, so its relative entries resolve.
  const own = ownPlaylist(staged);
  const ownPath = own && paths.get(own.id);
  if (ownPath) return ownPath;

  // Written to the cache even when every disc came from the library, because
  // the library is the user's and a playlist left in it is one more file for
  // RomM to scan.
  const romDir = join(cachePath, String(romId));
  await mkdir(romDir, { recursive: true });
  const playlistPath = join(romDir, PLAYLIST_NAME);
  await writeFile(playlistPath, renderM3u(bootPaths), "utf8");
  return playlistPath;
}

/**
 * Where the set already sits in the user's library, or null when it does not
 * sit there whole and in one directory.
 *
 * A sheet names its tracks by relative name, and an emulator with no playlist
 * looks for the next disc beside the one it booted, so a set spread over two
 * directories cannot finish. A rom's files can sit in subdirectories of its
 * folder, which is why being under libraryPath is not the same as being beside
 * each other.
 */
function libraryPaths(
  staged: DiscFile[],
  libraryPath: string | null,
): Map<number, string> | null {
  const found = new Map<number, string>();
  const directories = new Set<string>();
  for (const file of staged) {
    const path = resolveLibraryRom(libraryPath, file.fullPath, file.sizeBytes);
    if (!path) return null;
    found.set(file.id, path);
    directories.add(directoryOf(path));
  }
  return directories.size === 1 ? found : null;
}

/** Fetch the whole set into this rom's cache directory, or null when any of it
 *  could not be fetched. */
async function cachePaths({
  staged,
  serverUrl,
  session,
  romId,
  cachePath,
  cacheLimitBytes,
  signal,
  onProgress,
}: {
  staged: DiscFile[];
  serverUrl: string;
  session: Session;
  romId: number;
  cachePath: string;
  cacheLimitBytes: number;
  signal: AbortSignal;
  onProgress: SyncOptions["onProgress"];
}): Promise<Map<number, string> | null> {
  const romDir = join(cachePath, String(romId));
  await mkdir(romDir, { recursive: true });

  const found = new Map<number, string>();
  for (const [position, file] of staged.entries()) {
    const target = await stageFile({
      serverUrl,
      session,
      romId,
      romDir,
      file,
      signal,
      onProgress: (received, total) =>
        onProgress?.(
          file.fileName,
          received,
          total,
          position + 1,
          staged.length,
        ),
    });
    if (!target) return null;
    found.set(file.id, target);
  }

  // These downloads bypass ensureRom, which is where an ordinary launch keeps
  // the cache inside its limit. Once the set is whole, and never evicting the
  // directory this launch is about to read.
  await evictToLimit(cachePath, cacheLimitBytes, romDir);
  return found;
}

function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut);
}

/** Fetch one file of the set, or null when it could not be fetched. */
async function stageFile({
  serverUrl,
  session,
  romId,
  romDir,
  file,
  signal,
  onProgress,
}: {
  serverUrl: string;
  session: Session;
  romId: number;
  romDir: string;
  file: DiscFile;
  signal: AbortSignal;
  onProgress: (received: number, total: number | null) => void;
}): Promise<string | null> {
  const target = join(romDir, file.fileName);
  const existing = await stat(target).catch(() => null);
  if (existing?.isFile() && existing.size === file.sizeBytes) {
    // Touched so eviction ranks a replayed set by when it was last played
    // rather than when it was first fetched, as ensureRom does on a hit.
    const now = new Date();
    await utimes(target, now, now).catch(() => {});
    return target;
  }

  // One file at a time, by id: the content endpoint serves a single requested
  // file directly rather than zipping it, which is the whole point of asking
  // per disc.
  const path = `/api/roms/${romId}/content/${encodeURIComponent(file.fileName)}?file_ids=${file.id}`;
  let url: URL;
  try {
    url = resolveDownloadUrl(serverUrl, path);
  } catch {
    return null;
  }

  const temp = `${target}.part`;
  try {
    await downloadFromServer({
      url,
      session,
      destination: temp,
      signal,
      // The size the server declared is the size this is allowed to be.
      maxBytes: file.sizeBytes,
      onProgress,
    });
    // Short is as wrong as long: a truncated file that kept its name would be
    // treated as complete by every later launch.
    const written = await stat(temp).catch(() => null);
    if (!written || written.size !== file.sizeBytes) {
      await rm(temp, { force: true });
      return null;
    }
    await rename(temp, target);
    return target;
  } catch (error) {
    await rm(temp, { force: true });
    // A cancellation is the user's and stays fatal. A refused or interrupted
    // transfer is not: it falls back to the ordinary download, which is also
    // what a server too old to serve one file by id ends up doing.
    if (signal.aborted) throw error;
    return null;
  }
}
