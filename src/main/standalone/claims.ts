// Which launch is watching an emulator's user folder.
//
// Launches are keyed by ROM, so two different games can run the same
// standalone emulator at once, and both read the same save folder. Neither can
// tell the other's writes from its own, so whichever arrives second leaves the
// folder alone rather than claiming files it may not have written.

import { resolve } from "node:path";

const claimed = new Set<string>();

/** One spelling per folder, so two spellings of it collide. Windows and macOS
 *  compare paths without regard to case. */
function folderKey(folder: string, platform: NodeJS.Platform): string {
  const full = resolve(folder);
  return platform === "linux" ? full : full.toLowerCase();
}

/**
 * Claim a folder for one launch, returning the function that releases it, or
 * null when another launch holds it. Releasing twice is harmless.
 */
export function claimFolder(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): (() => void) | null {
  const key = folderKey(folder, platform);
  if (claimed.has(key)) return null;
  claimed.add(key);
  let held = true;
  return () => {
    if (held) claimed.delete(key);
    held = false;
  };
}
