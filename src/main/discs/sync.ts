// Making a multi-disc game launchable.
//
// RomM serves a folder rom as one archive, and an archive is not something an
// emulator can boot a disc set out of: RetroArch cannot resolve a playlist's
// sibling references inside a zip, and PCSX2, Dolphin and RPCS3 cannot open one
// at all. So the discs are fetched as the individual files the server already
// has, one request each, and an .m3u naming them is written for the emulators
// that read one. The rest are handed the first disc, with the set beside it.
//
// The same goes for any multi-file rom: a single disc with its tracks or its
// manual, and a cartridge with a readme beside it, are fetched as the file
// that boots (and what it needs) rather than as an archive of everything.
//
// What happens when that fails depends on whether the archive could still
// work. A server that will not describe the rom, or a rom with no single file
// to boot, falls back to the ordinary download. A disc or a folder game does
// not: its archive is known not to boot, so the launch stops with a reason
// instead of handing the emulator a zip and leaving the player to read the
// emulator's error. A cancellation stays fatal, that one being the user's own.

import { type Session } from "electron";
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { folderGame, isFlatLayout } from "./folder.ts";
import { ALL_DISCS, type DesktopConfig } from "../../shared/types.ts";
import { apiRequest } from "../saves/http.ts";
import { evictToLimit } from "../cache/evict.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl, resolveLibraryRom } from "../safety.ts";
import {
  type DiscFile,
  ownPlaylist,
  readRomFiles,
  renderM3u,
  planRomFiles,
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
  /** Already-authorized metadata restricted to a complete installed snapshot. */
  metadata?: unknown;
  /** Whether this launch's emulator boots an .m3u. When it does not, the first
   *  disc is what starts the game and the rest of the set is a disc change away
   *  in the emulator's own menu, so no playlist is written. */
  playlist: boolean;
  platformSlug: string;
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
  try {
    const response = await apiRequest({ serverUrl, session, path, signal, method: "GET" });
    if (!response || response.status < 200 || response.status >= 300) return undefined;
    return response.body ?? undefined;
  } catch { return undefined; }
}

/**
 * What a launch should do with a rom's files.
 *
 * `not-mine` means the ordinary download is the right one, or the best left: a
 * single-file rom, a server that would not describe the rom, or a rom with no
 * rule for which of its files boots. `unstageable` means the rom is one the
 * ordinary download cannot serve (a disc set or a folder game, which arrive as
 * an archive no emulator boots), and staging it failed, so the launch should
 * stop and say so rather than hand the emulator a zip.
 */
export type DiscSyncResult =
  | { kind: "not-mine" }
  | { kind: "staged"; path: string }
  | { kind: "unstageable"; reason: string };

const NOT_MINE: DiscSyncResult = { kind: "not-mine" };

function staged(path: string): DiscSyncResult {
  return { kind: "staged", path };
}

function unstageable(reason: string): DiscSyncResult {
  return { kind: "unstageable", reason };
}

/**
 * Fetch a rom's files individually where the ordinary download would hand the
 * emulator an archive, and say what the emulator should be handed.
 */
export async function syncDiscSet({
  config,
  session,
  romId,
  signal,
  playlist,
  platformSlug,
  disc,
  onProgress,
  metadata,
}: SyncOptions): Promise<DiscSyncResult> {
  const { serverUrl, cachePath } = config;
  if (!serverUrl || !cachePath) return NOT_MINE;

  const body = metadata ?? await getJson(serverUrl, session, `/api/roms/${romId}`, signal);
  if (body === undefined) return NOT_MINE;

  const stage = (files: DiscFile[], relativePaths?: Map<number, string>) =>
    cachePaths({
      staged: files, serverUrl, session, romId, cachePath,
      cacheLimitBytes: config.cacheLimitBytes, signal, onProgress, relativePaths,
    });

  // RPCS3 and Cemu cannot open an archive at all, so for these platforms no
  // multi-file rom is one the ordinary download can serve.
  const folderPlatform = ["ps3", "ps3-games", "wiiu", "wii-u"].includes(platformSlug.toLowerCase());
  const folderFiles = folderPlatform ? readRomFiles(body, true) : [];
  const folder = folderGame(folderFiles, platformSlug);
  if (folder) {
    const paths = folderLibraryPaths(folder.files.map(({ file }) => file), config.libraryPath) ??
      (await stage(
        folder.files.map(({ file }) => file),
        new Map(folder.files.map(({ file, relativePath }) => [file.id, relativePath])),
      ));
    if (!(paths instanceof Map)) return unstageable(paths.reason);
    const boot = paths.get(folder.bootFileId);
    return boot ? staged(boot) : unstageable("The game's boot file was not staged.");
  }
  // A tree that is not a folder game, and not flat either, cannot be staged
  // file by file without losing part of it, and its archive does not boot.
  if (folderFiles.length > 1 && !isFlatLayout(folderFiles)) {
    return unstageable(
      "This rom's files are not a folder game the shell recognises, and the emulator cannot open them as an archive.",
    );
  }

  const files = readRomFiles(body);
  const plan = planRomFiles(files);
  if (plan.kind === "single") return NOT_MINE;
  if (plan.kind === "ambiguous") {
    if (folderPlatform) {
      return unstageable(
        "This rom's files are not a folder game the shell recognises, and the emulator cannot open them as an archive.",
      );
    }
    console.warn(
      `[discs] rom ${romId}: ${files.length} files and no single one to boot, using the server's archive`,
    );
    return NOT_MINE;
  }
  if (plan.kind === "boot") {
    const boot = plan.file;
    const paths = libraryPaths([boot], config.libraryPath) ?? (await stage([boot]));
    const path = paths instanceof Map ? paths.get(boot.id) : undefined;
    if (path) return staged(path);
    if (folderPlatform) {
      return unstageable(`Could not fetch ${boot.fileName} from the server.`);
    }
    // A cartridge in an archive is one RetroArch can often still open, so the
    // archive is a fallback here where it is not for a disc.
    console.warn(`[discs] rom ${romId}: could not fetch ${boot.fileName} alone, using the server's archive`);
    return NOT_MINE;
  }
  const { discs } = plan;

  // One disc of the set, where the page's disc selector picked one. Booted on
  // its own with no playlist in front of it, which is what that choice means:
  // the rest of the set is not fetched, so a four-disc game the player is only
  // replaying disc one of costs one transfer.
  const picked =
    discs.length < 2 || disc === undefined || disc === ALL_DISCS
      ? null
      : selectPickedDisc(files, disc);
  if (discs.length > 1 && disc !== undefined && disc !== ALL_DISCS && !picked) {
    // A pick the rom does not answer to, which a page whose view of the rom
    // predates a rescan can send. The whole set still plays the game.
    console.warn(
      `[discs] rom ${romId}: file ${disc} is not a disc of this rom, booting the whole set`,
    );
  }

  const toStage = picked
    ? selectStagedForDisc(files, picked)
    : selectStagedFiles(files);

  // The set comes from one place: all of it from the library, in one
  // directory, or all of it from the cache.
  const paths = libraryPaths(toStage, config.libraryPath) ?? (await stage(toStage));
  if (!(paths instanceof Map)) return unstageable(paths.reason);

  // The pick is the whole of what was staged, so it is the whole of what boots.
  if (picked) {
    const path = paths.get(picked.id);
    return path ? staged(path) : unstageable(`${picked.fileName} was not staged.`);
  }

  const bootPaths: string[] = [];
  for (const entry of discs) {
    const path = paths.get(entry.id);
    // A disc the staged set does not hold is a set that cannot be launched.
    if (!path) return unstageable(`${entry.fileName} was not staged.`);
    bootPaths.push(path);
  }

  // A single disc boots as itself, and so does a set whose emulator takes the
  // first disc and finds the rest beside it.
  if (bootPaths.length === 1 || !playlist) return staged(bootPaths[0]!);

  // A set that ships its own playlist has an order nobody should be guessing
  // at, and it was staged with the discs, so its relative entries resolve.
  const own = ownPlaylist(toStage);
  const ownPath = own && paths.get(own.id);
  if (ownPath) return staged(ownPath);

  // Written to the cache even when every disc came from the library, because
  // the library is the user's and a playlist left in it is one more file for
  // RomM to scan.
  const romDir = join(cachePath, String(romId));
  await mkdir(romDir, { recursive: true });
  const playlistPath = join(romDir, PLAYLIST_NAME);
  await writeFile(playlistPath, renderM3u(bootPaths), "utf8");
  return staged(playlistPath);
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

/** Folder games may legitimately span multiple subdirectories. */
function folderLibraryPaths(staged: DiscFile[], libraryPath: string | null): Map<number, string> | null {
  const paths = new Map<number, string>();
  for (const file of staged) {
    const path = resolveLibraryRom(libraryPath, file.fullPath, file.sizeBytes);
    if (!path) return null;
    paths.set(file.id, path);
  }
  return paths;
}

/** Fetch the whole set into this rom's cache directory, or the reason it could
 *  not all be fetched. */
async function cachePaths({
  staged,
  serverUrl,
  session,
  romId,
  cachePath,
  cacheLimitBytes,
  signal,
  onProgress,
  relativePaths,
}: {
  staged: DiscFile[];
  serverUrl: string;
  session: Session;
  romId: number;
  cachePath: string;
  cacheLimitBytes: number;
  signal: AbortSignal;
  onProgress: SyncOptions["onProgress"];
  relativePaths?: Map<number, string>;
}): Promise<Map<number, string> | { reason: string }> {
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
      relativePath: relativePaths?.get(file.id),
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
    if (!target) {
      return { reason: `Could not fetch ${file.fileName} from the server.` };
    }
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
  relativePath,
  signal,
  onProgress,
}: {
  serverUrl: string;
  session: Session;
  romId: number;
  romDir: string;
  file: DiscFile;
  relativePath?: string;
  signal: AbortSignal;
  onProgress: (received: number, total: number | null) => void;
}): Promise<string | null> {
  const target = join(romDir, relativePath ?? file.fileName);
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

  // A sibling .part file can be a legitimate game asset. Keep temporary
  // downloads outside the ROM tree, using a unique directory per transfer.
  const tempDir = await mkdtemp(join(dirname(romDir), ".romm-stage-"));
  const temp = join(tempDir, "download");
  try {
    if (relativePath) await mkdir(dirname(target), { recursive: true });
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
      return null;
    }
    await rename(temp, target);
    return target;
  } catch (error) {
    // A cancellation is the user's and stays fatal. A refused or interrupted
    // transfer is reported to the caller, which knows whether the server's
    // archive is worth falling back to for this rom.
    if (signal.aborted) throw error;
    return null;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}
