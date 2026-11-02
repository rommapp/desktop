// A standalone emulator's save set for one game.
//
// RetroArch's save is a file the shell names and hands over. Dolphin, RPCS3
// and Cemu keep a folder per game under a tree they own, so the unit that
// travels is the set: the files under the save root that RomM's save target
// names, zipped, compared by the digest of its entries (RomM's
// `hash_zip_contents`).
//
// The target bounds both directions, which is the safety argument here. Going
// up it picks this game's files; coming down every member has to be a safe
// relative path and a file the same target names, so an archive naming
// `../../config.ini` or another game's folder writes nothing. The target is
// the server's string and is never used as a path.
//
// No Electron here, so all of it can be tested.

import { zipContentHash } from "../saves/hash.ts";
import { assetStamp, type SaveStamp } from "../saves/plan.ts";
import {
  selectSaveFiles,
  type RomIdentity,
  type SaveTargetLayout,
} from "./identity.ts";
import { type Tree } from "./tree.ts";

/** One member of the set, named relative to the save root and "/"-separated:
 *  how a listing spells it, how the archive spells it, and what the target is
 *  matched against. */
export interface SetMember {
  name: string;
  contents: Buffer;
  modifiedAt: number;
}

/** Far past any real save set (a few hundred files at worst), so a target
 *  matching half an emulator's tree stops rather than being read into
 *  memory. */
export const SET_LIMITS = {
  maxFiles: 2_000,
  maxBytes: 256 * 1024 * 1024,
} as const;

/** The target a game's set is named by, when the server named one. */
export interface SaveTarget {
  target: string;
  layout: SaveTargetLayout;
}

/** The target RomM gave for this game, or null when it gave none that can be
 *  applied. Both halves or neither: a target with no layout cannot be told
 *  from a file prefix. */
export function saveTargetOf(identity: RomIdentity | null): SaveTarget | null {
  return identity?.saveTarget && identity.layout
    ? { target: identity.saveTarget, layout: identity.layout }
    : null;
}

/** The files under the save root this game's target names, in path order. */
export function selectSet(
  files: readonly string[],
  target: SaveTarget,
): string[] {
  return selectSaveFiles(files, target.target, target.layout).sort();
}

/** The set as it sits on disk, with the digest the server compares against. */
export interface LocalSet {
  members: SetMember[];
  /** The member paths, which is what a restore measures staleness against. */
  paths: string[];
  stamp: SaveStamp;
  /** The newest member's time, which is what the negotiation is decided on. */
  updatedAt: Date;
}

/**
 * Put a set together from a listing of the save root and a reader for it.
 *
 * Null means this run cannot say what the set is: a listing cut short, a
 * member that would not read, a target matching more than any save could be.
 * Each would produce a set missing something, and a partial set offered to the
 * slot is one another device restores over a complete one, which is the only
 * way this path loses a save outright.
 *
 * An empty set is not null: it is this game having no save here, which is
 * still somewhere for a download to land.
 */
export async function assembleSet(
  tree: Tree,
  target: SaveTarget,
  read: (path: string) => Promise<Buffer | null>,
  limits: { maxFiles: number; maxBytes: number } = SET_LIMITS,
): Promise<LocalSet | null> {
  if (!tree.complete) return null;

  const paths = selectSet([...tree.files.keys()], target);
  if (paths.length > limits.maxFiles) return null;

  const members: SetMember[] = [];
  let bytes = 0;
  for (const path of paths) {
    const entry = tree.files.get(path);
    const contents = await read(path);
    if (!contents || !entry) return null;
    bytes += contents.length;
    if (bytes > limits.maxBytes) return null;
    members.push({ name: path, contents, modifiedAt: entry.modifiedAt });
  }

  const newest = members.reduce(
    (at, member) => Math.max(at, member.modifiedAt),
    0,
  );
  return {
    members,
    paths,
    stamp: { hash: zipContentHash(members), size: bytes },
    updatedAt: new Date(newest),
  };
}

/**
 * Whether a name out of an archive is one this shell will turn into a path.
 *
 * Absolute paths, drive letters, `..`, backslashes, control characters and
 * Windows' reserved trailing characters are refused rather than cleaned up: a
 * name that needs fixing is not one worth guessing at.
 */
export function safeMemberName(name: string): boolean {
  if (!name || name.length > 512) return false;
  if (name.includes("\\") || name.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f:*?"<>|]/.test(name)) return false;
  const parts = name.split("/");
  if (parts.length > 16) return false;
  return parts.every(
    (part) =>
      part !== "" &&
      part !== "." &&
      part !== ".." &&
      // A trailing dot or space is dropped by Windows when it opens the path,
      // so "data." and "data" are the same file there and different here.
      !/[. ]$/.test(part),
  );
}

export interface RestorePlan {
  /** Members to write, in the order they were read. */
  write: SetMember[];
  /** Members left alone, with the reason, for the log. */
  refused: { name: string; why: string }[];
  /** Total bytes the plan writes. */
  bytes: number;
}

/**
 * What of a downloaded archive may be written under the save root.
 *
 * Two gates: the name has to be safe to join, and the file has to be one this
 * game's target names. Refused member by member rather than whole, so one odd
 * entry does not cost a player their save.
 */
export function planRestore(
  members: readonly SetMember[],
  target: SaveTarget,
  limits: { maxFiles: number; maxBytes: number } = SET_LIMITS,
): RestorePlan {
  const write: SetMember[] = [];
  const refused: { name: string; why: string }[] = [];
  let bytes = 0;

  for (const member of members) {
    if (!safeMemberName(member.name)) {
      refused.push({ name: member.name, why: "the name is not a safe path" });
      continue;
    }
    const named = selectSaveFiles(
      [member.name],
      target.target,
      target.layout,
    );
    if (named.length === 0) {
      refused.push({ name: member.name, why: "it is not this game's save" });
      continue;
    }
    if (write.length >= limits.maxFiles) {
      refused.push({
        name: member.name,
        why: "the archive holds too many files",
      });
      continue;
    }
    if (bytes + member.contents.length > limits.maxBytes) {
      refused.push({ name: member.name, why: "the archive is too large" });
      continue;
    }
    bytes += member.contents.length;
    write.push(member);
  }

  return { write, refused, bytes };
}

/**
 * The files a restore leaves behind that the archive did not replace.
 *
 * A set is compared whole, so one of these keeps the two sides from ever
 * agreeing again. Bounded by the same target as everything else, and only
 * reached once the displaced bytes are on the server (`archiveFirst`).
 */
export function staleAfterRestore(
  localSet: readonly string[],
  written: readonly SetMember[],
): string[] {
  const kept = new Set(written.map((member) => member.name));
  return localSet.filter((path) => !kept.has(path)).sort();
}

/** The name a set travels under. `.saves.zip` is what RomM's streaming writes
 *  its own save archives as, and the extension is what the server reads a set
 *  by: it hashes a zip by its entries. */
export function setFileName(base: string): string {
  return `${base}.saves.zip`;
}

/** The name a displaced set is archived under, stamped the way RomM's own
 *  asset names are so it sorts and reads with them in the library. */
export function archiveSetName(base: string, at: Date): string {
  return `${base} [${assetStamp(at)}].saves.zip`;
}
