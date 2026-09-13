// Kept free of Electron imports so the rate limiting stays unit-testable
// outside a running app.

/** Minimum gap between progress updates pushed to the renderer. */
export const PROGRESS_INTERVAL_MS = 100;

/**
 * A multi-gigabyte download fires its progress callback once per chunk, which
 * is tens of thousands of IPC messages and renderer DOM writes for a single
 * file, all competing with the transfer that produced them. Nobody can read
 * more than a few updates a second, so collapse the burst.
 *
 * Returns a predicate that answers whether this update is worth sending. The
 * clock is injectable so the behaviour can be tested without waiting.
 */
export function createProgressGate(
  intervalMs: number = PROGRESS_INTERVAL_MS,
  now: () => number = Date.now,
): (fraction: number | undefined) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (fraction) => {
    // A completed transfer always lands, so the reported figure never stops
    // short of where the download actually finished.
    if (fraction !== undefined && fraction >= 1) {
      last = now();
      return true;
    }
    const current = now();
    if (current - last < intervalMs) return false;
    last = current;
    return true;
  };
}
