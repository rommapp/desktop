// Kept apart from the downloader, which imports Electron's net and so cannot
// be loaded by the test runner. Same reasoning as safety.ts.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Cache entries are named for their ROM id and nothing else. */
const ROM_ID = /^\d+$/;

/** One cached ROM: the directory holding it, so eviction drops the game rather
 *  than picking files out from under it. */
interface CacheEntry {
  path: string;
  size: number;
  atime: number;
}

/** Measure the cache a ROM directory at a time. A directory usually holds one
 *  file, but keeps whatever a rename on the server left behind. */
async function readCache(dir: string): Promise<{
  total: number;
  entries: CacheEntry[];
}> {
  const cached = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const entries: CacheEntry[] = [];
  let total = 0;
  for (const romDir of cached) {
    const path = join(dir, romDir.name);
    // A flat file is a download from before the per-ROM layout. Counting it
    // keeps it inside the limit, and its age sends it out first.
    if (romDir.isFile()) {
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      total += info.size;
      entries.push({ path, size: info.size, atime: info.atimeMs });
      continue;
    }
    // Only a ROM id names a cache entry, so nothing else living under the
    // cache directory is ever a candidate for removal.
    if (!romDir.isDirectory() || !ROM_ID.test(romDir.name)) continue;
    const names = await readdir(path).catch(() => [] as string[]);
    let size = 0;
    let atime = 0;
    for (const name of names) {
      const info = await stat(join(path, name)).catch(() => null);
      if (!info?.isFile()) continue;
      size += info.size;
      atime = Math.max(atime, info.atimeMs);
    }
    if (size === 0) continue;
    total += size;
    entries.push({ path, size, atime });
  }
  return { total, entries };
}

/**
 * Drop least-recently-used ROMs until the cache fits under its limit. Runs
 * after a download so a fresh file is never the one evicted. `keep` is the ROM
 * directory this launch needs.
 */
export async function evictToLimit(
  dir: string,
  limitBytes: number,
  keep: string,
): Promise<void> {
  const { total, entries } = await readCache(dir);
  if (total <= limitBytes) return;

  entries.sort((a, b) => a.atime - b.atime);
  let remaining = total;
  for (const entry of entries) {
    if (remaining <= limitBytes) break;
    // The ROM this launch needs is never a candidate, even when it alone
    // exceeds the limit.
    if (entry.path === keep) continue;
    await rm(entry.path, { force: true, recursive: true });
    remaining -= entry.size;
  }
}
