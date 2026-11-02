// A standalone emulator's save set for one game: what it is, and what may be
// written back into it.
//
// RetroArch's save is a file, so the shell can name it, hand it to the
// emulator and read it back. Dolphin, RPCS3 and Cemu keep a folder per game
// under one tree they own, several files that only mean anything together, and
// nothing the shell says at launch moves them. So the unit that travels is the
// set: the files under the emulator's save root that RomM's save target names
// for this game, carried as one zip and compared by the digest of its entries
// (`zipContentHash`, which is RomM's `hash_zip_contents`).
//
// The target is what bounds both directions, and that is the whole safety
// argument here. Going up, it decides which of the emulator's files are this
// game's, so a launch never sends another game's save. Coming down, every
// member of the archive has to be a path that is safe to join and a file the
// same target names, so an archive naming `../../config.ini`, or naming
// another game's folder, writes nothing. A target is the server's string, and
// the one place it would be dangerous is as a path; it is never used as one.
//
// Without a target there is no set. The watch-the-folder fallback in tree.ts
// says what a run wrote, which is worth logging and is not worth uploading:
// what it catches is "files that changed", and an emulator writing its own
// settings, or a second game's save landing in the same tree, is caught by
// exactly that description.
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

/** One member of the set, named the way a listing of the save root names it:
 *  relative to the root and "/"-separated, which is also how it is spelled in
 *  the archive and how the target is matched against it. */
export interface SetMember {
  name: string;
  contents: Buffer;
  modifiedAt: number;
}

/** What a save set may be, before it is read off disk or out of an archive.
 *
 *  A Wii game's storage is a handful of files and an RPCS3 save folder a few
 *  dozen; a memory card folder can be a few hundred. These are far past any of
 *  them, and only here so a target that matches half an emulator's tree, or an
 *  archive built by something else, stops rather than being read whole into
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

/**
 * The target RomM gave for this game, or null when it gave none that can be
 * applied.
 *
 * Both halves or neither: a target with no layout cannot be told from a file
 * prefix, which identity.ts already drops, and this is the shape the rest of
 * the sync asks for.
 */
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
 * Put a set together from a listing of the save root and a reader for the
 * files in it.
 *
 * Null is the one answer that is not a set, and every way of reaching it is
 * the same thing: this run cannot say what the set is. A listing cut short, a
 * member that would not read, a target matching more files or more bytes than
 * any save could be. Each of them would otherwise produce a set missing
 * something, and a set is compared and restored whole, so a partial one
 * offered to the slot is one another device would restore over a complete
 * one. That is the only way this path can lose a save that exists nowhere
 * else, which is why it is four returns rather than a best effort.
 *
 * An empty set is not null. A folder that is not there, and a target that
 * names none of what is, are both this game having no save here: nothing to
 * send, and somewhere for a download to land.
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
 * Everything an archive says about where its members go is the archive's to
 * say, so this is the gate that keeps it inside the save root. Absolute paths,
 * drive letters, UNC prefixes, `..`, backslashes (a separator on Windows and a
 * literal character elsewhere, which is how one name means two things),
 * control characters and Windows' reserved trailing characters are all refused
 * rather than cleaned up: a name that needs fixing is not one worth guessing
 * at.
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
 * Two gates, and a member has to pass both. The name has to be safe to join to
 * the root, and the file has to be one this game's target names, which is the
 * same question asked of the files already on disk. Together they mean a
 * restore can only ever write where this game's own saves live: an archive
 * that names another game's folder, or a path out of the tree, is refused
 * member by member rather than refusing the whole transfer, so one odd entry
 * does not cost a player their save.
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
 * A set is compared whole, so a file the server's copy does not hold keeps the
 * two from ever agreeing again: every negotiation after it reads as a change
 * this device made. These are the ones to remove, and they are bounded by the
 * same target as everything else, so a restore can only ever delete files this
 * game's save target names.
 *
 * Only reached once the displaced bytes are already on the server, which is
 * what `planPull`'s `archiveFirst` is for.
 */
export function staleAfterRestore(
  localSet: readonly string[],
  written: readonly SetMember[],
): string[] {
  const kept = new Set(written.map((member) => member.name));
  return localSet.filter((path) => !kept.has(path)).sort();
}

/**
 * The name a set travels under.
 *
 * `.saves.zip` is what RomM's own streaming writes a pulled save archive as
 * (`store_save_asset` in `handler/streaming/saves.py`), and the extension is
 * what the server reads a set by: it hashes a zip by its entries, and the
 * streaming side will only restore an archive. The slot tags a version onto
 * the stem, which leaves the extension where it is.
 */
export function setFileName(base: string): string {
  return `${base}.saves.zip`;
}

/** The name a displaced set is archived under, stamped the way RomM's own
 *  asset names are so it sorts and reads with them in the library. */
export function archiveSetName(base: string, at: Date): string {
  return `${base} [${assetStamp(at)}].saves.zip`;
}
