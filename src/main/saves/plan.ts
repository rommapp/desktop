// What to do about a save, decided without touching anything.
//
// The server has its own opinion (see RomM's `handler/sync/comparison.py`) and
// returns one operation per ROM. This module is the shell's reading of that
// answer: it does no I/O, makes no request, and never decides to discard bytes
// that exist nowhere else. Keeping it pure is what makes the destructive-looking
// decisions testable without a server, an emulator, or a filesystem.

import { saveBaseName } from "./paths.ts";

/**
 * The slot native launches share with the browser client.
 *
 * Saves pair on (rom_id, slot), so a native launch and a browser session that
 * both use this name are one save rather than two. Mirrors `AUTOSAVE_SLOT` in
 * RomM's `frontend/src/services/api/save.ts`.
 */
export const AUTOSAVE_SLOT = "autosave";

/**
 * Ceiling on a save this shell will accept from the server.
 *
 * Mirrors the server's `MAX_ASSET_UPLOAD_SIZE_BYTES`, the size it refuses an
 * upload at. Applied to the download instead, where it is the side that matters:
 * the body is about to be written to the user's disk, and a row claiming more
 * than any save could be is not one to start fetching. The server bounds the
 * other direction itself.
 */
export const MAX_SAVE_BYTES = 512 * 1024 * 1024;

/** What the emulator left on disk, as far as the shell can tell. */
export interface SaveStamp {
  /** md5 of the bytes, or null when the file could not be read. */
  hash: string | null;
  size: number;
}

/** The save on disk, as the negotiate request describes it. */
export interface LocalSave {
  fileName: string;
  contentHash: string | null;
  /** Last modification time, which the server compares against. */
  updatedAt: Date;
  sizeBytes: number;
}

/** One operation from the negotiate response, for the ROM being launched. */
export interface SyncOperation {
  action: "upload" | "download" | "conflict" | "no_op";
  rom_id: number;
  save_id: number | null;
  file_name: string;
  slot: string | null;
  server_content_hash: string | null;
}

/** What the push stage may do, decided before the emulator ever runs. */
export type Allowance = "push" | "conflict" | "unreachable";

/** What the push stage will do, decided from what the emulator left behind. */
export type PushAction = "none" | "push" | "archive";

export interface PullPlan {
  /** Download the server's save over the local one. */
  pull: boolean;
  /** Send the local bytes up as a null-slot save before that happens. */
  archiveFirst: boolean;
  allowance: Allowance;
}

/**
 * The negotiate body for one ROM.
 *
 * At most one save is sent, and it carries no `emulator`: assets are stored in
 * per-emulator directories, so naming one would file a native launch's saves
 * somewhere the browser client cannot find them. `device_id` is the caller's to
 * add; it comes from registration, not from anything here.
 *
 * A null save is not the same as an empty one. It means this launch has nothing
 * on disk for the ROM yet, so the list is empty and the negotiation is only a
 * question about what the server has to offer.
 */
export function buildNegotiatePayload(romId: number, local: LocalSave | null) {
  return {
    saves: local
      ? [
          {
            rom_id: romId,
            file_name: local.fileName,
            slot: AUTOSAVE_SLOT,
            content_hash: local.contentHash,
            updated_at: local.updatedAt.toISOString(),
            file_size_bytes: local.sizeBytes,
          },
        ]
      : [],
    rom_ids: [romId],
  };
}

/**
 * What to do with the server's answer.
 *
 * A null operation here is an answer, not the absence of one: the server was
 * asked and had nothing to say about this ROM, which is the ordinary first
 * launch where neither side holds a save yet. Nothing comes down, and the save
 * the emulator is about to make is still the shell's to offer afterwards.
 * Not being able to ask at all is the caller's to report, and reads as
 * `unreachable`.
 */
export function planPull(
  op: SyncOperation | null,
  local: SaveStamp | null,
): PullPlan {
  if (!op) return { pull: false, archiveFirst: false, allowance: "push" };

  const allowance: Allowance = op.action === "conflict" ? "conflict" : "push";

  // Both conditions beyond the action are the same rule read twice: a download
  // replaces a file, so it happens only when the shell can say what it is about
  // to write and what it is about to displace. A server hash it does not have
  // is a transfer it cannot check before the rename; a local file it could not
  // read is bytes it cannot prove are held anywhere else. Either way it keeps
  // what is on disk, which costs a sync and loses nothing.
  const pull =
    op.action === "download" &&
    op.save_id !== null &&
    op.server_content_hash !== null &&
    !(local !== null && local.hash === null);

  // The server's copy is about to be written over these bytes. When they are not
  // the bytes the server already holds, nothing else has them: a device with no
  // sync history can be handed a download on a timestamp alone, and this is what
  // keeps that from being a silent overwrite of the only copy.
  const archiveFirst =
    pull && local !== null && local.hash !== op.server_content_hash;

  return { pull, archiveFirst, allowance };
}

/**
 * Whether the emulator changed anything worth sending.
 *
 * `archive` covers the conflict case, where the server's slot belongs to bytes
 * this device has never seen: the local copy goes up as a new null-slot save
 * rather than being written over the top of them, or dropped.
 */
export function planPush(
  before: SaveStamp | null,
  after: SaveStamp | null,
  allowance: Allowance,
): PushAction {
  if (allowance === "unreachable") return "none";

  // Nothing on disk to send: the emulator either never made the file or removed
  // it, and a deletion is not something this shell propagates.
  if (!after) return "none";

  const difference = changed(before, after);

  // An archival save is paired with nothing and replaces nothing, so "cannot
  // tell" costs a duplicate at worst and is worth erring towards. Declining the
  // one case it can tell -- bytes the emulator demonstrably left alone -- is
  // what keeps a conflicted game from filing another archive every launch, with
  // no slot to rotate them and nothing to reap them.
  if (allowance === "conflict") return difference === false ? "none" : "archive";

  // The slot is shared with the browser client, and a version other devices
  // sync from is not one to mint on a guess.
  return difference === true ? "push" : "none";
}

/**
 * Whether the file the emulator left differs from the one it started with.
 *
 * Three answers rather than two. Null is "cannot tell", which the two callers
 * above resolve in opposite directions, because what an unnecessary push costs
 * and what an unnecessary archive costs are not the same thing.
 */
function changed(before: SaveStamp | null, after: SaveStamp): boolean | null {
  if (!before) return true;
  if (before.hash === null || after.hash === null) return null;
  return before.hash !== after.hash;
}

/**
 * The name a displaced save is archived under.
 *
 * Reproduces `sessionStateName` in RomM's `frontend/src/services/api/state.ts`
 * so an archived save sorts and reads the same as the states the browser client
 * writes beside it.
 */
export function archiveName(fileName: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", " ")
    .replace("Z", "");
  return `${saveBaseName(fileName)} [${stamp}].srm`;
}
