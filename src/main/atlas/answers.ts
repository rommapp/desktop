// Reading what emu-atlas says, and deciding what to do about it.
//
// emu-atlas (https://github.com/danielcopper/emu-atlas) answers where an
// emulator installation already on this machine keeps things: RetroDECK,
// EmuDeck, and RetroArch as a Flatpak or a native package. It reads the
// configs the way the emulator does, override chains and sorting options
// included, which is exactly the knowledge this shell would otherwise have to
// re-derive and would get wrong the moment a user flips a setting.
//
// It is Python and this app has no runtime dependencies, so it is never
// bundled or imported. It is an optional executable the user installs, asked
// over its command line one question per process, and everything it prints is
// its documented contract JSON. This module is the half that reads that JSON:
// no process, no filesystem, no Electron, so every shape it can print can be
// checked from a fixture.
//
// Nothing here trusts the output further than its shape. A value that becomes
// an argument to the next question passes an alphabet check first, and a path
// is only a candidate once it is absolute and its file name carries no
// separator. A shape this client does not know reads as no answer, which is
// the branch the contract itself says to take.

import { basename, extname, join, posix, win32 } from "node:path";
import { isWithin } from "../safety.ts";

/** The alphabet a system id or an installation kind is held to before it is
 *  handed back to emu-atlas as an argument. ES-DE's system names and atlas's
 *  kinds fit it (`snes`, `genesis`, `bare_retroarch_flatpak`), and a leading
 *  dash is refused so no value can ever read as a flag. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isSafeAtlasId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One entry of the labelled list every question prints when it is not asked
 *  of a single installation. */
interface Labelled {
  kind: string;
  answer: Record<string, unknown>;
}

/**
 * The labelled list, read down to the kind that answered and its answer.
 *
 * Detection order is kept, since that is the order the contract promises, and
 * a kind that appears twice is kept once: `--installation <kind>` asks the
 * first handle of that kind, so a second one could not be asked on its own
 * anyway.
 */
function readLabelled(json: unknown): Labelled[] {
  if (!Array.isArray(json)) return [];
  const seen = new Set<string>();
  const out: Labelled[] = [];
  for (const entry of json) {
    if (!isRecord(entry) || !isRecord(entry.installation)) continue;
    const kind = entry.installation.kind;
    if (!isSafeAtlasId(kind) || seen.has(kind)) continue;
    if (!isRecord(entry.answer)) continue;
    seen.add(kind);
    out.push({ kind, answer: entry.answer });
  }
  return out;
}

/** An installation, and the system its catalogue files this platform under
 *  when it has a catalogue that says so. */
export interface AtlasInstallation {
  kind: string;
  system: string | null;
}

/**
 * Every installation emu-atlas found, from its answer to
 * `systems-for-platform igdb <slug>`.
 *
 * That one question does two jobs. Asked without `--installation` it is put to
 * every installation on the machine, so an empty list is the empty machine and
 * the whole feature costs one process where there is nothing to find. And it
 * maps RomM's platform onto the frontend's own system name, which is what the
 * frontend keys its ROM directory on.
 *
 * Only a match the catalogue itself declares counts. `absent` is a system the
 * crosswalk knows of and this machine does not have, and `disabled` is one the
 * catalogue switched off; neither has a ROM directory to find.
 */
export function readInstallations(json: unknown): AtlasInstallation[] {
  return readLabelled(json).map(({ kind, answer }) => {
    const matches = Array.isArray(answer.matches) ? answer.matches : [];
    const declared = matches.find(
      (match): match is Record<string, unknown> =>
        isRecord(match) &&
        match.status === "declared" &&
        isSafeAtlasId(match.system),
    );
    return { kind, system: (declared?.system as string | undefined) ?? null };
  });
}

/** Absolute on either platform's terms, since the answer describes a machine
 *  this module is not necessarily running on in a test. */
function isAbsoluteAnywhere(path: string): boolean {
  return posix.isAbsolute(path) || win32.isAbsolute(path);
}

/**
 * The directory a system's ROMs live in, from `rom-location <system>` asked of
 * one installation. Null wherever the answer did not resolve one, which the
 * contract spells as a null `dir` rather than a refusal.
 */
export function readRomDir(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const dir = json.dir;
  return typeof dir === "string" && dir !== "" && isAbsoluteAnywhere(dir)
    ? dir
    : null;
}

/**
 * The content path to ask a save question with.
 *
 * RetroArch can name a save's directory after the folder the content sat in
 * (RetroDECK's shipped config does), so asking about the file in this shell's
 * ROM cache would ask about a folder the other installation never saw. Where
 * the installation's catalogue says where this system's ROMs live, the question
 * names the same file there instead; the file does not have to exist, since
 * only its name and its folder decide where the save goes.
 */
export function contentPathFor(romPath: string, romDir: string | null): string {
  return romDir ? join(romDir, basename(romPath)) : romPath;
}

/** The extension RetroArch gives battery saves, and the one the shell's own
 *  save file carries. Anything else a core writes (a clock, a memory card) is
 *  not something this save slot can stand for. */
const SRAM_EXTENSION = ".srm";

function isPlainName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    name === basename(name) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    // A declared name can keep a hole such as <save_id> open. Holes are for a
    // caller that can fill them, and this one cannot.
    !name.includes("<")
  );
}

/**
 * The files that could be this game's save, from `savefile-location` asked of
 * one installation, as absolute paths that may or may not exist.
 *
 * A refusal, a directory with holes left open, and a shape this client does
 * not know all give nothing. Where atlas named the files, observed on disk or
 * declared by a rule card, the battery saves among them are the candidates.
 * Where it would not name them it says so (`unknown`), and the client's own
 * fallback is RetroArch's default name: the content's stem with `.srm`, which
 * is the fallback emu-atlas's own guide describes a client supplying.
 */
export function saveCandidates(json: unknown, contentPath: string): string[] {
  if (!isRecord(json) || "unresolved" in json) return [];
  const dir =
    typeof json.physical_dir === "string" && json.physical_dir !== ""
      ? json.physical_dir
      : json.dir;
  if (typeof dir !== "string" || !isAbsoluteAnywhere(dir)) return [];
  if (!Array.isArray(json.needs) || json.needs.length > 0) return [];

  const fileSet = isRecord(json.file_set) ? json.file_set : null;
  if (!fileSet) return [];

  if (fileSet.state === "observed" || fileSet.state === "declared") {
    const files = Array.isArray(fileSet.files) ? fileSet.files : [];
    return files
      .filter(isPlainName)
      .filter((name) => extname(name).toLowerCase() === SRAM_EXTENSION)
      .map((name) => join(dir, name));
  }
  if (fileSet.state === "unknown") {
    const name = basename(contentPath);
    const stem = name.slice(0, name.length - extname(name).length);
    return stem ? [join(dir, `${stem}${SRAM_EXTENSION}`)] : [];
  }
  return [];
}

/** A candidate that turned out to be a file, as far as choosing one needs. */
export interface FoundSave {
  path: string;
  size: number;
  modifiedAt: number;
}

/**
 * Which existing save to bring along, or null when none should be.
 *
 * Empty files are passed over, since an emulator creates one before it has
 * anything to write and adopting it would stand an empty save in for none.
 * So is anything larger than the push would send, which is not a battery save.
 * Of what is left the most recently written wins: two installations holding
 * the same game is the case where the one played last is the one the player
 * means, and the log names every other candidate so that choice is visible.
 */
export function chooseAdoption(
  found: readonly FoundSave[],
  maxBytes: number,
): FoundSave | null {
  const usable = found
    .filter((save) => save.size > 0 && save.size <= maxBytes)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  return usable[0] ?? null;
}

/** Whether a candidate is somewhere the shell must never read a save back
 *  from as if it were someone else's: its own save tree. A native RetroArch
 *  pointed at it by hand would otherwise hand the shell its own file. */
export function isOwnSave(path: string, saveDataPath: string | null): boolean {
  return saveDataPath !== null && isWithin(saveDataPath, path);
}
