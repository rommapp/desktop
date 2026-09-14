// Validation for the two pieces of launch input that come from the renderer.
// Deliberately free of Electron imports so it can be unit tested directly.

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type DesktopConfig,
  LaunchError,
  type LaunchRequest,
} from "../shared/types.ts";

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
  if (!isWithin(root, candidate)) return null;

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

/** Characters that are unsafe in a filename on at least one supported OS.
 *  Control characters included: a NUL truncates the path for whatever
 *  eventually opens the file, and the rest are unprintable in a file manager. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = new RegExp('[/\\\\:*?"<>|\\u0000-\\u001f]', "g");

/** Names Windows reserves for devices. Reserved whatever the extension, so
 *  `CON.zip` is as unopenable as `CON`. Rewritten on every platform so a file
 *  written on one stays usable on another. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Reduce a server-supplied name to one safe filename component; the result is
 *  only ever joined onto a directory the shell owns. */
export function safeFileNameComponent(fileName: string): string {
  return (
    fileName
      .replace(UNSAFE_FILENAME_CHARS, "_")
      // Trim before dropping leading dots, or " .." survives as ".." and
      // addresses the parent directory rather than a file in it.
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 120)
      // Windows ignores trailing dots and spaces, so leaving them would let
      // "game." and "game" name one file while looking like two.
      .replace(/[. ]+$/, "")
  );
}

/** One filename component that is safe to create: never empty, never a path,
 *  never a Windows device name. */
export function safeFileName(fileName: string): string {
  const cleaned = safeFileNameComponent(fileName) || "rom";
  // Windows reads the device name up to the first dot, so CON.foo.zip is the
  // console too.
  const stem = cleaned.split(".")[0] ?? "";
  return WINDOWS_RESERVED.test(stem) ? `_${cleaned}` : cleaned;
}

/**
 * Whether `child` is `parent` or sits underneath it, once both are resolved.
 *
 * Asking `relative` rather than comparing prefixes: a filesystem root resolves
 * to a trailing separator of its own, so the prefix form misses `/` entirely,
 * and on Windows this picks up the case insensitivity that `C:\Cache` and
 * `c:\cache` need.
 */
export function isWithin(parent: string, child: string): boolean {
  const step = relative(resolve(parent), resolve(child));
  return step === "" || (!step.startsWith("..") && !isAbsolute(step));
}

/**
 * The path with every symlink above it followed, so two names for one
 * directory compare equal. A path that does not exist yet still resolves as
 * far as its nearest existing ancestor, which is where a link would sit.
 */
function canonical(path: string): string {
  const full = resolve(path);
  let existing = full;
  for (;;) {
    try {
      return join(realpathSync(existing), relative(existing, full));
    } catch {
      const parent = dirname(existing);
      // Nothing above resolves, so the lexical path is the best answer there is.
      if (parent === existing) return full;
      existing = parent;
    }
  }
}

/**
 * Refuse a cache and a save-data tree that contain one another. Eviction
 * removes a ROM directory whole, so an overlapping save tree would be deleted
 * along with the game it belongs to.
 */
export function assertSeparateRoots(config: DesktopConfig): void {
  const { cachePath, saveDataPath } = config;
  if (!cachePath || !saveDataPath) return;
  // Compared canonically: a saveDataPath symlinked at the cache is the same
  // directory under a different name, and eviction would not care which.
  const cache = canonical(cachePath);
  const saves = canonical(saveDataPath);
  if (isWithin(cache, saves) || isWithin(saves, cache)) {
    throw new LaunchError(
      "invalid-request",
      `saveDataPath (${saveDataPath}) and cachePath (${cachePath}) overlap. Cache eviction would delete save data, so set them to separate directories.`,
    );
  }
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

/**
 * Where a download is allowed to come from.
 *
 * Exact origins for a host that serves its own files, and host suffixes for one
 * that hands off to a CDN: a GitHub release asset answers from
 * release-assets.githubusercontent.com, and that name has changed before, so
 * pinning today's spelling would break the next time it does.
 */
export interface OriginPolicy {
  /** Full origins, compared exactly. */
  origins?: string[];
  /** Registrable suffixes, e.g. "githubusercontent.com". */
  hostSuffixes?: string[];
}

/**
 * Whether a URL is one of these downloads may come from.
 *
 * Applied to the response's final URL as well as the request, because redirects
 * are followed and everything fetched this way is either loaded into an
 * emulator or handed to the OS to run. A suffix has to match on a dot boundary,
 * so evil-githubusercontent.com cannot pass as githubusercontent.com, and plain
 * http never qualifies however the host reads.
 */
export function isAllowedDownloadOrigin(
  url: string,
  policy: OriginPolicy,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (policy.origins?.includes(parsed.origin)) return true;
  return (
    policy.hostSuffixes?.some(
      (suffix) =>
        parsed.hostname === suffix || parsed.hostname.endsWith(`.${suffix}`),
    ) ?? false
  );
}

/**
 * Whether a name is already safe to create, so nothing has to be rewritten.
 *
 * Rejects where safeFileName above rewrites, because these files are handed to
 * the operating system to open: a release index naming something with a path
 * separator in it means something is wrong, and quietly renaming it and running
 * it anyway is the wrong answer. Defined as "the sanitiser would leave this
 * alone", so there is one rule about filenames here rather than two that can
 * drift apart.
 */
export function isPlainFileName(name: string): boolean {
  return safeFileName(name) === name;
}
