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
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { evictToLimit } from "../cache/evict.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl, resolveLibraryRom } from "../safety.ts";
import {
  type DiscFile,
  readRomFiles,
  renderM3u,
  selectDiscs,
  selectStagedFiles,
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
  const staged = selectStagedFiles(files);

  // All of the set from the library or none of it. A sheet names its tracks by
  // relative name, and an emulator with no playlist looks for the next disc
  // beside the one it booted, so a set split across two directories is a set
  // that cannot finish.
  const local = staged.map((file) =>
    resolveLibraryRom(config.libraryPath, file.fullPath, file.sizeBytes),
  );

  const romDir = join(cachePath, String(romId));
  const paths = new Map<number, string>();

  if (local.every((path) => path !== null)) {
    staged.forEach((file, position) => {
      paths.set(file.id, local[position] as string);
    });
  } else {
    await mkdir(romDir, { recursive: true });
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
      paths.set(file.id, target);
    }
    // These downloads bypass ensureRom, which is where an ordinary launch keeps
    // the cache inside its limit. Once the set is whole, and never evicting the
    // directory this launch is about to read.
    await evictToLimit(cachePath, config.cacheLimitBytes, romDir);
  }

  const bootPaths: string[] = [];
  for (const disc of discs) {
    const path = paths.get(disc.id);
    // A disc the staged set does not hold is a set that cannot be launched.
    if (!path) return null;
    bootPaths.push(path);
  }

  if (!playlist) return bootPaths[0] as string;

  // Written to the cache even when every disc came from the library, because
  // the library is the user's and a playlist left in it is one more file for
  // RomM to scan.
  await mkdir(romDir, { recursive: true });
  const playlistPath = join(romDir, PLAYLIST_NAME);
  await writeFile(playlistPath, renderM3u(bootPaths), "utf8");
  return playlistPath;
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
  if (existing?.isFile() && existing.size === file.sizeBytes) return target;

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
