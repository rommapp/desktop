// What this machine and the card library last agreed a card held.
//
// The merge settles each save against that agreement, so it has to outlive
// the launch: one file per server and emulator, beside the save data the shell
// already owns. The card's id is kept with it, so switching to another card
// (the most recently used one changes when a streaming session picks another)
// starts that card from no agreement rather than from the wrong one's.
//
// A file that is missing, unreadable or for another card reads as no
// agreement, which the merge treats as safely as it can: nothing is assumed
// unchanged, and a save on both sides that differs keeps the newer.
//
// No Electron here, so all of it can be tested.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CardBase } from "./merge.ts";

interface StoredBase {
  cardId: number;
  base: Record<string, string>;
}

/** Where the agreement for this server's card for this emulator is kept. */
export function cardStatePath(
  saveDataPath: string,
  serverUrl: string,
  emulator: string,
): string {
  // The origin is hashed rather than used, so nothing about the server
  // becomes part of a file name.
  const server = createHash("sha256")
    .update(new URL(serverUrl).origin)
    .digest("hex")
    .slice(0, 16);
  return join(saveDataPath, ".cards", `${emulator}-${server}.json`);
}

/** The agreement for this card, or none. */
export async function readCardBase(
  path: string,
  cardId: number,
): Promise<CardBase> {
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as StoredBase;
    if (stored.cardId !== cardId || !stored.base || typeof stored.base !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(stored.base).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** Record the agreement, written whole or not at all. */
export async function writeCardBase(
  path: string,
  cardId: number,
  base: Record<string, string>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify({ cardId, base } satisfies StoredBase));
  await rename(temp, path);
}
