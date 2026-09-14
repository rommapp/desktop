import { type Session, net } from "electron";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { type DesktopConfig, LaunchError } from "../shared/types.ts";
import { evictToLimit } from "./cache/evict.ts";
import { resolveDownloadUrl, safeFileName } from "./safety.ts";

/** Electron's IncomingMessage is a Readable at runtime, but its published type
 *  only models the EventEmitter surface. */
type FlowControlledResponse = Electron.IncomingMessage &
  Pick<NodeJS.ReadableStream, "pause" | "resume">;

export interface CachedRom {
  path: string;
  /** True when the file was already present and no download was needed. */
  fromCache: boolean;
}

/**
 * Buffer size for the cache file being written.
 *
 * Node defaults this to 64KB, which is also roughly the size of a chunk
 * arriving from the network, so nearly every write fills the buffer exactly,
 * returns false, and costs a pause/resume round trip through the event loop.
 * The stream never gets to batch anything. Measured on a 64MB transfer of 64KB
 * chunks, the default stalls once per chunk and lands around 136MB/s, while a
 * 4MB buffer stalls 64x less and clears 1.9GB/s.
 */
const WRITE_BUFFER_BYTES = 4 * 1024 * 1024;

function download({
  url,
  session,
  destination,
  onProgress,
  signal,
}: {
  url: URL;
  session: Session;
  destination: string;
  onProgress: (received: number, total: number | null) => void;
  signal: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    // useSessionCookies attaches the romm_session cookie the window already
    // holds, so the shell never handles credentials itself.
    const request = net.request({
      url: url.toString(),
      session,
      useSessionCookies: true,
      method: "GET",
    });

    const fail = (error: Error) => {
      request.abort();
      reject(error);
    };

    signal.addEventListener("abort", () =>
      fail(new LaunchError("download-failed", "Download cancelled")),
    );

    request.on("error", (error) =>
      reject(new LaunchError("download-failed", error.message)),
    );

    request.on("response", (incoming) => {
      const response = incoming as FlowControlledResponse;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        fail(
          new LaunchError(
            "download-failed",
            `Server returned ${response.statusCode} for ${url.pathname}`,
          ),
        );
        return;
      }

      const header = response.headers["content-length"];
      const declared = Array.isArray(header) ? header[0] : header;
      const total = declared ? Number.parseInt(declared, 10) : null;
      let received = 0;

      const file = createWriteStream(destination, {
        highWaterMark: WRITE_BUFFER_BYTES,
      });
      file.on("error", (error) => fail(error));

      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        // A ROM can be several GB, so respect the write stream's backpressure
        // instead of buffering the whole transfer in memory.
        if (!file.write(chunk)) {
          response.pause();
          file.once("drain", () => response.resume());
        }
        onProgress(received, Number.isFinite(total) ? total : null);
      });
      response.on("error", (error: Error) =>
        fail(new LaunchError("download-failed", error.message)),
      );
      response.on("end", () => {
        file.end(() => resolve());
      });
    });

    request.end();
  });
}

/**
 * Make the ROM available on local disk, downloading it only when it is not
 * already cached. Emulators need a real file, so there is no streaming path.
 */
export async function ensureRom({
  config,
  session,
  romId,
  fileName,
  downloadPath,
  onProgress,
  signal,
}: {
  config: DesktopConfig;
  session: Session;
  romId: number;
  fileName: string;
  downloadPath: string;
  onProgress: (received: number, total: number | null) => void;
  signal: AbortSignal;
}): Promise<CachedRom> {
  if (!config.serverUrl) {
    throw new LaunchError("invalid-request", "No RomM server is configured.");
  }
  if (!config.cachePath) {
    throw new LaunchError("invalid-request", "No ROM cache directory is set.");
  }

  const url = resolveDownloadUrl(config.serverUrl, downloadPath);
  // A directory per ROM rather than a name-mangling prefix, so the file keeps
  // the name the server gave it. An emulator asked to derive anything from the
  // content name then agrees with a launch straight out of the library.
  const romDir = join(config.cachePath, String(romId));
  const target = join(romDir, safeFileName(fileName));

  const existing = await stat(target).catch(() => null);
  if (existing?.isFile() && existing.size > 0) {
    // Touch it so cache eviction treats a replayed game as recently used.
    const now = new Date();
    await utimes(target, now, now).catch(() => {});
    return { path: target, fromCache: true };
  }

  await mkdir(romDir, { recursive: true });
  // Download beside the target and rename on success, so an interrupted
  // transfer never leaves a truncated ROM that looks cached.
  const temp = `${target}.part`;
  try {
    await download({ url, session, destination: temp, onProgress, signal });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }

  await evictToLimit(config.cachePath, config.cacheLimitBytes, romDir);
  return { path: target, fromCache: false };
}
