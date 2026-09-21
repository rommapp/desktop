// What to do about a save, decided without touching anything.
//
// The server has its own opinion (see RomM's `handler/sync/comparison.py`) and
// returns one operation per ROM. This module is the shell's reading of that
// answer: it does no I/O, makes no request, and never decides to discard bytes
// that exist nowhere else. Keeping it pure is what makes the destructive-looking
// decisions testable without a server, an emulator, or a filesystem.

import { saveBaseName } from "./paths.ts";
import { DEFAULT_RETROARCH_AUTOSAVE_SECONDS } from "./retroarch.ts";

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

/**
 * What the push stage may do, decided before the emulator ever runs.
 *
 * `requested` is the server having asked for this save outright, which is a
 * stronger thing than being allowed to offer one.
 */
export type Allowance = "push" | "requested" | "conflict" | "unreachable";

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
 * Whether a body is the save row RomM answers an accepted upload with.
 *
 * A 2xx on its own is not proof a save landed. A proxy or a sign-in page can
 * produce one, and `apiRequest` reports a body it could not parse as null
 * rather than as a failure. This answer is load bearing in a way the others are
 * not: the pull archives the local bytes and then writes over them on the
 * strength of it, so anything that can forge an "ok" can cost the only copy of
 * a save. `POST /api/saves` answers with the save it stored, and a stored save
 * has an id.
 */
export function storedSave(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { id?: unknown }).id === "number"
  );
}

/**
 * The one operation in the server's answer that belongs to this launch.
 *
 * The answer can be about more than the ROM that was asked about, and can hold
 * more than one operation for that ROM: with no local save to compare against,
 * the server has every slot the ROM owns to describe rather than the one this
 * launch cares about. So the ROM is matched first and the slot second, and a
 * manual slot is passed over rather than written into the file the emulator is
 * about to be pointed at.
 *
 * An operation naming no slot is still this launch's. It is the server talking
 * about the ROM rather than about one of its slots, which is the shape a no-op
 * takes, and reading it as someone else's would throw away the answer.
 */
export function selectOperation(
  operations: unknown[],
  romId: number,
): SyncOperation | null {
  const ours = operations
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        (item as { rom_id?: unknown }).rom_id === romId,
    )
    .map(toOperation);

  return (
    ours.find((op) => op.slot === AUTOSAVE_SLOT) ??
    ours.find((op) => op.slot === null) ??
    null
  );
}

/** Coerce one operation, keeping only the fields this code acts on. */
function toOperation(raw: unknown): SyncOperation {
  const item = raw as Record<string, unknown>;
  const action = item.action;
  return {
    action:
      action === "upload" ||
      action === "download" ||
      action === "conflict" ||
      action === "no_op"
        ? action
        : "no_op",
    rom_id: typeof item.rom_id === "number" ? item.rom_id : 0,
    save_id: typeof item.save_id === "number" ? item.save_id : null,
    file_name: typeof item.file_name === "string" ? item.file_name : "",
    slot: typeof item.slot === "string" ? item.slot : null,
    server_content_hash:
      typeof item.server_content_hash === "string"
        ? item.server_content_hash
        : null,
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

  // `upload` is the server saying it has nothing paired with this slot and
  // wants what the client holds. That is a request, not a permission, and the
  // push stage treats it as one.
  const allowance: Allowance =
    op.action === "conflict"
      ? "conflict"
      : op.action === "upload"
        ? "requested"
        : "push";

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
 * How often to look at the save file while the emulator runs, given how often
 * the emulator has been asked to write it.
 *
 * A third of the writing cadence, never the cadence itself. Two readings have
 * to agree before a save is offered, so looking exactly as often as the file
 * changes is how a game that writes on every flush is never offered at all:
 * each reading catches a different version and no two ever agree. At a third,
 * two of the three readings between one write and the next fall in the quiet
 * between them.
 *
 * Zero is the user leaving RetroArch's own interval alone, which the shell
 * cannot read, so the default cadence stands in: whatever the emulator does,
 * looking is cheap and finding nothing costs a hash.
 */
export function watchIntervalFor(autosaveSeconds: number): number {
  const cadence =
    Number.isFinite(autosaveSeconds) && autosaveSeconds > 0
      ? autosaveSeconds
      : DEFAULT_RETROARCH_AUTOSAVE_SECONDS;
  return Math.max(Math.round((cadence * 1000) / 3), MIN_WATCH_INTERVAL_MS);
}

/** Floor on the above: a hash of a memory card measured in megabytes is not
 *  free, and no emulator writes a save more often than this. */
const MIN_WATCH_INTERVAL_MS = 2_000;

/**
 * Whether a reading of the save file taken during a run is worth offering.
 *
 * Two readings have to agree before anything is sent. The emulator writes the
 * file, not the shell, so a reading taken while that write is in progress
 * describes half of one -- and the autosave slot is what every other device
 * syncs from. Two identical readings an interval apart is the same rule the
 * browser player applies to its own ticks (`createSaveSyncTracker` in RomM's
 * `frontend/src/views/Player/EmulatorJS/utils.ts`), and it costs one interval
 * of delay rather than a torn save on the server.
 *
 * Bytes the server already holds are not offered again, which is what keeps a
 * game that writes nothing from uploading the same save every interval.
 */
export function planTick(
  previous: SaveStamp | null,
  current: SaveStamp | null,
  baseline: SaveStamp | null,
): boolean {
  if (current === null || current.hash === null) return false;
  if (previous === null || previous.hash !== current.hash) return false;
  return baseline === null || baseline.hash !== current.hash;
}

/**
 * Whether there is anything worth sending, and in what form.
 *
 * Mostly this is "did the emulator change the file", but not always. `archive`
 * covers the conflict case, where the server's slot belongs to bytes this
 * device has never seen: the local copy goes up as a new null-slot save rather
 * than being written over the top of them, or dropped. And a save the server
 * asked for is sent whether or not this run touched it.
 *
 * `expected` is a digest the caller has already seen twice, which is how a save
 * offered mid-run earns the right to be sent (see `planTick`). The bytes that
 * reach the server have to be those bytes: a write landing between the reading
 * that settled and the read that sends would otherwise put half a file in the
 * slot every other device syncs from. Not matching is not a failure, it is a
 * write in progress, so it waits for the next agreement.
 */
export function planPush(
  before: SaveStamp | null,
  after: SaveStamp | null,
  allowance: Allowance,
  expected?: string | null,
): PushAction {
  if (allowance === "unreachable") return "none";

  // Nothing on disk to send: the emulator either never made the file or removed
  // it, and a deletion is not something this shell propagates.
  if (!after) return "none";

  if (expected != null && after.hash !== expected) return "none";

  const difference = changed(before, after);

  // An archival save is paired with nothing and replaces nothing, so "cannot
  // tell" costs a duplicate at worst and is worth erring towards. Declining the
  // one case it can tell -- bytes the emulator demonstrably left alone -- is
  // what keeps a conflicted game from filing another archive every launch, with
  // no slot to rotate them and nothing to reap them.
  if (allowance === "conflict")
    return difference === false ? "none" : "archive";

  // The server has nothing in this slot and said so. Whether the emulator wrote
  // anything this run is beside the point: the save exists here and nowhere
  // else, and declining to send it because the last hour of play happened to
  // change nothing is how a library of saves stays on one machine forever.
  if (allowance === "requested") return "push";

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
