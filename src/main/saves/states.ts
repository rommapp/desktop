// Mirroring a game's savestates into RomM.
//
// Deliberately much less than the save sync beside it. A save is one file with
// one meaning, and RomM pairs it with the devices that hold it: there is a
// slot, a content hash, a device baseline and a negotiation, and all of it
// exists because two machines can write the same save and only one of them can
// win. A state has none of that. `POST /api/states` takes a ROM, an emulator
// and a file; there is no slot, no hash, no `device_state_sync` table and
// nothing in the negotiation that mentions one.
//
// So this does the only thing that surface supports, and does it one way: at
// the end of a run, the states this run wrote go up. Nothing is downloaded,
// nothing is deleted, nothing is negotiated, and no state is ever written over
// a local file. A state is core- and build-specific, so what lands in RomM is
// for browsing and for fetching by hand, not for resuming on another machine.
//
// What keeps it from piling up is the name. RomM's `store_state_file` updates
// the row already at a filename, so a name that is stable per slot rewrites
// that slot's row every run rather than leaving one behind. The name carries
// this machine as well, because the row is found by filename alone: two
// desktops mirroring their own slot 3 under one name would take turns
// destroying each other's, and a state from the wrong machine is worse than no
// state at all.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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
