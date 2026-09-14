// A minimal reader for the one shape of archive this shell has to open: a
// libretro core zip, holding a single file, from the buildbot.
//
// Written rather than depended on because the project otherwise ships no
// runtime dependencies, and pulling one in to read a handful of headers would
// cost more in supply chain than it saves in code. The tradeoff is that only
// the two compression methods the buildbot actually uses are supported;
// anything else is rejected rather than half-handled.

import { crc32, inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
const CENTRAL_FIXED_SIZE = 46;
const LOCAL_FIXED_SIZE = 30;

/** A zip comment can be 64KB, and the record itself sits before it. */
const MAX_EOCD_SEARCH = 0xffff + EOCD_MIN_SIZE;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Ceiling on what one entry may unpack to.
 *
 * The largest libretro core, mame, is a couple of hundred megabytes unpacked,
 * so this leaves room while still bounding the allocation an archive can ask
 * for. Enforced before inflating: a limit on the compressed archive is no limit
 * at all when deflate manages better than 1000:1.
 */
export const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

/** Zip64 puts the real value in an extra field; these are the placeholders that
 *  say so. The buildbot's cores are megabytes, so rather than implement zip64
 *  this refuses the archive and says why. */
const ZIP64_MARKER_32 = 0xffffffff;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** Locate the end-of-central-directory record, scanning back from the end. */
function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - MAX_EOCD_SEARCH);
  for (let at = archive.length - EOCD_MIN_SIZE; at >= earliest; at -= 1) {
    if (archive.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  throw new ZipError("Not a zip archive: no end-of-central-directory record.");
}

interface CentralEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Read the central directory rather than trusting local headers: an entry
 * written with a data descriptor carries zeroed sizes in its local header, and
 * the central copy is the authoritative one.
 */
function readCentralDirectory(archive: Buffer): CentralEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let at = archive.readUInt32LE(eocd + 16);

  const entries: CentralEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_FIXED_SIZE > archive.length) {
      throw new ZipError("Central directory runs past the end of the archive.");
    }
    if (archive.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ZipError("Corrupt central directory entry.");
    }
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    entries.push({
      name: archive
        .subarray(at + CENTRAL_FIXED_SIZE, at + CENTRAL_FIXED_SIZE + nameLength)
        .toString("utf8"),
      method: archive.readUInt16LE(at + 10),
      crc: archive.readUInt32LE(at + 16),
      compressedSize: archive.readUInt32LE(at + 20),
      uncompressedSize: archive.readUInt32LE(at + 24),
      localHeaderOffset: archive.readUInt32LE(at + 42),
    });
    at += CENTRAL_FIXED_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Names of the files in the archive, for reporting what was found instead. */
export function listZipEntries(archive: Buffer): string[] {
  return readCentralDirectory(archive).map((entry) => entry.name);
}

/**
 * Pull one named file out of the archive.
 *
 * The caller names the entry it wants, and nothing else in the archive is
 * touched. That is deliberate: an extractor that walks the archive and writes
 * whatever it finds has to defend against entry names that escape the target
 * directory, and this never learns a path from the archive at all.
 */
export function extractZipEntry(
  archive: Buffer,
  name: string,
  maxUncompressedBytes: number = MAX_UNCOMPRESSED_BYTES,
): Buffer {
  const entries = readCentralDirectory(archive);
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    const found = entries.map((candidate) => candidate.name).join(", ");
    throw new ZipError(
      `Archive holds no entry named ${name}${found ? ` (found ${found})` : ""}.`,
    );
  }
  if (
    entry.compressedSize === ZIP64_MARKER_32 ||
    entry.uncompressedSize === ZIP64_MARKER_32 ||
    entry.localHeaderOffset === ZIP64_MARKER_32
  ) {
    throw new ZipError(`${name} is stored in zip64 format, which is not read.`);
  }

  const header = entry.localHeaderOffset;
  if (
    header + LOCAL_FIXED_SIZE > archive.length ||
    archive.readUInt32LE(header) !== LOCAL_SIGNATURE
  ) {
    throw new ZipError(`Corrupt local header for ${name}.`);
  }
  // The local header repeats the name and extra fields, and its extra field
  // length can differ from the central one, so the data offset has to be
  // computed from the local copy.
  const start =
    header +
    LOCAL_FIXED_SIZE +
    archive.readUInt16LE(header + 26) +
    archive.readUInt16LE(header + 28);
  const end = start + entry.compressedSize;
  if (end > archive.length) {
    throw new ZipError(`${name} runs past the end of the archive.`);
  }
  const compressed = archive.subarray(start, end);

  // Refuse before inflating, not after. Deflate reaches better than 1000:1 on
  // compressible input, so a cap on the archive alone lets a few hundred
  // kilobytes become hundreds of gigabytes of allocation, and comparing the
  // result against uncompressedSize afterwards is far too late.
  if (entry.uncompressedSize > maxUncompressedBytes) {
    throw new ZipError(
      `${name} declares ${entry.uncompressedSize} bytes, past the ${maxUncompressedBytes} limit.`,
    );
  }

  let contents: Buffer;
  switch (entry.method) {
    case METHOD_STORE:
      contents = Buffer.from(compressed);
      break;
    case METHOD_DEFLATE:
      try {
        // The declared size is a claim, so bound the inflation by it as well:
        // zlib stops and throws rather than growing past what the header
        // promised, which the length check below would only notice afterwards.
        contents = inflateRawSync(compressed, {
          maxOutputLength: Math.max(entry.uncompressedSize, 1),
        });
      } catch (error) {
        // Both a corrupt stream and one that overran its declared size arrive
        // here as zlib's own error types, and every caller of this reads a
        // ZipError.
        throw new ZipError(
          `${name} could not be inflated: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      break;
    default:
      throw new ZipError(
        `${name} uses compression method ${entry.method}, which is not read.`,
      );
  }

  if (contents.length !== entry.uncompressedSize) {
    throw new ZipError(
      `${name} unpacked to ${contents.length} bytes, expected ${entry.uncompressedSize}.`,
    );
  }
  // The core is about to be loaded into the emulator's address space, so a
  // transfer that arrived subtly wrong should fail here rather than there.
  if (crc32(contents) !== entry.crc) {
    throw new ZipError(`${name} failed its checksum.`);
  }
  return contents;
}
