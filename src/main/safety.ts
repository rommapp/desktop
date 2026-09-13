// Validation for the two pieces of launch input that come from the renderer.
// Deliberately free of Electron imports so it can be unit tested directly.

import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { LaunchError, type LaunchRequest } from "../shared/types.ts";

/**
 * Find a ROM inside the user's own copy of the library, so a server running on
 * this machine does not have to send back a file that is already on local disk.
 *
 * The root comes from the user's config and the server only supplies a suffix,
 * so this can never name an arbitrary file. The containment check is what
 * enforces that: an absolute path, or one built out of traversal segments,
 * resolves outside the root and is rejected rather than normalised.
 *
 * Returns null whenever the file cannot be used, so a caller falls back to
 * downloading instead of failing the launch.
 */
export function resolveLibraryRom(
  libraryPath: string | null,
  serverPath: string | undefined,
  expectedSize?: number,
): string | null {
  if (!libraryPath || !serverPath) return null;

  const root = resolve(libraryPath);
  const candidate = resolve(root, serverPath);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;

  let info;
  try {
    info = statSync(candidate);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  // A size mismatch means this is not the file the server meant, so fall back
  // rather than launch a different game that happens to share a name.
  if (expectedSize !== undefined && info.size !== expectedSize) return null;

  return candidate;
}

/** Resolve the renderer's download path against the bound server. Anything that
 *  lands off-origin or outside /api/ is rejected rather than normalised. */
export function resolveDownloadUrl(
  serverUrl: string,
  downloadPath: string,
): URL {
  if (!downloadPath.startsWith("/") || downloadPath.startsWith("//")) {
    throw new LaunchError(
      "invalid-request",
      `Download path must be server-relative: ${downloadPath}`,
    );
  }

  const base = new URL(serverUrl);
  const resolved = new URL(downloadPath, base);
  if (resolved.origin !== base.origin) {
    throw new LaunchError(
      "invalid-request",
      `Download path resolves off-origin: ${resolved.origin}`,
    );
  }
  if (!resolved.pathname.startsWith("/api/")) {
    throw new LaunchError(
      "invalid-request",
      `Download path is not an API route: ${resolved.pathname}`,
    );
  }
  return resolved;
}

/** Characters that are unsafe in a filename on at least one supported OS. */
const UNSAFE_FILENAME_CHARS = new RegExp('[/\\\\:*?"<>|]', "g");

/** Reduce a server-supplied name to one safe filename component; the result is
 *  only ever joined onto the cache directory. */
export function safeCacheFileName(fileName: string, romId: number): string {
  const cleaned = fileName
    .replace(UNSAFE_FILENAME_CHARS, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  // Prefixing with the ROM id keeps two games that share a filename apart and
  // guarantees a non-empty name when cleaning removes everything.
  return `${romId}-${cleaned || "rom"}`;
}

/** Check a launch request's shape before any of it reaches the filesystem or a
 *  child process. */
export function validateLaunchRequest(value: unknown): LaunchRequest {
  if (typeof value !== "object" || value === null) {
    throw new LaunchError(
      "invalid-request",
      "Launch request must be an object.",
    );
  }
  const candidate = value as Record<string, unknown>;

  const romId = candidate.romId;
  if (typeof romId !== "number" || !Number.isInteger(romId) || romId <= 0) {
    throw new LaunchError(
      "invalid-request",
      "romId must be a positive integer.",
    );
  }

  const downloadPath = candidate.downloadPath;
  if (typeof downloadPath !== "string" || downloadPath.length === 0) {
    throw new LaunchError("invalid-request", "downloadPath is required.");
  }

  const fileName = candidate.fileName;
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new LaunchError("invalid-request", "fileName is required.");
  }

  const platformSlug = candidate.platformSlug;
  if (typeof platformSlug !== "string" || platformSlug.length === 0) {
    throw new LaunchError("invalid-request", "platformSlug is required.");
  }

  const cores = candidate.cores;
  if (!Array.isArray(cores) || cores.some((core) => typeof core !== "string")) {
    throw new LaunchError(
      "invalid-request",
      "cores must be an array of strings.",
    );
  }

  const name = candidate.name;
  if (name !== undefined && typeof name !== "string") {
    throw new LaunchError("invalid-request", "name must be a string.");
  }

  const serverPath = candidate.serverPath;
  if (serverPath !== undefined && typeof serverPath !== "string") {
    throw new LaunchError("invalid-request", "serverPath must be a string.");
  }

  const fileSize = candidate.fileSize;
  if (
    fileSize !== undefined &&
    (typeof fileSize !== "number" ||
      !Number.isInteger(fileSize) ||
      fileSize < 0)
  ) {
    throw new LaunchError(
      "invalid-request",
      "fileSize must be a non-negative integer.",
    );
  }

  return {
    romId,
    downloadPath,
    fileName,
    platformSlug,
    cores: cores as string[],
    ...(name === undefined ? {} : { name }),
    ...(serverPath === undefined ? {} : { serverPath }),
    ...(fileSize === undefined ? {} : { fileSize }),
  };
}
