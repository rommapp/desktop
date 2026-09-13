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

/** How quickly the reported rate forgets an older sample. */
export const RATE_HALF_LIFE_MS = 2_000;

/**
 * Track transfer speed in bytes per second.
 *
 * The instantaneous rate between two samples swings wildly, because chunks
 * arrive unevenly and the samples are only a tenth of a second apart, so this
 * smooths them. The weight is derived from elapsed time rather than a fixed
 * factor, so an irregular sampling interval does not distort the result.
 *
 * Returns undefined until there are two samples to compare.
 */
export function createRateMeter(
  halfLifeMs: number = RATE_HALF_LIFE_MS,
  now: () => number = Date.now,
): (received: number) => number | undefined {
  let lastAt: number | null = null;
  let lastBytes = 0;
  let rate: number | undefined;

  return (received) => {
    const at = now();
    if (lastAt === null) {
      lastAt = at;
      lastBytes = received;
      return undefined;
    }
    const elapsed = at - lastAt;
    if (elapsed <= 0) return rate;

    const instant = ((received - lastBytes) * 1000) / elapsed;
    const weight = 1 - Math.exp(-elapsed / halfLifeMs);
    rate = rate === undefined ? instant : rate + (instant - rate) * weight;

    lastAt = at;
    lastBytes = received;
    return rate;
  };
}
