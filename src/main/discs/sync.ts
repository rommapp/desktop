// Making a multi-disc game launchable.
//
// RomM serves a folder rom as one archive, and an archive is not something an
// emulator can boot a disc set out of: RetroArch cannot resolve a playlist's
// sibling references inside a zip, and PCSX2, Dolphin and RPCS3 cannot open one
// at all. So the discs are fetched as the individual files the server already
// has, one request each, and an .m3u naming them is written beside them.
//
// Nothing here can fail a launch. A server that will not answer, a rom whose
// files cannot be read, or a set with fewer than two discs all return null, and
// the caller falls back to the single-payload download it would have done.

import { type Session } from "electron";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl, resolveLibraryRom } from "../safety.ts";
import { readRomFiles, renderM3u, selectDiscs } from "./m3u.ts";

/** The playlist's own name inside the rom's directory. */
const PLAYLIST_NAME = "discs.m3u";

export interface DiscSet {
  /** What to hand the emulator. */
  path: string;
  /** How many discs the playlist names, for the progress the caller reports. */
  discCount: number;
  /** True when every disc was already on local disk, so nothing was fetched. */
  fromLibrary: boolean;
}

interface SyncOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  signal: AbortSignal;
  onProgress?: (
    fileName: string,
    received: number,
    total: number | null,
    /** 1-based place in the set, so a frontend can say "disc 2 of 4". */
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
 * Fetch a rom's discs and write the playlist that boots them, or null when this
 * rom is not a disc set or the server would not say.
 */
export async function syncDiscSet({
  config,
  session,
  romId,
  signal,
  onProgress,
}: SyncOptions): Promise<DiscSet | null> {
  if (!config.serverUrl || !config.cachePath) return null;

  const body = await getJson(
    config.serverUrl,
    session,
    `/api/roms/${romId}`,
    signal,
  );
  if (body === undefined) return null;

  const discs = selectDiscs(readRomFiles(body));
  // One disc is an ordinary launch, and the caller's own download handles it
  // without a playlist in the way.
  if (discs.length < 2) return null;

  // When the server runs on this machine every disc is already here, and a
  // playlist beside them costs nothing to write. Only taken when the whole set
  // resolves: a playlist half in the library and half in the cache would name
  // files in two directories, which a relative .m3u cannot do.
  const local = discs.map((disc) =>
    resolveLibraryRom(config.libraryPath, disc.fullPath, disc.sizeBytes),
  );
  if (local.every((path) => path !== null)) {
    const directory = dirnameOf(local[0] as string);
    const playlist = join(directory, PLAYLIST_NAME);
    await writeFile(playlist, renderM3u(discs), "utf8");
    return { path: playlist, discCount: discs.length, fromLibrary: true };
  }

  const romDir = join(config.cachePath, String(romId));
  await mkdir(romDir, { recursive: true });

  for (const [position, disc] of discs.entries()) {
    const target = join(romDir, disc.fileName);
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size === disc.sizeBytes) continue;

    // One file at a time, by id: the content endpoint serves a single requested
    // file directly rather than zipping it, which is the whole point of asking
    // per disc.
    const path = `/api/roms/${romId}/content/${encodeURIComponent(disc.fileName)}?file_ids=${disc.id}`;
    let url: URL;
    try {
      url = resolveDownloadUrl(config.serverUrl, path);
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
        maxBytes: disc.sizeBytes,
        onProgress: (received, total) =>
          onProgress?.(
            disc.fileName,
            received,
            total,
            position + 1,
            discs.length,
          ),
      });
      // Short is as wrong as long: a truncated disc that kept its name would be
      // treated as complete by every later launch.
      const written = await stat(temp).catch(() => null);
      if (!written || written.size !== disc.sizeBytes) {
        await rm(temp, { force: true });
        return null;
      }
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  const playlist = join(romDir, PLAYLIST_NAME);
  await writeFile(playlist, renderM3u(discs), "utf8");
  return { path: playlist, discCount: discs.length, fromLibrary: false };
}

/** The directory a resolved library path sits in. */
function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? path : path.slice(0, cut);
}
