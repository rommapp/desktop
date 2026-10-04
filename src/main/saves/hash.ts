// Hashing a save the way the server does, so the two can be compared.
//
// RomM decides whether a save has changed by comparing MD5 digests: its
// `compute_content_hash` is `hashlib.md5(usedforsecurity=False).hexdigest()`
// over the raw bytes of anything that is not a zip, and a `.srm` never is. The
// shell has to produce the same digest for the same bytes or every negotiate
// would read as a conflict, so a file an emulator writes is md5 over its bytes
// and nothing else.
//
// A zip is the exception on the server, and a standalone emulator's save set
// travels as one: `hash_zip_contents` digests the entries rather than the
// archive, so two archives of the same files compare equal however they were
// compressed. `zipContentHash` reproduces that from the files themselves.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** The digest RomM's `compute_content_hash` produces for raw bytes. */
export function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

/**
 * The digest of a file on disk, or null when it cannot be read.
 *
 * Streamed rather than read whole, the way the server hashes an upload: a save
 * is usually small, but nothing stops it from being a memory card measured in
 * megabytes, and the digest does not need the bytes to be in memory to be
 * computed.
 *
 * Null rather than a throw, because of what the caller does with it. A save the
 * shell cannot read is one it has no opinion about: that is not evidence the
 * file changed, and failing a launch over a permissions bit would be a worse
 * outcome than not syncing. Null reads as "no hash" everywhere it is used.
 */
export async function hashFile(path: string): Promise<string | null> {
  try {
    const hash = createHash("md5");
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** Order two names the way Python's `sorted` does: by code point. UTF-16 code
 *  units disagree for anything past U+FFFF, which sorts below U+E000 there. */
function byCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference =
      left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * The digest RomM's `hash_zip_contents` gives an archive of these files.
 *
 * The md5 of every file's `name:md5` line, sorted by name and joined with
 * newlines. Directory entries are left out there, and never passed here.
 */
export function zipContentHash(
  files: readonly { name: string; contents: Uint8Array }[],
): string {
  const lines = [...files]
    .sort((a, b) => byCodePoint(a.name, b.name))
    .map((file) => `${file.name}:${md5Hex(file.contents)}`);
  return md5Hex(new TextEncoder().encode(lines.join("\n")));
}
