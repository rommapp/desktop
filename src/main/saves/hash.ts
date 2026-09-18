// Hashing a save the way the server does, so the two can be compared.
//
// RomM decides whether a save has changed by comparing MD5 digests: its
// `compute_content_hash` is `hashlib.md5(usedforsecurity=False).hexdigest()`
// over the raw bytes of anything that is not a zip, and a `.srm` never is. The
// shell has to produce the same digest for the same bytes or every negotiate
// would read as a conflict, so this is md5 over the file and nothing else. The
// zip branch the server also has is deliberately not reproduced, because the
// only file this ever hashes is the one an emulator writes.

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
