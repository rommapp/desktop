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
  ".cdi",
  ".ciso",
  ".gcm",
  ".mds",
  ".nrg",
  ".gdi",
  ".pbp",
  ".rvz",
  ".wbfs",
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
 * Where a sheet is present the tracks it describes are not discs, because a
 * raw track is not loadable on its own. Which files those are is not derivable
 * from their names: RomM's own fixtures pair `game.cue` with `track01.bin`, so
 * a sheet cannot be matched to its tracks without reading it.
 *
 * Only the track formats go, though, not everything that is not a sheet. A
 * whole-disc image cannot be a sheet's track whatever it is named, so a `.chd`
 * beside a `.gdi` is a disc of its own and stays one. The ambiguous case is
 * still resolved in the tracks' favour: a bare `.bin` beside a `.cue` reads as
 * a track, since single-disc sets are far more common than mixed ones.
 *
 * This is the rule RomM applies server-side in `utils/m3u.py::playlist_files`,
 * followed here rather than reinvented, so the shell and the server cannot
 * disagree about what a disc is.
 */
export function selectDiscs(files: DiscFile[]): DiscFile[] {
  const discs = files.filter((file) =>
    DISC_EXTENSIONS.includes(extensionOf(file.fileName)),
  );
  const hasSheet = discs.some((file) =>
    SHEET_EXTENSIONS.includes(extensionOf(file.fileName)),
  );
  if (!hasSheet) return inDiscOrder(discs);
  return inDiscOrder(
    discs.filter(
      (file) => !TRACK_EXTENSIONS.includes(extensionOf(file.fileName)),
    ),
  );
}

/** The playlist the rom itself ships, if it has one: a curated set names its
 *  discs in an order no filename convention can convey, and RomM defers to it
 *  the same way (`Rom.has_m3u_file`). */
export function ownPlaylist(files: DiscFile[]): DiscFile | null {
  return files.find((file) => extensionOf(file.fileName) === ".m3u") ?? null;
}

/**
 * Every file that has to be on disk for those discs to boot.
 *
 * A sheet is not playable alone: dropping the tracks it names from the playlist
 * is right, dropping them from the download is a `.cue` pointing at files that
 * were never fetched. The rom's own playlist comes along for the same reason.
 */
export function selectStagedFiles(files: DiscFile[]): DiscFile[] {
  return inDiscOrder(
    files.filter((file) => {
      const extension = extensionOf(file.fileName);
      return (
        extension === ".m3u" ||
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
