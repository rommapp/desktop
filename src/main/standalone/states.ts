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
import { selectSaveFiles, type SaveTargetLayout } from "./identity.ts";

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

export interface StateTarget {
  target: string;
  layout: SaveTargetLayout;
}

/**
 * Whether this state file is this game's.
 *
 * Both emulators build the name from the game's own id, which is what RomM's
 * save target carries, so the same matcher the save set uses answers this too.
 * A state folder holds every game the emulator has ever run, so without this a
 * push would offer somebody else's.
 */
export function isGameState(fileName: string, target: StateTarget): boolean {
  return (
    selectSaveFiles([fileName], target.target, target.layout).length > 0
  );
}

export interface StateFile {
  name: string;
  size: number;
  /** Milliseconds, as `stat` reports it. */
  modifiedAt: number;
}

export interface StandaloneStatePlan {
  /** What to send, newest slot first so a truncated run still sends the slot
   *  most recently written. */
  send: { file: StateFile; slot: number }[];
  /** Over the ceiling, named in the log rather than sent and refused. */
  tooLarge: StateFile[];
  /** Files the run wrote that are not this game's, for the log: a count that
   *  is not zero means the target is wrong, which is worth knowing. */
  foreign: number;
}

/**
 * The states this run wrote.
 *
 * Changed means a different size or modification time, never a digest, for the
 * same reason the RetroArch plan gives: hashing ten slots of a console whose
 * states run to tens of megabytes costs more at every launch than the
 * occasional redundant upload it saves.
 *
 * `target` is checked even though the run only played one game. The folder is
 * shared, and an emulator that rewrites another game's state on exit, or a
 * second launch that slipped in, would otherwise have its file filed under
 * this ROM. Without a target nothing is sent: a state filed against the wrong
 * game is worse than one not filed at all, and there is no undoing it from
 * here.
 */
export function planStandaloneStates(options: {
  emulatorId: string;
  before: readonly StateFile[];
  after: readonly StateFile[];
  target: StateTarget | null;
  maxBytes: number;
}): StandaloneStatePlan {
  const { emulatorId, before, after, target, maxBytes } = options;
  const plan: StandaloneStatePlan = { send: [], tooLarge: [], foreign: 0 };
  if (!target) return plan;

  const previous = new Map(before.map((file) => [file.name, file]));
  for (const file of after) {
    const slot = stateSlotOf(emulatorId, file.name);
    if (slot === null) continue;

    const was = previous.get(file.name);
    const changed =
      !was || was.size !== file.size || was.modifiedAt !== file.modifiedAt;
    if (!changed) continue;

    if (!isGameState(file.name, target)) {
      plan.foreign += 1;
      continue;
    }
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
 * The tests are the same ones the RetroArch restore applies, for the same
 * reason: a state belongs to the emulator and build that wrote it, and one
 * loaded into the wrong one crashes rather than merely disagreeing. So the row
 * has to name this emulator, its name has to carry a slot this emulator
 * addresses, and the name has to be this game's and safe to write.
 *
 * A slot already holding something newer than RomM's row keeps it. The local
 * file is this machine's own work, and a restore that walked over it would
 * replace a state the player made minutes ago with one from last week.
 *
 * And never the row this machine's own push left. The push runs after the exit
 * that wrote the state, so RomM's stamp on it is always later than the file's,
 * and freshness alone would archive the slot and fetch its own bytes back at
 * every launch from here on. `pushed` is what the push wrote down to stop
 * that, read here by the same rule the RetroArch restore uses: the row is the
 * one recorded, and the file in the slot is the one it was pushed from.
 */
export function planStandaloneRestore(options: {
  emulatorId: string;
  rows: readonly RemoteStateRow[];
  onDisk: readonly StateFile[];
  target: StateTarget | null;
  /** By slot, as `slot 3`, which is the shape the shared record keeps. */
  pushed?: Readonly<Record<string, PushedRow>>;
}): StandaloneRestore[] {
  const { emulatorId, rows, onDisk, target } = options;
  if (!target) return [];
  const local = new Map(onDisk.map((file) => [file.name, file]));
  const pushed = options.pushed ?? {};

  const best = new Map<number, StandaloneRestore>();
  for (const row of rows) {
    if ((row.emulator ?? "").trim().toLowerCase() !== emulatorId) continue;
    const fileName = unstampStateName(row.fileName);
    if (!safeStateName(fileName)) continue;
    const slot = stateSlotOf(emulatorId, fileName);
    if (slot === null) continue;
    if (!isGameState(fileName, target)) continue;

    const displacing = local.get(fileName) ?? null;
    // Already newer here than anything RomM holds for it.
    if (displacing && displacing.modifiedAt >= row.updatedAt) continue;

    const record = pushed[pushedSlotKey(slot)];
    const ours =
      displacing !== null &&
      record !== undefined &&
      record.id === row.id &&
      record.updatedAt === row.updatedAt &&
      record.mtimeMs === displacing.modifiedAt;
    if (ours) continue;

    const standing = best.get(slot);
    if (!standing || row.updatedAt > standing.row.updatedAt) {
      best.set(slot, { row, fileName, slot, displacing });
    }
  }
  return [...best.values()].sort((a, b) => a.slot - b.slot);
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
