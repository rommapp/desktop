// What sits under one of an emulator's save or state folders, and what a run
// changed there.
//
// RomM's save target names a game's files when the server could read the
// game's id, which it cannot for every ROM: the reader is optional in a RomM
// build, and a format it does not parse yields no id. The fallback is to watch.
// A listing before the emulator starts and another after it exits say which
// files the run wrote, and a run only plays one game.
//
// Symlinks are listed as nothing, the root included. A save folder holds files
// the emulator wrote, and following a link would read, and later archive,
// whatever it points at.
//
// A listing says whether it saw everything. One cut short by a limit or an
// unreadable folder cannot be diffed: a file missing from the before-reading
// would read as one the run wrote, and a sync acting on that would archive an
// unrelated save as this game's.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TreeEntry {
  size: number;
  /** Milliseconds, as `stat` reports it. */
  modifiedAt: number;
}

export interface Tree {
  /** Files under the root, keyed by their path relative to it,
   *  "/"-separated. */
  files: Map<string, TreeEntry>;
  /** False when a limit, an unreadable folder or a symlinked root left
   *  something out. A root that does not exist is complete and empty. */
  complete: boolean;
}

export interface TreeLimits {
  maxEntries: number;
  maxDepth: number;
}

/**
 * Bounds on a listing. A memory card folder is dozens of files and an RPCS3
 * savedata tree a few hundred; these are far past either, and only here so a
 * root pointed somewhere enormous stops rather than walking a whole disk.
 */
export const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxEntries: 20_000,
  maxDepth: 12,
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Every file under `root`. Never throws; what it could not see is recorded
 *  as an incomplete listing instead. */
export async function listTree(
  root: string,
  limits: TreeLimits = DEFAULT_TREE_LIMITS,
): Promise<Tree> {
  const files = new Map<string, TreeEntry>();
  let complete = true;

  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    return { files, complete: isMissing(error) };
  }
  if (!rootInfo.isDirectory()) return { files, complete: false };

  const walk = async (directory: string, prefix: string, depth: number) => {
    if (depth > limits.maxDepth) {
      complete = false;
      return;
    }
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      complete = false;
      return;
    }
    for (const name of names.sort()) {
      if (files.size >= limits.maxEntries) {
        complete = false;
        return;
      }
      const path = join(directory, name);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        // Deleted between the listing and the stat is simply gone.
        if (!isMissing(error)) complete = false;
        continue;
      }
      const relative = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory()) {
        await walk(path, relative, depth + 1);
      } else if (info.isFile()) {
        files.set(relative, { size: info.size, modifiedAt: info.mtimeMs });
      }
    }
  };
  await walk(root, "", 0);
  return { files, complete };
}

/**
 * The files a run added or rewrote, in path order, or null when either
 * listing is incomplete and the difference cannot be trusted. A file the run
 * deleted is not in the answer: there is nothing of it left to send.
 */
export function changedFiles(before: Tree, after: Tree): string[] | null {
  if (!before.complete || !after.complete) return null;
  return [...after.files]
    .filter(([path, entry]) => {
      const was = before.files.get(path);
      return (
        !was || was.size !== entry.size || was.modifiedAt !== entry.modifiedAt
      );
    })
    .map(([path]) => path)
    .sort();
}
