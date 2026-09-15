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

/** Extensions that name a disc: what a playlist lists and an emulator boots.
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

/** A sheet describes its tracks by name and cannot boot without them beside
 *  it, so these are staged with the discs while never being listed as one. */
const TRACK_EXTENSIONS = [
  ".bin",
  ".img",
  ".mdf",
  ".raw",
  ".sub",
  ".wav",
  ".ogg",
  ".flac",
  ".mp3",
];

/** Extensions that describe a disc rather than hold it. */
const SHEET_EXTENSIONS = [".cue", ".gdi", ".ccd", ".mds"];

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
 * A `.cue` or `.gdi` wins over the `.bin` it describes, because the sheet is
 * what an emulator is meant to be handed and the bin is its data. Dropped by
 * name rather than by the mere presence of a sheet somewhere in the set: a
 * disc that is a bare `.bin` alongside a sibling that came as a `.cue` pair is
 * still a disc, and a set losing one is a set that will not launch.
 */
export function selectDiscs(files: DiscFile[]): DiscFile[] {
  const discs = files.filter((file) =>
    DISC_EXTENSIONS.includes(extensionOf(file.fileName)),
  );
  const sheets = discs
    .filter((file) => SHEET_EXTENSIONS.includes(extensionOf(file.fileName)))
    .map((file) => baseNameOf(file.fileName).toLowerCase());
  return inDiscOrder(
    discs.filter(
      (file) =>
        !TRACK_EXTENSIONS.includes(extensionOf(file.fileName)) ||
        !describedBy(sheets, file.fileName),
    ),
  );
}

/** Whether one of these sheets names this track, by the convention every disc
 *  set follows: "Game (Disc 1).cue" describes "Game (Disc 1) (Track 02).bin"
 *  and "Game (Disc 1).bin", and nothing else. */
function describedBy(sheetBaseNames: string[], fileName: string): boolean {
  const base = baseNameOf(fileName).toLowerCase();
  return sheetBaseNames.some((sheet) => base.startsWith(sheet));
}

function baseNameOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? fileName : fileName.slice(0, dot);
}

/**
 * Every file that has to be on disk for those discs to boot.
 *
 * A sheet is not playable alone: dropping the tracks it names from the playlist
 * is right, dropping them from the download is a `.cue` pointing at files that
 * were never fetched.
 */
export function selectStagedFiles(files: DiscFile[]): DiscFile[] {
  return inDiscOrder(
    files.filter((file) => {
      const extension = extensionOf(file.fileName);
      return (
        DISC_EXTENSIONS.includes(extension) ||
        TRACK_EXTENSIONS.includes(extension)
      );
    }),
  );
}

/**
 * Numbered entries first, in numeric order, then the rest by name.
 *
 * Ranking the unnumbered rather than falling back to a name comparison between
 * a numbered and an unnumbered entry: that comparison is not transitive, and a
 * set holding one unnumbered file could sort Disc 2 ahead of Disc 1 depending
 * on which pairs the sort happened to compare.
 */
function inDiscOrder(files: DiscFile[]): DiscFile[] {
  return [...files].sort((a, b) => {
    const left = discNumberOf(a.fileName);
    const right = discNumberOf(b.fileName);
    if (left !== null && right !== null && left !== right) return left - right;
    if (left !== null && right === null) return -1;
    if (left === null && right !== null) return 1;
    return a.fileName.localeCompare(b.fileName, "en");
  });
}

/**
 * The .m3u an emulator is handed for a multi-disc game.
 *
 * One absolute path per line, so a set that is part in the shell's cache and
 * part in the user's own library still reads as one playlist, and so a relative
 * entry is never resolved against whatever the emulator's working directory
 * happens to be. UTF-8 with LF endings, because that is all Dolphin accepts.
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
  const seen = new Set<string>();
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = row.id;
    const fileName = row.file_name;
    const fullPath = row.full_path;
    const sizeBytes = row.file_size_bytes;
    // The id is interpolated into a file_ids selector, so a fraction or a
    // negative is not a row to download from: it is a request that fails.
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
    if (typeof fileName !== "string" || fileName.length === 0) continue;
    if (typeof fullPath !== "string") continue;
    if (
      typeof sizeBytes !== "number" ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      continue;
    }
    // The name becomes a path inside the rom's own directory, so it is
    // sanitised the way every other name the server supplies is.
    if (safeFileName(fileName) !== fileName) continue;
    // Two rows naming one file would fight over the same path on disk, and the
    // playlist would name it twice. First wins, as the firmware mirror does.
    const key = fileName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, fileName, fullPath, sizeBytes });
  }
  return out;
}
