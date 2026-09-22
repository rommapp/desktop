// Moving a game's savestates between the emulator and RomM.
//
// Deliberately much less than the save sync beside it. A save is one file with
// one meaning, and RomM pairs it with the devices that hold it: there is a
// slot, a content hash, a device baseline and a negotiation, and all of it
// exists because two machines can write the same save and only one of them can
// win. A state has none of that. `POST /api/states` takes a ROM, an emulator
// and a file; there is no slot, no hash, no `device_state_sync` table and
// nothing in the negotiation that mentions one.
//
// So this does what that surface supports, in two halves. After a run, the
// states the run wrote go up. Before a run, the states RomM holds that this
// launch could actually load come back down, into the slots they were written
// from: a slot is the only place an emulator can be asked to load a state
// from, so a state that cannot name one is a state nobody can play.
//
// What makes either half work is the name. RomM's `store_state_file` updates
// the row already at a filename, so a name that is stable per slot rewrites
// that slot's row every run rather than leaving one behind. The name carries
// this machine as well, because the row is found by filename alone: two
// desktops mirroring their own slot 3 under one name would take turns
// destroying each other's, and a state from the wrong machine is worse than no
// state at all. That same name is what the restore reads the slot back out of.
//
// Two things decide whether a state comes down, and both are strict, because a
// state belongs to the core and the build that wrote it, and one loaded into
// the wrong core crashes rather than merely disagreeing:
//
//   - the emulator recorded on it is the one this launch runs. A state naming
//     no emulator is nobody's rather than everybody's, and stays put.
//   - its name carries a slot, in the shape the mirror writes. RomM has no
//     slot column, so that name is the only record of which slot a state is.
//
// RetroArch's automatic state names a slot and is still left out: it loads on
// start without the player asking, so a copy from another machine would
// replace a session nobody chose to leave. And a local state is never simply
// overwritten. The slot's own bytes go up first, under this machine's name for
// that slot, and a slot whose upload does not land is left alone -- the same
// rule the save pull follows, for the same reason.

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { safeFileName, safeFileNameComponent } from "../safety.ts";

/**
 * The largest state this will send.
 *
 * Well under RomM's own 512 MiB asset ceiling, because the cost here is memory
 * rather than bandwidth: the file and the multipart body framing it are both
 * resident while the request is built, so the peak is roughly twice the state.
 * A savestate is a core's RAM and video memory, which puts the heaviest real
 * ones in the tens of megabytes, so this passes everything an emulator
 * actually writes and refuses the ones that would cost the main process its
 * heap. Anything larger is named in the log rather than sent.
 */
export const MAX_STATE_BYTES = 128 * 1024 * 1024;

/** The picture RetroArch writes beside a state when thumbnails are on, which
 *  is what the generated config asks for in `retroarch.ts`: the setting is off
 *  by default, so without that a mirrored state never has one. */
export const THUMBNAIL_SUFFIX = ".png";

/** Ceiling on a picture brought back down beside a restored slot. A frame of a
 *  game is kilobytes; this is only here so a row claiming otherwise is refused
 *  before the transfer rather than after it. */
export const MAX_THUMBNAIL_BYTES = 16 * 1024 * 1024;

/** Whether a launch should mirror its states at all. */
export function stateSyncEnabled(config: DesktopConfig): boolean {
  return Boolean(config.syncStates && config.serverUrl);
}

/** One file in a state directory, as far as this module cares. */
export interface StateEntry {
  name: string;
  size: number;
  /** Milliseconds, as `stat` reports it. */
  modifiedAt: number;
}

/** A state this run wrote, and which of the emulator's slots it sits in. */
export interface StateUpload {
  entry: StateEntry;
  /** How the slot reads in the name this lands under: "slot 3", or "auto". */
  slot: string;
}

/**
 * Which of the emulator's slots this file is, or null when it is not a state.
 *
 * RetroArch writes the current slot as `<name>.state`, the numbered ones as
 * `<name>.state1` upwards, and its automatic one as `<name>.state.auto`. It
 * also leaves `.bak` copies and thumbnails in the same directory, which are
 * not slots and are not mirrored.
 *
 * Only the extension is read. The directory is this ROM's own, keyed on its
 * id, so everything in it is a state of this game whatever the emulator chose
 * to call it -- and what it calls it is not something the shell can predict,
 * which is the whole lesson of the save file beside it.
 */
export function stateSlot(name: string): string | null {
  const match = /\.state(\d*)(\.auto)?$/.exec(name);
  if (!match) return null;
  const [, number, auto] = match;
  if (auto) return number ? null : "auto";
  return `slot ${number || "0"}`;
}

/** What `safeFileName` truncates a name to, and the share of it a machine's
 *  name may take. Both are spent from the end, which is where the slot is. */
const MAX_NAME_LENGTH = 120;
const MAX_HOST_LENGTH = 32;

/**
 * What a state carries in RomM: the game, the machine, and the slot.
 *
 * The machine is in there because RomM finds the row to update by filename
 * alone, so this is what keeps one desktop's slots from overwriting another's.
 *
 * Composed so the truncation lands on the game's name rather than the slot: a
 * long name cut to length from the right would leave every slot of that game
 * answering to one filename, which is the collision this is here to avoid.
 */
export function stateAssetName(
  base: string,
  host: string,
  slot: string,
): string {
  const machine = safeFileNameComponent(host).slice(0, MAX_HOST_LENGTH);
  const suffix = ` [${machine ? `${machine} ` : ""}${slot}].state`;
  const room = Math.max(MAX_NAME_LENGTH - suffix.length, 0);
  const stem = safeFileNameComponent(base).slice(0, room);
  return safeFileName(`${stem}${suffix}`);
}

/** What a run wrote, split from what it wrote too much of. */
export interface StatePlan {
  send: StateUpload[];
  /** Over the ceiling, so named in the log rather than sent and refused. */
  tooLarge: StateEntry[];
}

/**
 * The states this run wrote, against a reading taken before it started.
 *
 * Changed means a different size or a later modification time, never a digest:
 * hashing ten slots of a console whose states run to megabytes would cost more
 * at every launch than the occasional redundant upload it would save. Nothing
 * here can lose data either way, which is what makes the cheap comparison the
 * right one: a false positive sends a state RomM already has, and a false
 * negative leaves one to be sent by the next run that touches it.
 */
export function planStates(options: {
  before: readonly StateEntry[];
  after: readonly StateEntry[];
}): StatePlan {
  const { before, after } = options;
  const previous = new Map(before.map((entry) => [entry.name, entry]));
  const plan: StatePlan = { send: [], tooLarge: [] };

  for (const entry of after) {
    const slot = stateSlot(entry.name);
    if (!slot) continue;

    const was = previous.get(entry.name);
    const changed =
      !was || was.size !== entry.size || was.modifiedAt !== entry.modifiedAt;
    if (!changed) continue;

    if (entry.size > MAX_STATE_BYTES) {
      plan.tooLarge.push(entry);
      continue;
    }
    plan.send.push({ entry, slot });
  }

  return plan;
}

/** Every file in a state directory, or nothing when there is no directory. */
export async function readStateDir(directory: string): Promise<StateEntry[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const entries = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(directory, name)).catch(() => null);
      return info?.isFile()
        ? { name, size: info.size, modifiedAt: info.mtimeMs }
        : null;
    }),
  );
  return entries.filter((entry): entry is StateEntry => entry !== null);
}

/** One state RomM holds, as far as the restore cares. */
export interface RemoteState {
  id: number;
  fileName: string;
  /** What wrote it, which is most of whether it can be loaded here. */
  emulator: string | null;
  size: number;
  /** `updated_at`, in milliseconds. */
  updatedAt: number;
  /** The picture RomM keeps for it, or null when it has none. */
  screenshotId: number | null;
}

/**
 * The state list, reduced to the rows worth considering.
 *
 * Read defensively rather than cast, like the firmware list: this is a body
 * from a server the shell does not own the version of, and a row missing the id
 * or the timestamp the restore turns on cannot be acted on at all. A row whose
 * file the server has lost answers 404, so it goes here rather than costing a
 * transfer to find out.
 */
export function readStateList(states: unknown): RemoteState[] {
  if (!Array.isArray(states)) return [];
  const found: RemoteState[] = [];
  for (const entry of states) {
    if (typeof entry !== "object" || entry === null) continue;
    const {
      id,
      file_name: fileName,
      file_size_bytes: size,
      emulator,
      updated_at: updatedAt,
      missing_from_fs: missing,
      screenshot,
    } = entry as {
      id?: unknown;
      file_name?: unknown;
      file_size_bytes?: unknown;
      emulator?: unknown;
      updated_at?: unknown;
      missing_from_fs?: unknown;
      screenshot?: unknown;
    };
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
    if (typeof fileName !== "string" || fileName === "") continue;
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
      continue;
    }
    if (missing === true) continue;
    const stamp =
      typeof updatedAt === "string" ? Date.parse(updatedAt) : Number.NaN;
    if (!Number.isFinite(stamp)) continue;
    found.push({
      id,
      fileName,
      emulator: typeof emulator === "string" ? emulator : null,
      size,
      updatedAt: stamp,
      screenshotId: screenshotId(screenshot),
    });
  }
  return found;
}

function screenshotId(screenshot: unknown): number | null {
  if (typeof screenshot !== "object" || screenshot === null) return null;
  const { id } = screenshot as { id?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  return id;
}

/**
 * The slot a mirrored state's name carries, or null when it carries none.
 *
 * The inverse of `stateAssetName`, and the only way back to a slot: RomM
 * stores no slot of its own. A state uploaded from somewhere else -- the
 * browser player, or a hand upload -- therefore names no slot here, and is
 * left for the player to fetch by hand rather than guessed into one.
 *
 * Brackets are excluded from the machine's share of the match so a game whose
 * own title ends in brackets cannot read as a slot.
 */
export function slotFromAssetName(fileName: string): string | null {
  const match = /\[[^[\]]*?(slot \d{1,2}|auto)\]\.state$/.exec(fileName);
  return match?.[1] ?? null;
}

/** Whether this launch's emulator is the one that wrote the state. Compared
 *  without regard to case, as every other name comparison in the shell is. */
export function stateLoadsIn(
  state: RemoteState,
  emulator: string | null,
): boolean {
  const wrote = (state.emulator ?? "").trim().toLowerCase();
  const running = (emulator ?? "").trim().toLowerCase();
  return wrote !== "" && wrote === running;
}

/**
 * The file a slot's state sits in locally, or null for a slot not restored.
 *
 * The naming `stateSlot` reads, written back out: slot 0 is the bare
 * `.state` RetroArch starts on, and the automatic state is deliberately
 * unreachable from here.
 */
export function localStateName(base: string, slot: string): string | null {
  const match = /^slot (\d{1,2})$/.exec(slot);
  if (!match) return null;
  const number = match[1] === "0" ? "" : match[1];
  return `${base}.state${number}`;
}

/** The slot's own number, for reading a plan in the order a player sees the
 *  slots in. Anything that is not a numbered slot sorts last. */
function slotNumber(slot: string): number {
  const match = /^slot (\d{1,2})$/.exec(slot);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * What an emulator that names a state after the content it was handed would
 * call this game's states.
 *
 * Not the same as the name the launch pins with `-S`, and for a disc set not
 * the same as the game: what a multi-disc launch boots is the playlist the
 * shell wrote, so the emulator's own answer is "discs", whatever the game is
 * called. The state directory is this ROM's own, so that is unambiguous rather
 * than shared.
 */
export function contentStateBase(romPath: string): string {
  const name = basename(romPath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The name this game's states go by in its directory.
 *
 * Read off the directory first and only then guessed, because the emulator
 * names the state and not the shell: `-S` is a hint that a
 * `savestate_directory` or a sorting option can outrank, and a restore into a
 * name nothing reads is a slot the player cannot see. The newest state is the
 * one whose name the emulator is using now.
 *
 * `bases` is what the launch can offer when the directory is empty and has
 * nothing to demonstrate, best first: the name the launch pinned, and the one
 * the emulator would derive from the content itself.
 */
export function stateBaseIn(
  local: readonly StateEntry[],
  bases: readonly string[],
): string | null {
  const slotted = local
    .filter((entry) => stateSlot(entry.name) !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const newest = slotted[0];
  if (newest) return newest.name.replace(/\.state\d*(\.auto)?$/, "");
  return bases.find((base) => base !== "") ?? null;
}

/** One state to bring down, and what it lands on. */
export interface StateRestore {
  state: RemoteState;
  slot: string;
  /** The file inside the state directory it lands in. */
  fileName: string;
  /** The local state it replaces, which goes up before it is written over.
   *  Null when the slot was empty. */
  displaces: StateEntry | null;
}

/**
 * Which of RomM's states this launch should bring down, and into which slots.
 *
 * One state per slot: RomM holds a row per machine and slot, so a slot several
 * desktops have played has several candidates, and the most recently written
 * one is the only one a player would mean.
 *
 * A slot with nothing on disk is filled outright. A slot holding something is
 * filled only when RomM's copy is newer, which is the one judgement here that
 * rests on two clocks agreeing. Neither way round loses a state: the local
 * bytes go up before they are replaced, so a skewed clock costs a transfer and
 * an extra row, not a savestate.
 */
export function planStateRestore(options: {
  remote: readonly RemoteState[];
  local: readonly StateEntry[];
  /** What this launch runs, as the push records it. */
  emulator: string | null;
  /** The names this launch's states could go by, best first, for a directory
   *  that is empty and so has nothing to demonstrate. */
  bases: readonly string[];
}): StateRestore[] {
  const { remote, local, emulator } = options;
  const base = stateBaseIn(local, options.bases);
  // Nowhere to put a state whose slot has no name, which is a launch that
  // pinned none and boots content the shell cannot name either.
  if (base === null) return [];

  // The newest file claiming each slot, since two launch paths can name the
  // same game differently and leave two files for one slot behind.
  const onDisk = new Map<string, StateEntry>();
  for (const entry of local) {
    const slot = stateSlot(entry.name);
    if (!slot) continue;
    const held = onDisk.get(slot);
    if (!held || entry.modifiedAt > held.modifiedAt) onDisk.set(slot, entry);
  }

  const newest = new Map<string, RemoteState>();
  for (const state of remote) {
    if (!stateLoadsIn(state, emulator)) continue;
    if (state.size > MAX_STATE_BYTES) continue;
    const slot = slotFromAssetName(state.fileName);
    if (!slot || !localStateName(base, slot)) continue;
    const held = newest.get(slot);
    // Ties on id, because `updated_at` has second resolution: two rows written
    // in the same second would otherwise order arbitrarily.
    const later =
      !held ||
      state.updatedAt > held.updatedAt ||
      (state.updatedAt === held.updatedAt && state.id > held.id);
    if (later) newest.set(slot, state);
  }

  const restore: StateRestore[] = [];
  for (const [slot, state] of newest) {
    const displaces = onDisk.get(slot) ?? null;
    if (displaces && state.updatedAt <= displaces.modifiedAt) continue;
    // The file that is already the slot when there is one, so a restore lands
    // where the emulator is looking rather than beside it.
    const fileName = displaces?.name ?? localStateName(base, slot);
    if (!fileName) continue;
    restore.push({ state, slot, fileName, displaces });
  }
  // Ordered so the log reads in slot order rather than in map order.
  return restore.sort((a, b) => slotNumber(a.slot) - slotNumber(b.slot));
}
