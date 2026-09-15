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

/**
 * Fetch a file from the bound RomM server onto local disk.
 *
 * Shared with the firmware mirror, which pulls from the same server over the
 * same session and wants the same backpressure, the same cancellation and the
 * same refusal to treat a non-2xx body as a file.
 *
 * `maxBytes` is what the two callers disagree about. A ROM is whatever size the
 * library says and the user asked for it by name, so it has no cap. Firmware is
 * asked for on the user's behalf, from a list, against a size the server
 * declared beforehand -- so a body that runs past that size is not the file it
 * claimed to be, and streaming it to the end of the disk to find out is the
 * wrong way round.
 */
export function downloadFromServer({
  url,
  session,
  destination,
  onProgress,
  signal,
  maxBytes,
}: {
  url: URL;
  session: Session;
  destination: string;
  onProgress: (received: number, total: number | null) => void;
  signal: AbortSignal;
  /** Ceiling on the transfer, enforced against the declared length and again
   *  as the bytes arrive. Absent means no ceiling. */
  maxBytes?: number;
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

    // Opened once the response arrives, and closed before this promise settles
    // either way. Every caller deletes the file it was writing when a download
    // fails, and on Windows that removal fails while a handle is still open.
    let file: ReturnType<typeof createWriteStream> | null = null;
    let settled = false;

    const fail = (error: Error) => {
      // A failed transfer can be reported twice -- an aborted request emits its
      // own error, and a cancel during a write reaches both listeners -- and
      // the second report would otherwise close a file the next attempt had
      // already opened.
      if (settled) return;
      settled = true;
      request.abort();
      const stream = file;
      if (!stream || stream.closed) {
        reject(error);
        return;
      }
      // Rejected only once the descriptor is gone, so the caller's cleanup runs
      // against a file nothing is holding. Buffered bytes are discarded rather
      // than flushed: this file is about to be deleted.
      stream.once("close", () => reject(error));
      stream.destroy();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    signal.addEventListener("abort", () =>
      fail(new LaunchError("download-failed", "Download cancelled")),
    );

    request.on("error", (error) =>
      fail(new LaunchError("download-failed", error.message)),
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
      // Refused before a byte is written where the server says up front that it
      // is too big.
      if (maxBytes !== undefined && total !== null && total > maxBytes) {
        fail(
          new LaunchError(
            "download-failed",
            `${url.pathname} is ${total} bytes, past the ${maxBytes} limit`,
          ),
        );
        return;
      }
      let received = 0;

      const writing = createWriteStream(destination, {
        highWaterMark: WRITE_BUFFER_BYTES,
      });
      file = writing;
      writing.on("error", (error) => fail(error));

      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        // And again as it arrives, because a declared length is a claim: a
        // response that keeps going past the cap is stopped mid-stream rather
        // than after it has filled the disk.
        if (maxBytes !== undefined && received > maxBytes) {
          fail(
            new LaunchError(
              "download-failed",
              `${url.pathname} ran past the ${maxBytes} limit`,
            ),
          );
          return;
        }
        // A ROM can be several GB, so respect the write stream's backpressure
        // instead of buffering the whole transfer in memory.
        if (!writing.write(chunk)) {
          response.pause();
          writing.once("drain", () => response.resume());
        }
        onProgress(received, Number.isFinite(total) ? total : null);
      });
      response.on("error", (error: Error) =>
        fail(new LaunchError("download-failed", error.message)),
      );
      response.on("end", () => {
        if (settled) return;
        writing.end(() => finish());
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
    await downloadFromServer({
      url,
      session,
      destination: temp,
      onProgress,
      signal,
    });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }

  await evictToLimit(config.cachePath, config.cacheLimitBytes, romDir);
  return { path: target, fromCache: false };
}
