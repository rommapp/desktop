// A minimal zip reader and writer for the two shapes of archive this shell
// handles: a libretro core zip from the buildbot, holding a single file, and a
// standalone emulator's save set, which RomM keeps as one zipped save.
//
// Written rather than depended on because the project otherwise ships no
// runtime dependencies, and pulling one in to read a handful of headers would
// cost more in supply chain than it saves in code. The tradeoff is that only
// store and deflate are supported, and no zip64; anything else is rejected
// rather than half-handled.

import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

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

const FLAG_ENCRYPTED = 1 << 0;
/** General purpose bit 11: the name is UTF-8 rather than code page 437. */
const FLAG_UTF8 = 1 << 11;

/** Unix file type bits, which a unix zipper keeps in the top half of the
 *  external attributes. */
const UNIX_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;
const UNIX_DIRECTORY = 0o040000;
const MADE_BY_UNIX = 3;
/** The MS-DOS directory attribute, in the low byte of the external ones. */
const DOS_DIRECTORY = 0x10;

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
  flags: number;
  method: number;
  /** The high byte of "version made by": 3 means the attributes are unix. */
  madeBy: number;
  externalAttributes: number;
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
      flags: archive.readUInt16LE(at + 8),
      method: archive.readUInt16LE(at + 10),
      madeBy: archive.readUInt8(at + 5),
      externalAttributes: archive.readUInt32LE(at + 38),
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
  return inflateEntry(archive, entry, maxUncompressedBytes);
}

/** The bytes of one central directory entry, checked against its header. */
function inflateEntry(
  archive: Buffer,
  entry: CentralEntry,
  maxUncompressedBytes: number,
): Buffer {
  const { name } = entry;
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new ZipError(`${name} is encrypted, which is not read.`);
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
      // A stored entry is its own uncompressed bytes, so the two sizes must
      // agree, and checking before the copy lets the size limit bound it.
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new ZipError(
          `${name} is stored as ${entry.compressedSize} bytes but declares ${entry.uncompressedSize}.`,
        );
      }
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
  // A core is about to be loaded into the emulator's address space and a save
  // into a game, so bytes that arrived subtly wrong should fail here instead.
  if (crc32(contents) !== entry.crc) {
    throw new ZipError(`${name} failed its checksum.`);
  }
  return contents;
}

/** One file in an archive, as read or as about to be written. */
export interface ZipFile {
  /** Relative, "/"-separated. */
  name: string;
  contents: Buffer;
  /** Milliseconds. Kept at the two-second precision a zip records. */
  modifiedAt: number;
}

export interface ZipLimits {
  maxEntries: number;
  /** Across the whole archive, not per entry: a thousand entries at the
   *  per-entry ceiling is the same allocation as one. */
  maxTotalBytes: number;
}

/** A symlink cannot be written out without trusting where it points, and a
 *  save set never holds one. */
function isSymlink(entry: CentralEntry): boolean {
  return (
    entry.madeBy === MADE_BY_UNIX &&
    ((entry.externalAttributes >>> 16) & UNIX_TYPE_MASK) === UNIX_SYMLINK
  );
}

function isDirectory(entry: CentralEntry): boolean {
  if (entry.name.endsWith("/")) return true;
  if (entry.madeBy === MADE_BY_UNIX) {
    return (
      ((entry.externalAttributes >>> 16) & UNIX_TYPE_MASK) === UNIX_DIRECTORY
    );
  }
  return (entry.externalAttributes & DOS_DIRECTORY) !== 0;
}

/**
 * Every file in the archive, with directory entries dropped.
 *
 * Names come back exactly as the archive spells them. Nothing here writes to
 * disk, so turning a name into a path, and refusing one that escapes, is the
 * caller's job at the point it becomes one.
 */
export function readZipFiles(archive: Buffer, limits: ZipLimits): ZipFile[] {
  const entries = readCentralDirectory(archive);
  if (entries.length > limits.maxEntries) {
    throw new ZipError(
      `Archive holds ${entries.length} entries, past the ${limits.maxEntries} limit.`,
    );
  }
  const files: ZipFile[] = [];
  let budget = limits.maxTotalBytes;
  for (const entry of entries) {
    if (isSymlink(entry)) {
      throw new ZipError(`${entry.name} is a symlink, which is not read.`);
    }
    // Before the directory skip, so an encrypted directory is refused too.
    if (entry.flags & FLAG_ENCRYPTED) {
      throw new ZipError(`${entry.name} is encrypted, which is not read.`);
    }
    if (isDirectory(entry)) continue;
    const contents = inflateEntry(archive, entry, budget);
    budget -= contents.length;
    files.push({
      name: entry.name,
      contents,
      modifiedAt: dosTimeOf(archive, entry),
    });
  }
  return files;
}

/** The modification time the local header records, in local time the way zip
 *  tools write it. */
function dosTimeOf(archive: Buffer, entry: CentralEntry): number {
  const header = entry.localHeaderOffset;
  const time = archive.readUInt16LE(header + 10);
  const date = archive.readUInt16LE(header + 12);
  return new Date(
    ((date >> 9) & 0x7f) + 1980,
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  ).getTime();
}

/** A time as the two 16-bit fields a zip header carries. The format starts at
 *  1980, so anything earlier is clamped to it rather than wrapping. */
function dosTime(modifiedAt: number): { time: number; date: number } {
  const at = new Date(Math.max(modifiedAt, new Date(1980, 0, 1).getTime()));
  return {
    time:
      (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date:
      ((at.getFullYear() - 1980) << 9) |
      ((at.getMonth() + 1) << 5) |
      at.getDate(),
  };
}

/**
 * Build an archive of these files, in the order given.
 *
 * Each entry is deflated unless that fails to make it smaller, which is the
 * case for data that is already compressed. The whole archive is built in
 * memory, which is what a save set's size allows; zip64 is not written, so
 * anything near 4 GiB is refused rather than truncated.
 */
export function writeZip(files: readonly ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    if (name.length > 0xffff) {
      throw new ZipError(`${file.name} is too long a name for a zip entry.`);
    }
    if (file.contents.length >= ZIP64_MARKER_32) {
      throw new ZipError(`${file.name} is too large to write without zip64.`);
    }
    const deflated = deflateRawSync(file.contents);
    const stored = deflated.length >= file.contents.length;
    const data = stored ? file.contents : deflated;
    const method = stored ? METHOD_STORE : METHOD_DEFLATE;
    const checksum = crc32(file.contents);
    const { time, date } = dosTime(file.modifiedAt);

    const local = Buffer.alloc(LOCAL_FIXED_SIZE);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(CENTRAL_FIXED_SIZE);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    // Made by unix, so the mode below is read as one: a plain file, rw-r--r--.
    central.writeUInt16LE((MADE_BY_UNIX << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
    if (offset >= ZIP64_MARKER_32) {
      throw new ZipError("Archive is too large to write without zip64.");
    }
  }

  if (files.length > 0xffff) {
    throw new ZipError("Too many entries to write without zip64.");
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(EOCD_MIN_SIZE);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
