// Merging a memory card from RomM's card library with the one on this machine.
//
// RomM keeps PS2 and GameCube saves as whole memory cards, per user and
// emulator, and its streaming lays the newest version of a card down whole and
// stores the whole card back afterwards. That works for a container that is
// emptied between players. It does not work here: this machine's card holds
// progress of its own, possibly for games another device has also played
// since, and laying the server's card over it, or this one over the server's,
// loses whichever side was not chosen.
//
// What makes a merge possible is that both cards this shell syncs keep each
// save apart: a PCSX2 folder card has one folder per save, Dolphin's GCI
// folder one file per save. So the unit merged is a save, not the card, and
// each one is settled against the version both sides last agreed on:
//
// - changed on one side only: that side's wins;
// - changed on both: the newer wins, by the time its files were written;
// - present on one side only: kept, and copied to the other. A deletion is
//   not propagated, the same rule the rest of this shell's sync keeps, since a
//   save that disappeared is far more often a lost one than a deleted one.
//
// Nothing is lost when a side loses. RomM keeps every version of a card, so a
// server copy that loses is still in the card's history. A local copy that
// loses is uploaded as a version of its own first (`archiveFirst`), so it is
// in that history too before anything overwrites it.
//
// Files that are not a save (PCSX2's superblock, the IPL or a raw card in
// Dolphin's GC folder) are the card's own and are never merged: see `Rest`.
//
// No Electron and no filesystem here, so all of it can be tested.

import { zipContentHash } from "../saves/hash.ts";
import { type ZipFile } from "../zip.ts";

/** A file of a card, named relative to the card's root, "/"-separated, as the
 *  card library's zip names it. */
export type CardFile = ZipFile;

/** One save on a card: the files that only mean anything together. */
export interface CardUnit {
  key: string;
  files: CardFile[];
  /** A digest of the save's files and their names. */
  hash: string;
  /** When its newest file was written, in milliseconds. */
  modifiedAt: number;
}

/** A card split into its saves and everything else on it. */
export interface SplitCard {
  units: Map<string, CardUnit>;
  /** The files that are not a save. */
  rest: CardFile[];
}

/** Which save a file belongs to, or null for a file that is not part of one. */
export type UnitOf = (name: string) => string | null;

/** What each save's digest was when this machine and the server last agreed.
 *  Keyed by the save's key. */
export type CardBase = Readonly<Record<string, string>>;

/** Split a card into its saves. */
export function splitCard(files: readonly CardFile[], unitOf: UnitOf): SplitCard {
  const grouped = new Map<string, CardFile[]>();
  const rest: CardFile[] = [];
  for (const file of files) {
    const key = unitOf(file.name);
    if (key === null) {
      rest.push(file);
      continue;
    }
    const group = grouped.get(key) ?? [];
    group.push(file);
    grouped.set(key, group);
  }
  const units = new Map<string, CardUnit>();
  for (const [key, group] of grouped) {
    units.set(key, {
      key,
      files: group,
      hash: zipContentHash(group),
      modifiedAt: group.reduce((at, file) => Math.max(at, file.modifiedAt), 0),
    });
  }
  return { units, rest };
}

/** The digest of a whole card, as RomM's `hash_zip_contents` gives it. */
export function cardHash(files: readonly CardFile[]): string {
  return zipContentHash(files);
}

/**
 * Where a merged card's other files come from.
 *
 * `local` for PCSX2, whose only other file is the card's superblock: the one
 * this machine formatted is the one its PCSX2 reads, and a card that does not
 * exist here yet takes the server's. `server` for Dolphin, whose GC folder also
 * holds firmware and raw card images that belong to this machine and are not
 * the card library's to receive.
 */
export type RestFrom = "local" | "server";

export interface MergePlan {
  /** Saves to write into the local card, each replacing what is there. */
  pull: CardUnit[];
  /** The card's other files to write locally, for a card that does not
   *  exist here yet. */
  pullRest: CardFile[];
  /** Upload this machine's card as a version before anything is written,
   *  because a save on it that has not reached the server is about to be
   *  replaced. */
  archiveFirst: CardFile[] | null;
  /** The merged card to upload, or null when the server already holds it. */
  upload: CardFile[] | null;
  /** What to record as agreed once both sides hold the merged card. */
  base: Record<string, string>;
  /** Saves both sides changed, for the log, with the side that won. */
  conflicts: { key: string; kept: "local" | "server" }[];
}

/**
 * Settle a local card against the server's.
 *
 * `local` is null when this machine has no card yet; `server` is null when
 * the card library holds no version of it yet.
 */
export function planCardMerge(options: {
  base: CardBase;
  local: SplitCard | null;
  server: SplitCard | null;
  restFrom: RestFrom;
}): MergePlan {
  const { base, restFrom } = options;
  const local = options.local ?? { units: new Map(), rest: [] };
  const server = options.server ?? { units: new Map(), rest: [] };

  const merged = new Map<string, CardUnit>();
  const pull: CardUnit[] = [];
  const conflicts: MergePlan["conflicts"] = [];
  // Whether a save with progress the server has not seen is about to be
  // replaced by the server's.
  let overwritesUnsynced = false;

  const keys = new Set([...local.units.keys(), ...server.units.keys()]);
  for (const key of [...keys].sort()) {
    const mine = local.units.get(key);
    const theirs = server.units.get(key);
    const agreed = base[key];
    if (!theirs) {
      if (mine) merged.set(key, mine);
      continue;
    }
    if (!mine) {
      // Deleted here since the last agreement: not propagated, and not undone
      // either, so the server keeps it and this machine stays without it.
      merged.set(key, theirs);
      if (agreed === undefined || agreed !== theirs.hash) pull.push(theirs);
      continue;
    }
    if (mine.hash === theirs.hash) {
      merged.set(key, mine);
      continue;
    }
    const localChanged = agreed !== mine.hash;
    const serverChanged = agreed !== theirs.hash;
    let winner: "local" | "server";
    if (!serverChanged) winner = "local";
    else if (!localChanged) winner = "server";
    else {
      // Both moved, or there is no agreement to compare with. The newer
      // write is the progress most likely wanted; the other is kept in the
      // card's history either way.
      winner = theirs.modifiedAt > mine.modifiedAt ? "server" : "local";
      conflicts.push({ key, kept: winner });
    }
    if (winner === "local") {
      merged.set(key, mine);
      continue;
    }
    merged.set(key, theirs);
    pull.push(theirs);
    if (localChanged) overwritesUnsynced = true;
  }

  const hasLocalCard = options.local !== null;
  const rest =
    restFrom === "local" && hasLocalCard ? local.rest : server.rest;
  const pullRest = restFrom === "local" && !hasLocalCard ? server.rest : [];

  const mergedFiles = [
    ...rest,
    ...[...merged.values()].flatMap((unit) => unit.files),
  ];
  const nothingOnEitherSide = merged.size === 0;
  const serverFiles = options.server
    ? [...server.rest, ...[...server.units.values()].flatMap((u) => u.files)]
    : null;
  const upload =
    nothingOnEitherSide ||
    (serverFiles !== null && cardHash(serverFiles) === cardHash(mergedFiles))
      ? null
      : mergedFiles;

  const localFiles = [
    ...(restFrom === "local" ? local.rest : server.rest),
    ...[...local.units.values()].flatMap((unit) => unit.files),
  ];

  return {
    pull,
    pullRest,
    archiveFirst: overwritesUnsynced ? localFiles : null,
    upload,
    base: Object.fromEntries(
      [...merged.values()].map((unit) => [unit.key, unit.hash]),
    ),
    conflicts,
  };
}

/** The save a PCSX2 folder card file belongs to: the folder it sits in. Files
 *  at the card's root (`_pcsx2_superblock`) belong to the card. */
export const pcsx2UnitOf: UnitOf = (name) => {
  const parts = name.split("/");
  return parts.length >= 2 ? (parts[0] ?? null) : null;
};

/** Dolphin's region folders, as the card library's GC tree names them. */
const GC_REGION = /^(usa|eur|jap|jpn|dev)$/i;

/** The save a Dolphin GC file belongs to: a `.gci` in a region's `Card A`
 *  folder is one on its own. Anything else in GC is not a save. */
export const dolphinUnitOf: UnitOf = (name) => {
  const parts = name.split("/");
  return parts.length === 3 &&
    GC_REGION.test(parts[0] ?? "") &&
    /^card a$/i.test(parts[1] ?? "") &&
    /\.gci$/i.test(parts[2] ?? "")
    ? name
    : null;
};

/**
 * The agreement to record when the plan's pulls are not written here.
 *
 * After the game exits, the card is read and released before anything is
 * sent, so what the server won is not written until the next launch. That
 * launch has to see those saves as changed on the server only, which means
 * recording this machine's copy of each as the agreed one: the server's then
 * reads as the newer side, and comes down. A save this machine does not have
 * is left out, so it comes down as one the server alone holds.
 */
export function baseWithoutPulls(
  plan: MergePlan,
  local: SplitCard | null,
): Record<string, string> {
  const base = { ...plan.base };
  for (const unit of plan.pull) {
    const mine = local?.units.get(unit.key);
    if (mine) base[unit.key] = mine.hash;
    else delete base[unit.key];
  }
  return base;
}
