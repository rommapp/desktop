// What PCSX2 and Dolphin call a savestate, and which of them are this game's.
//
// The state mirror beside this one is built around RetroArch, whose states the
// shell can name: it owns the directory, pins it per launch, and writes the
// slot into the filename itself. None of that holds here. These emulators keep
// their states in one folder of their own, under a name built from the game's
// own id and a checksum the shell cannot compute, so the name is something to
// read rather than something to choose.
//
// Which makes the name the whole problem, and RomM has already solved it. Its
// streaming side reads the same files off a container and files them as State
// assets (`handler/streaming/states.py`), so the conventions here are ported
// from there rather than invented: the slot patterns, the capture stamp that
// goes in front of the slot token, and stripping that stamp back off to get
// the name the emulator expects on disk. Matching it means a state written by
// a desktop launch and one pulled from a streamed session are the same kind of
// row, and either can restore the other.
//
// The stamp is also what makes two machines safe. The RetroArch mirror puts
// the host in the name because RomM finds the row to update by filename alone,
// so two desktops mirroring their own slot 3 would take turns destroying each
// other's row. A stamped name is new every capture, so there is nothing to
// take turns over, at the cost of a row per capture rather than a row per slot.
//
// No Electron here, so all of it can be tested.

import { type PushedRow } from "../saves/states.ts";

/**
 * The slot each emulator writes into its state filename.
 *
 * Ported from RomM's `_SLOT_PATTERNS`. PCSX2 writes `SERIAL (CRC).03.p2s` and
 * Dolphin `GAMEID.s03`, both ending in the slot, which is what lets the stamp
 * be inserted in front of it without breaking either.
 *
 * Only these two: RPCS3's `.SAVESTAT` is one exit state per game rather than a
 * slot, and Cemu writes no states at all.
 */
const SLOT_PATTERNS: Record<string, RegExp> = {
  pcsx2: /\.(\d{1,2})\.p2s$/,
  dolphin: /\.s(\d{2})$/,
};

/** Whether this shell knows how to read the emulator's state names. */
export function knowsStates(emulatorId: string): boolean {
  return emulatorId in SLOT_PATTERNS;
}

/**
 * The slot this filename names, or null when it is not one of this emulator's
 * states.
 *
 * Both of these count from 1, so a zero is a filename that merely looks like a
 * state rather than a slot either emulator addresses. RomM's `_MIN_SLOT` says
 * the same thing by leaving them out of it.
 */
export function stateSlotOf(
  emulatorId: string,
  fileName: string,
): number | null {
  const pattern = SLOT_PATTERNS[emulatorId];
  const match = pattern?.exec(fileName);
  if (!match) return null;
  const slot = Number(match[1]);
  return Number.isSafeInteger(slot) && slot >= 1 ? slot : null;
}

/** RomM's `_STAMP_FORMAT`, which is Python's `%Y%m%d-%H%M%S%f`: microseconds,
 *  so twelve digits after the dash rather than the nine a millisecond clock
 *  can fill. The last three are zeroes here, which still sorts and still
 *  matches `_STAMP_PATTERN`. */
function captureStamp(at: Date): string {
  const pad = (value: number, width: number) =>
    String(value).padStart(width, "0");
  const date =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}`;
  const time =
    `${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}`;
  return `${date}-${time}${pad(at.getUTCMilliseconds(), 3)}000`;
}

/** RomM's `_STAMP_PATTERN`. */
const STAMP = /\.\d{8}-\d{12}(?=\.)/;

/**
 * The name a capture is filed under: the emulator's own, with a stamp in front
 * of the slot token.
 *
 * In front of the slot rather than at the end, so the slot patterns above
 * still match, which is what keeps the stamped name readable as a state at
 * all. Reproduces RomM's `stamped_state_filename`.
 */
export function stampStateName(
  emulatorId: string,
  fileName: string,
  at: Date,
): string {
  const pattern = SLOT_PATTERNS[emulatorId];
  const match = pattern?.exec(fileName);
  if (!match) return fileName;
  const head = fileName.slice(0, match.index);
  return `${head}.${captureStamp(at)}${fileName.slice(match.index)}`;
}

/** The name without its capture stamp, which is what the emulator looks for on
 *  disk. Reproduces RomM's `container_state_filename`. */
export function unstampStateName(fileName: string): string {
  return fileName.replace(STAMP, "");
}

export interface StateFile {
  name: string;
  size: number;
  /** Milliseconds, as `stat` reports it. */
  modifiedAt: number;
}

export interface StandaloneStatePlan {
  /** What to send, newest first so a run cut short has sent the slot most
   *  recently written. */
  send: { file: StateFile; slot: number }[];
  /** Over the ceiling, named in the log rather than sent and refused. */
  tooLarge: StateFile[];
}

/**
 * The states this run wrote.
 *
 * What makes a state this game's is that this run wrote it, which is the same
 * answer the RetroArch plan beside this one gives: a launch plays one game,
 * and a file that changed between the two readings changed because of it.
 *
 * Not RomM's save target, which was the first attempt and is wrong. That
 * target describes where a *save* lives, and for Dolphin's Wii titles it is a
 * folder name, which can never match a flat `GAMEID.s03`; the id Dolphin puts
 * in a state filename is not the one RomM carries for the save either. A
 * target that cannot match is a target that rejects every state, silently.
 *
 * What the target was guarding against is a second game writing the same
 * folder while this run played. The folder claim already answers that: a
 * contested folder means two launches wrote here, and then this run cannot
 * say which files are its own, so it sends none.
 *
 * Changed means a different size or modification time, never a digest, for the
 * same reason the RetroArch plan gives: hashing ten slots of a console whose
 * states run to tens of megabytes costs more at every launch than the
 * occasional redundant upload it saves.
 */
export function planStandaloneStates(options: {
  emulatorId: string;
  before: readonly StateFile[];
  after: readonly StateFile[];
  /** Another launch wrote this emulator's folder during the run, so what is
   *  in it is not all this one's. */
  contested?: boolean;
  maxBytes: number;
}): StandaloneStatePlan {
  const { emulatorId, before, after, maxBytes } = options;
  const plan: StandaloneStatePlan = { send: [], tooLarge: [] };
  if (options.contested) return plan;

  const previous = new Map(before.map((file) => [file.name, file]));
  for (const file of after) {
    const slot = stateSlotOf(emulatorId, file.name);
    if (slot === null) continue;

    const was = previous.get(file.name);
    const changed =
      !was || was.size !== file.size || was.modifiedAt !== file.modifiedAt;
    if (!changed) continue;

    if (file.size > maxBytes) {
      plan.tooLarge.push(file);
      continue;
    }
    plan.send.push({ file, slot });
  }

  plan.send.sort((a, b) => b.file.modifiedAt - a.file.modifiedAt);
  return plan;
}

/**
 * Whether a name out of a server row is one to write into the state folder.
 *
 * The same argument as the save set's member names, with less room: a state is
 * one file directly in the folder, so anything with a path in it is wrong
 * rather than merely suspicious.
 */
export function safeStateName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f:*?"<>|]/.test(name)) return false;
  return name !== "." && name !== ".." && !/[. ]$/.test(name);
}

export interface RemoteStateRow {
  id: number;
  fileName: string;
  emulator: string | null;
  size: number;
  updatedAt: number;
  screenshotId: number | null;
}

export interface StandaloneRestore {
  row: RemoteStateRow;
  /** The name the emulator looks for, which is the row's without its stamp. */
  fileName: string;
  slot: number;
  /** The file this one replaces, when the slot is already taken. */
  displacing: StateFile | null;
}

/**
 * Which of RomM's rows to bring back, newest per slot.
 *
 * The rows are already this ROM's: `/api/states?rom_id=` is what asked for
 * them. So what is left to check is whether this launch could load one, and
 * the tests are the RetroArch restore's, for its reason: a state belongs to
 * the emulator and build that wrote it, and one loaded into the wrong one
 * crashes rather than merely disagreeing. The row has to name this emulator,
 * its name has to carry a slot this emulator addresses and be safe to write,
 * and it has to be a size worth fetching.
 *
 * The newest valid row per slot is chosen *first*, and only then asked whether
 * it should displace what is on disk. Asking in the other order lets a slot
 * fall back to older history: skip the newest because it is this machine's own
 * push, and the row behind it wins and overwrites the state just written.
 *
 * A slot already holding something newer than RomM's row keeps it, and so does
 * one holding the file this machine's own push was made from. The push runs
 * after the exit that wrote the state, so RomM's stamp is always later than
 * the file's, and freshness alone would archive the slot and fetch its own
 * bytes back at every launch from then on.
 */
export function planStandaloneRestore(options: {
  emulatorId: string;
  rows: readonly RemoteStateRow[];
  onDisk: readonly StateFile[];
  /** By slot, as `slot 3`, which is the shape the shared record keeps. */
  pushed?: Readonly<Record<string, PushedRow>>;
  maxBytes: number;
}): StandaloneRestore[] {
  const { emulatorId, rows, onDisk, maxBytes } = options;
  const pushed = options.pushed ?? {};

  // The newest row per slot, before anything about the disk is considered.
  const newest = new Map<number, { row: RemoteStateRow; fileName: string }>();
  for (const row of rows) {
    if ((row.emulator ?? "").trim().toLowerCase() !== emulatorId) continue;
    if (row.size > maxBytes) continue;
    const fileName = unstampStateName(row.fileName);
    if (!safeStateName(fileName)) continue;
    const slot = stateSlotOf(emulatorId, fileName);
    if (slot === null) continue;

    const standing = newest.get(slot);
    // Ties on id, as the RetroArch planner does: `updated_at` has second
    // resolution, so two rows written in the same second would otherwise
    // order arbitrarily.
    const later =
      !standing ||
      row.updatedAt > standing.row.updatedAt ||
      (row.updatedAt === standing.row.updatedAt && row.id > standing.row.id);
    if (later) newest.set(slot, { row, fileName });
  }

  const restore: StandaloneRestore[] = [];
  for (const [slot, { row, fileName }] of newest) {
    const displacing = occupant(onDisk, fileName);
    if (displacing && displacing.modifiedAt >= row.updatedAt) continue;

    const record = pushed[pushedSlotKey(slot)];
    const ours =
      displacing !== null &&
      record !== undefined &&
      record.id === row.id &&
      record.updatedAt === row.updatedAt &&
      record.mtimeMs === displacing.modifiedAt;
    if (ours) continue;

    restore.push({ row, fileName, slot, displacing });
  }
  return restore.sort((a, b) => a.slot - b.slot);
}

/**
 * The file a restore of this name would write over, or null for a slot with
 * nothing in its way.
 *
 * The exact name first, since that is the name the write uses. Failing that a
 * lone spelling differing only in case, because on Windows and macOS it *is*
 * that file: an exact test alone would read the slot as empty and overwrite it
 * without archiving its bytes first. Several spellings at once can only happen
 * where the filesystem keeps them apart, and there a write to a name none of
 * them carries puts none of them at risk. The same rule `planStateRestore`
 * applies, for the same reason.
 */
function occupant(
  onDisk: readonly StateFile[],
  fileName: string,
): StateFile | null {
  const exact = onDisk.find((file) => file.name === fileName);
  if (exact) return exact;
  const folded = fileName.toLowerCase();
  const alike = onDisk.filter((file) => file.name.toLowerCase() === folded);
  return alike.length === 1 ? (alike[0] ?? null) : null;
}

/** How a slot is keyed in the pushed-rows record, which is shared with the
 *  RetroArch mirror and only reads keys in this shape. */
export function pushedSlotKey(slot: number): string {
  return `slot ${slot}`;
}

/**
 * The name a displaced state is archived under.
 *
 * Deliberately one no slot pattern matches, which is what keeps it out of
 * every later restore. A capture here is a new row whose `updated_at` is now,
 * so an archive filed under a readable name would be the newest thing RomM
 * held for that slot and the next launch would put it straight back, undoing
 * the restore that displaced it. The same trap `displacedStateName` avoids on
 * the RetroArch side, by the same means.
 */
export function displacedStandaloneName(fileName: string, at: Date): string {
  return `${fileName}.replaced-${captureStamp(at)}`;
}

/** PCSX2 puts a PNG of the moment of save inside every `.p2s`, under this
 *  entry name (`pcsx2/SaveState.cpp: EntryFilename_Screenshot`, as RomM's
 *  `_SCREENSHOT_ZIP_ENTRY` records). Dolphin's states carry none. */
export const STATE_SCREENSHOT_ENTRY = "Screenshot.png";

/** Whether this emulator's states carry a picture worth pulling out. */
export function statesEmbedScreenshots(emulatorId: string): boolean {
  return emulatorId === "pcsx2";
}

/** What a state's thumbnail is filed under: the state's own name with the
 *  picture's extension after it, the shape RomM's own pairing expects. */
export function stateScreenshotName(fileName: string): string {
  return `${fileName}.png`;
}
