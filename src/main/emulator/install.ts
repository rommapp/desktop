import { net } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LaunchError } from "../../shared/types.ts";
import { extractZipEntry } from "../zip.ts";
import {
  BUILDBOT_ORIGIN,
  assertBuildbotResponse,
  coreDownloadUrl,
} from "./buildbot.ts";
import { coreFileName } from "./resolve.ts";

/**
 * Refuse an implausibly large response rather than inflating it.
 *
 * Most cores are a few megabytes; the largest, mame, is a couple of hundred.
 * The whole archive is held in memory because reading a zip means seeking to
 * its central directory, so the ceiling is what keeps a wrong URL from becoming
 * an allocation the size of the response.
 */
const MAX_CORE_ARCHIVE_BYTES = 512 * 1024 * 1024;

export interface InstalledCore {
  name: string;
  path: string;
}

export interface CoreDownloadProgress {
  core: string;
  received: number;
  total: number | null;
}

async function fetchArchive(
  url: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number | null) => void,
): Promise<Buffer | null> {
  // net.fetch rather than global fetch: it goes through Chromium's stack, so it
  // honours the system proxy and certificate store the same way the window
  // does.
  const response = await net.fetch(url, { signal });
  // Checking the requested URL is not enough: net.fetch follows redirects, so
  // the bytes that arrive can come from somewhere else entirely while the
  // origin check on the request still passes. This ends up loaded into the
  // emulator's address space, so it is the final URL that has to be on the
  // buildbot.
  assertBuildbotResponse(response, url);
  // A core the buildbot does not build for this architecture is a 404, and the
  // caller should simply try the next candidate.
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new LaunchError(
      "download-failed",
      `Buildbot returned ${response.status}`,
    );
  }

  const declared = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  const total = Number.isFinite(declared) ? declared : null;
  if (total !== null && total > MAX_CORE_ARCHIVE_BYTES) {
    throw new LaunchError(
      "download-failed",
      `Core archive is ${total} bytes, past the ${MAX_CORE_ARCHIVE_BYTES} limit`,
    );
  }
  if (!response.body) {
    throw new LaunchError("download-failed", "Buildbot sent an empty response");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    // The declared length is a claim, so hold the ceiling against what actually
    // arrives as well.
    if (received > MAX_CORE_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new LaunchError(
        "download-failed",
        `Core archive exceeded the ${MAX_CORE_ARCHIVE_BYTES} byte limit`,
      );
    }
    chunks.push(Buffer.from(value));
    onProgress(received, total);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch the first of a platform's candidate cores that the buildbot publishes,
 * and unpack it into the user's cores directory.
 *
 * Candidates arrive in the frontend's own order of preference, and the first
 * one that exists wins, which mirrors how an already-installed core is chosen.
 * A core missing for this architecture is a 404 and moves on to the next.
 */
export async function installCore({
  coresPath,
  cores,
  signal,
  onProgress,
}: {
  coresPath: string;
  cores: string[];
  signal: AbortSignal;
  onProgress: (progress: CoreDownloadProgress) => void;
}): Promise<InstalledCore> {
  const failures: string[] = [];

  for (const core of cores) {
    const url = coreDownloadUrl(core);
    // Either the name is not one that may become a path, or this machine has no
    // buildbot directory at all. Neither is worth reporting per candidate.
    if (!url) continue;
    // The URL is built here, but assert the origin anyway: this ends in a file
    // the emulator loads, and the check costs nothing.
    if (new URL(url).origin !== BUILDBOT_ORIGIN) continue;

    let archive: Buffer | null;
    try {
      archive = await fetchArchive(url, signal, (received, total) =>
        onProgress({ core, received, total }),
      );
    } catch (error) {
      if (signal.aborted) {
        throw new LaunchError("download-failed", "Download cancelled");
      }
      failures.push(
        `${core}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!archive) {
      failures.push(`${core}: not published for this system`);
      continue;
    }

    const fileName = coreFileName(core);
    let contents: Buffer;
    try {
      // The entry is named, never read from the archive, so nothing in the zip
      // can decide where this is written.
      contents = extractZipEntry(archive, fileName);
    } catch (error) {
      failures.push(
        `${core}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const target = join(coresPath, fileName);
    await mkdir(coresPath, { recursive: true });

    // Two games on the same platform can be launched at once: the registry is
    // keyed by ROM id, so both reach this for the same core. If the other one
    // finished first its core is already in place and correct, so take it
    // rather than writing over a file the emulator may be loading.
    if (existsSync(target)) return { name: core, path: target };

    // Write beside the target and rename, so an interrupted write cannot leave
    // a truncated core that then looks installed. The suffix is unique per
    // attempt for the same reason: two concurrent launches sharing one .part
    // would interleave their writes.
    const temp = `${target}.${process.pid}.${randomUUID()}.part`;
    try {
      await writeFile(temp, contents);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      // Losing the rename to a concurrent launch is success, not failure:
      // Windows refuses to rename onto an existing file, and that file is the
      // same core.
      if (existsSync(target)) return { name: core, path: target };
      throw new LaunchError(
        "download-failed",
        `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return { name: core, path: target };
  }

  // Every candidate failed to download. The emulator is present -- canInstallCore
  // required it -- so this is a transfer problem, and calling it a configuration
  // one would send the user to fix the wrong thing.
  throw new LaunchError(
    "download-failed",
    failures.length
      ? `No core could be downloaded (${failures.join("; ")}).`
      : "No core could be downloaded for this system.",
  );
}
