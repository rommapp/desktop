// Which launch is watching an emulator's user folder.
//
// Launches are keyed by ROM, so two different games can run the same
// standalone emulator at once, and both read the same save folder. Neither can
// tell the other's writes from its own, so whichever arrives second leaves the
// folder alone rather than claiming files it may not have written.
//
// That only keeps the second launch from watching; its emulator still runs and
// writes. So a claim someone else asked for while it was held is marked
// contested, and the holder's own reading of the folder is not to be trusted.

import { resolve } from "node:path";

export interface FolderClaim {
  /** Whether another launch wanted this folder while the claim was held. */
  readonly contested: boolean;
  /** Give the folder up. Releasing twice is harmless. */
  release(): void;
}

const claimed = new Map<string, { contested: boolean }>();

/** One spelling per folder, so two spellings of it collide. Windows and macOS
 *  compare paths without regard to case. */
function folderKey(folder: string, platform: NodeJS.Platform): string {
  const full = resolve(folder);
  return platform === "linux" ? full : full.toLowerCase();
}

/** Claim a folder for one launch, or null when another launch holds it, in
 *  which case that launch's claim is marked contested. */
export function claimFolder(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): FolderClaim | null {
  const key = folderKey(folder, platform);
  const holder = claimed.get(key);
  if (holder) {
    holder.contested = true;
    return null;
  }
  const state = { contested: false };
  claimed.set(key, state);
  return {
    get contested() {
      return state.contested;
    },
    release() {
      if (claimed.get(key) === state) claimed.delete(key);
    },
  };
}
