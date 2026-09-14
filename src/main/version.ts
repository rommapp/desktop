// Comparing dotted version numbers.
//
// Its own module because two unrelated things need it and the obvious homes
// would import each other: RetroArch's stable index, to pick the newest
// release, and macOS bundle names, to pick the newest installed emulator.

/**
 * Order two dotted versions numerically.
 *
 * Sorting these as text is the bug this exists to avoid: "1.9.14" sorts above
 * "1.10.0" alphabetically, which would pin a user to a release from years back.
 * A shorter version pads with zeroes rather than counting as smaller, so
 * "1.22" and "1.22.0" are the same version.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
