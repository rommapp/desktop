// What sits under one of an emulator's save or state folders, and what a run
// changed there.
//
// RomM's save target names a game's files when the server could read the
// game's id, which it cannot for every ROM: the reader is optional in a RomM
// build, and a format it does not parse yields no id. The fallback is to watch.
// A listing before the emulator starts and another after it exits say which
// files the run wrote, and a run only plays one game.
//
// Symlinks are listed as nothing. A save folder holds files the emulator
// wrote, and following a link would read, and later archive, whatever it
// points at.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TreeEntry {
  size: number;
  /** Milliseconds, as `stat` reports it. */
  modifiedAt: number;
}

/** Files under a root, keyed by their path relative to it, "/"-separated. */
export type Tree = Map<string, TreeEntry>;

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

/**
 * Every file under `root`, or an empty tree when it cannot be read.
 *
 * Stops quietly at a limit rather than throwing. The listing informs a
 * decision about which files to move, and a partial one read as complete
 * would only ever move less, never something that is not a save.
 */
export async function listTree(
  root: string,
  limits: TreeLimits = DEFAULT_TREE_LIMITS,
): Promise<Tree> {
  const tree: Tree = new Map();
  const walk = async (directory: string, prefix: string, depth: number) => {
    if (depth > limits.maxDepth) return;
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (tree.size >= limits.maxEntries) return;
      const path = join(directory, name);
      const info = await lstat(path).catch(() => null);
      if (!info) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory()) {
        await walk(path, relative, depth + 1);
      } else if (info.isFile()) {
        tree.set(relative, { size: info.size, modifiedAt: info.mtimeMs });
      }
    }
  };
  await walk(root, "", 0);
  return tree;
}

/** The files a run added or rewrote, in path order. A file the run deleted is
 *  not in the answer: there is nothing of it left to send. */
export function changedFiles(before: Tree, after: Tree): string[] {
  return [...after]
    .filter(([path, entry]) => {
      const was = before.get(path);
      return (
        !was || was.size !== entry.size || was.modifiedAt !== entry.modifiedAt
      );
    })
    .map(([path]) => path)
    .sort();
}
