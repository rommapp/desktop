// Fetching a file that the operating system is then asked to open.
//
// Shared by the RetroArch offer and the standalone emulator one. It exists as
// one function rather than two because the careful parts -- attaching the
// stream's error listener before the first write, checking the origin of the
// response rather than the request, refusing a transfer that stopped short --
// are exactly the parts that are easy to get subtly wrong twice.

import { net } from "electron";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { LaunchError } from "../shared/types.ts";
import { type OriginPolicy, isAllowedDownloadOrigin } from "./safety.ts";

export interface DownloadRequest {
  url: string;
  /** What to call it on disk. Taken from the release index, never from the
   *  response, so a redirect cannot choose the filename. */
  fileName: string;
  directory: string;
  /** Where the bytes may come from, request and final response alike. */
  policy: OriginPolicy;
  maxBytes: number;
  signal: AbortSignal;
  onProgress: (received: number, total: number | null) => void;
}

/**
 * Download to `directory/fileName`, returning the path.
 *
 * The directory is emptied first: these run at most once per machine and
 * leaving a second few-hundred-megabyte file behind would be litter.
 */
export async function downloadToFile({
  url,
  fileName,
  directory,
  policy,
  maxBytes,
  signal,
  onProgress,
}: DownloadRequest): Promise<string> {
  if (!isAllowedDownloadOrigin(url, policy)) {
    throw new LaunchError(
      "download-failed",
      `Refusing to download from ${url}`,
    );
  }

  const response = await net.fetch(url, { signal });
  // Redirects are followed, so the origin checked above says nothing about
  // where the bytes came from. This file is handed to the OS to open, so it is
  // the response that actually answered which has to be allowed.
  if (!isAllowedDownloadOrigin(response.url || url, policy)) {
    throw new LaunchError(
      "download-failed",
      `Refusing a response redirected to ${response.url}`,
    );
  }
  if (!response.ok) {
    throw new LaunchError(
      "download-failed",
      `Server returned ${response.status} for ${fileName}`,
    );
  }
  if (!response.body) {
    throw new LaunchError("download-failed", `Empty response for ${fileName}`);
  }

  const declared = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  const total = Number.isFinite(declared) ? declared : null;
  if (total !== null && total > maxBytes) {
    throw new LaunchError(
      "download-failed",
      `${fileName} is ${total} bytes, past the ${maxBytes} limit`,
    );
  }

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  const target = join(directory, fileName);
  // Write beside the target and rename, so an interrupted transfer cannot leave
  // a truncated file that the user then opens.
  const temp = `${target}.part`;
  const file = createWriteStream(temp);
  // Attached before the first write, not only around the backpressure wait: a
  // stream reports a failed open asynchronously, and an "error" with no
  // listener is an uncaught exception that takes the app down rather than
  // reaching the catch below.
  const failed = new Promise<never>((_resolve, reject) => {
    file.once("error", reject);
  });
  // Nothing settles this when the transfer succeeds, and an unobserved
  // rejection would be reported at exit.
  failed.catch(() => {});

  const reader = response.body.getReader();
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        await reader.cancel();
        throw new LaunchError(
          "download-failed",
          `${fileName} exceeded the ${maxBytes} byte limit`,
        );
      }
      // Respect the write stream's backpressure rather than holding a
      // multi-hundred-megabyte transfer in memory.
      if (!file.write(value)) {
        await Promise.race([
          new Promise<void>((resolve) => file.once("drain", resolve)),
          failed,
        ]);
      }
      onProgress(received, total);
    }
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        file.end((error?: Error | null) => (error ? reject(error) : resolve()));
      }),
      failed,
    ]);
  } catch (error) {
    file.destroy();
    await rm(temp, { force: true });
    throw error instanceof LaunchError
      ? error
      : new LaunchError(
          "download-failed",
          error instanceof Error ? error.message : String(error),
        );
  }

  // A transfer that stopped early still leaves a file, so check it against what
  // the server said before handing it to the OS to open.
  if (total !== null && received !== total) {
    await rm(temp, { force: true });
    throw new LaunchError(
      "download-failed",
      `${fileName} arrived as ${received} of ${total} bytes`,
    );
  }

  await rename(temp, target);
  return target;
}
