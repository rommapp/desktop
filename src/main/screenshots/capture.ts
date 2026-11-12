// Each native run gets an empty screenshot directory. That makes every image
// in it this run's, without guessing RetroArch's filenames or comparing a
// shared folder while the next run is writing. Local captures stay on disk even
// when delivery fails; only the bounded reads and upload decisions live here,
// so they can be exercised without importing Electron.

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { DesktopConfig } from "../../shared/types.ts";

export const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_SCREENSHOTS = 256;

export async function prepareScreenshots(
  config: DesktopConfig,
  romId: number,
  builtInRetroArch: boolean,
): Promise<string | null> {
  if (!config.syncScreenshots || !config.serverUrl || !config.saveDataPath || !builtInRetroArch) return null;
  if (!Number.isSafeInteger(romId) || romId < 1) return null;
  // Quotes and line breaks cannot be represented safely in retroarch.cfg;
  // pipes delimit its --appendconfig argument, so decline those paths too.
  if (/["\r\n|]/.test(config.saveDataPath)) return null;
  try {
    const parent = join(config.saveDataPath, String(romId), "screenshots");
    await mkdir(parent, { recursive: true });
    const directory = join(parent, randomUUID());
    await mkdir(directory);
    return directory;
  } catch (error) {
    console.warn(`[screenshots] rom ${romId}: could not prepare captures`, error);
    return null;
  }
}

export interface ScreenshotUpload {
  fileName: string;
  bytes: Uint8Array;
}

/** Read at most one bounded image at a time. Symlinks, folders, empty files
 *  and unrelated files never become uploads. An upload failure costs that
 *  capture's delivery, never its local bytes or the rest of the run. */
export async function pushScreenshots(options: {
  directory: string;
  signal: AbortSignal;
  upload: (capture: ScreenshotUpload) => Promise<boolean>;
}): Promise<{ uploaded: number; failed: number }> {
  const { directory, signal, upload } = options;
  let uploaded = 0;
  let failed = 0;
  if (!(await lstat(directory)).isDirectory()) return { uploaded, failed };
  const entries = await opendir(directory);
  let visited = 0;
  for await (const entry of entries) {
    if (signal.aborted || visited++ >= MAX_SCREENSHOTS) break;
    if (!entry.isFile() || !/\.(png|bmp)$/i.test(entry.name)) continue;
    try {
      const file = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Uint8Array;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SCREENSHOT_BYTES) {
          failed++;
          continue;
        }
        // One extra byte detects a file growing since stat without allowing
        // readFile to allocate an unbounded buffer for it.
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await file.read(buffer, length, buffer.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== stat.size) {
          failed++;
          continue;
        }
        bytes = buffer.subarray(0, length);
      } finally {
        await file.close();
      }
      if (signal.aborted) break;
      // A run id keeps identical emulator filenames from replacing another
      // machine's captures in RomM, whose upload endpoint updates by filename.
      // Hash the complete name instead of truncating it: timestamps near the
      // end distinguish captures, and the image extension must survive intact.
      const nameHash = createHash("sha256").update(entry.name).digest("hex");
      const extension = extname(entry.name).toLowerCase();
      const fileName = `${basename(directory)}-${nameHash}${extension}`;
      if (await upload({ fileName, bytes })) uploaded++;
      else failed++;
    } catch (error) {
      if (signal.aborted) break;
      failed++;
      console.warn(`[screenshots] could not send ${entry.name}`, error);
    }
  }
  return { uploaded, failed };
}
