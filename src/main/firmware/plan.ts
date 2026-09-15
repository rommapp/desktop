// Reading RomM's firmware library, and deciding what that means for the mirror.
//
// Two endpoints, because firmware is keyed by platform id and a launch only
// knows the slug: /api/platforms says which id a slug is, /api/firmware lists
// what that platform has. Both are the endpoints RomM's own frontend calls.
//
// Everything here is a pure function of what the server said, so every shape a
// hand-edited library or an older server can produce is exercised directly
// rather than mocked. The requesting lives in sync.ts.

import { isPlainFileName } from "../safety.ts";

/** One firmware file as the server describes it. */
export interface RemoteFirmware {
  id: number;
  /** The name the emulator will look for, which is why it is not rewritten. */
  fileName: string;
  size: number;
}

/** One firmware file as it exists in the mirror now. */
export interface LocalFirmware {
  fileName: string;
  size: number;
}

/**
 * The platform id RomM gives this slug, or null when it has none.
 *
 * Matched on `slug` rather than `fs_slug`: the launch request carries the slug
 * RomM's frontend uses, and a library whose directory on disk is named
 * something else still reports the same `slug` here. Compared without regard to
 * case, as every other slug comparison in the shell is.
 */
export function platformIdFor(platforms: unknown, slug: string): number | null {
  if (!Array.isArray(platforms)) return null;
  const wanted = slug.toLowerCase();
  for (const entry of platforms) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, slug: candidate } = entry as { id?: unknown; slug?: unknown };
    if (typeof candidate !== "string" || candidate.toLowerCase() !== wanted) {
      continue;
    }
    // A non-integer id would end up in a URL path, so it has to be one.
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
    return id;
  }
  return null;
}

/**
 * The firmware list, reduced to the entries worth fetching.
 *
 * Dropped here rather than later: a row whose file the server has lost
 * (`missing_from_fs`) answers 404, and a name that is not a plain filename is
 * not something to create. The second is the important one -- these names are
 * used verbatim, because an emulator looks for `scph5501.bin` and not for
 * whatever the shell would have rewritten it to. A name carrying a path
 * separator therefore cannot be sanitised into safety without breaking the only
 * thing it is for, so it is refused instead.
 */
export function readFirmwareList(firmware: unknown): RemoteFirmware[] {
  if (!Array.isArray(firmware)) return [];
  const found: RemoteFirmware[] = [];
  const seen = new Set<string>();
  for (const entry of firmware) {
    if (typeof entry !== "object" || entry === null) continue;
    const {
      id,
      file_name: fileName,
      file_size_bytes: size,
      missing_from_fs: missing,
    } = entry as {
      id?: unknown;
      file_name?: unknown;
      file_size_bytes?: unknown;
      missing_from_fs?: unknown;
    };
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
    if (typeof fileName !== "string" || !isPlainFileName(fileName)) continue;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      continue;
    }
    if (missing === true) continue;
    // Two rows naming one file would fight over the same path on disk, and the
    // mirror would flip between them on alternate launches. First wins.
    const key = fileName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ id, fileName, size });
  }
  return found;
}

export interface FirmwareSyncPlan {
  /** Files to download, because they are absent or the wrong size. */
  fetch: RemoteFirmware[];
  /** Files in the mirror the server no longer lists, to be deleted. */
  remove: string[];
  /** How many files the server lists for this platform. Zero means it has no
   *  firmware at all, which is the usual answer. What the mirror ends up
   *  holding is counted from disk afterwards instead, since a fetch can fail. */
  total: number;
}

/**
 * Work out what the mirror needs to become the server's list.
 *
 * The size is what decides a re-download, not mere presence: a transfer that
 * died mid-write, or a file replaced in RomM by a better dump under the same
 * name, both show up as a size that no longer matches. This is the same test
 * the local-library lookup applies to a ROM, for the same reason -- a file of
 * the right name is not evidence of the right contents.
 *
 * Removal is what keeps this a mirror rather than an accumulation. Deleting
 * firmware in RomM should take it off this machine too, and an emulator that
 * scans its system directory will otherwise keep finding a file nobody meant to
 * keep.
 */
export function planFirmwareSync(
  remote: RemoteFirmware[],
  local: LocalFirmware[],
): FirmwareSyncPlan {
  const onDisk = new Map(
    local.map((file) => [file.fileName.toLowerCase(), file]),
  );
  const fetch = remote.filter((wanted) => {
    const here = onDisk.get(wanted.fileName.toLowerCase());
    return !here || here.size !== wanted.size;
  });

  // Compared case-insensitively, because Windows and macOS would treat
  // SCPH5501.BIN and scph5501.bin as one file and deleting "the one the server
  // does not list" would take the one it does.
  const wanted = new Set(remote.map((file) => file.fileName.toLowerCase()));
  const remove = local
    .filter((file) => !wanted.has(file.fileName.toLowerCase()))
    .map((file) => file.fileName);

  return { fetch, remove, total: remote.length };
}
