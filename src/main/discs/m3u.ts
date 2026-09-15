import { safeFileName } from "../safety.ts";

// Reading a rom's files, deciding which of them are discs, in what order, and
// what the .m3u naming them looks like.
//
// Kept free of Electron and the filesystem, which is what lets node --test load
// it: the ordering and the trust placed in the server's rows are the parts that
// are easy to get subtly wrong and impossible to eyeball afterwards.

/** A rom file as /api/roms/{id} reports one, narrowed to what this needs. */
export interface DiscFile {
  id: number;
  fileName: string;
  /** Path under the server's library root, for a launch that plays in place. */
  fullPath: string;
  sizeBytes: number;
}

/** Extensions a libretro core or a standalone emulator will boot from an .m3u.
 *  Anything else in a folder rom is a manual, a scan, a save, or box art. */
const DISC_EXTENSIONS = [
  ".chd",
  ".cue",
  ".iso",
  ".img",
  ".ccd",
  ".mds",
  ".nrg",
  ".gdi",
  ".pbp",
  ".bin",
];

/** A disc number, when the name carries one: "(Disc 2)", "Disc 2", "CD2". */
const DISC_NUMBER = /\b(?:disc|disk|cd)\s*([0-9]+)\b/i;

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot).toLowerCase();
}

export function discNumberOf(fileName: string): number | null {
  const match = DISC_NUMBER.exec(fileName);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * The discs among a rom's files, in the order an .m3u should list them.
 *
 * A `.cue` or `.gdi` wins over a `.bin` describing the same disc, because the
 * sheet is what an emulator is meant to be handed and the bin is its data. So
 * when any sheet is present the bare data files are dropped rather than listed
 * as discs of their own.
 *
 * Ordered by disc number where the names carry one, and otherwise by name, so
 * a set that numbers only some of its discs still puts those in sequence.
 */
export function selectDiscs(files: DiscFile[]): DiscFile[] {
  const discs = files.filter((file) =>
    DISC_EXTENSIONS.includes(extensionOf(file.fileName)),
  );
  const sheets = discs.filter((file) =>
    [".cue", ".gdi", ".ccd", ".mds"].includes(extensionOf(file.fileName)),
  );
  const listed =
    sheets.length > 0
      ? discs.filter(
          (file) =>
            extensionOf(file.fileName) !== ".bin" &&
            extensionOf(file.fileName) !== ".img",
        )
      : discs;

  return [...listed].sort((a, b) => {
    const left = discNumberOf(a.fileName);
    const right = discNumberOf(b.fileName);
    if (left !== null && right !== null && left !== right) return left - right;
    return a.fileName.localeCompare(b.fileName, "en");
  });
}

/**
 * The .m3u an emulator is handed for a multi-disc game.
 *
 * One absolute path per line, so a set that is part in the shell's cache and
 * part in the user's own library still reads as one playlist. LF endings even
 * on Windows, because Dolphin refuses a playlist with CRLF in it.
 */
export function renderM3u(discPaths: string[]): string {
  return discPaths.join("\n") + "\n";
}

/** Read the files array of a /api/roms/{id} body, ignoring anything malformed. */
export function readRomFiles(body: unknown): DiscFile[] {
  if (typeof body !== "object" || body === null) return [];
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];

  const out: DiscFile[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = row.id;
    const fileName = row.file_name;
    const fullPath = row.full_path;
    const sizeBytes = row.file_size_bytes;
    if (
      typeof id !== "number" ||
      typeof fileName !== "string" ||
      fileName.length === 0 ||
      typeof fullPath !== "string" ||
      typeof sizeBytes !== "number" ||
      sizeBytes < 0
    ) {
      continue;
    }
    // The name becomes a path inside the rom's own directory, so it is
    // sanitised the way every other name the server supplies is.
    if (safeFileName(fileName) !== fileName) continue;
    out.push({ id, fileName, fullPath, sizeBytes });
  }
  return out;
}
