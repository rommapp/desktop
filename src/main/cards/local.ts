// The memory card on this machine, read and written for a merge.
//
// merge.ts decides; this is the part that touches the disk. Which card is
// read follows the emulator's own settings, the same way the save sync does,
// so it is the card the emulator will actually use:
//
// - PCSX2: slot 1's card (`Slot1_Filename` in PCSX2.ini, `Mcd001.ps2` by
//   default) in its memory card folder. Only a folder card can be merged; a
//   file card is one image holding every game, which the card library refuses
//   too, and is reported rather than touched.
// - Dolphin: the GameCube saves in its GC folder, wherever its settings put
//   it, translated to the card library's `<region>/Card A/<name>.gci` names
//   when a configured GCI folder lays them out without the card level.
//
// Every name written comes from an archive, so each is checked as a safe
// relative path and the way down to it for links, as the save restore does.
//
// No Electron here, so all of it can be tested.

import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep, win32 } from "node:path";
import { isWithin } from "../safety.ts";
import { pcsx2CardKind } from "../standalone/cards.ts";
import { iniValue, type ReadText } from "../standalone/moved.ts";
import { safeMemberName, type MemberLayout } from "../standalone/set.ts";
import { listTree } from "../standalone/tree.ts";
import {
  dolphinUnitOf,
  pcsx2UnitOf,
  splitCard,
  type CardFile,
  type CardUnit,
  type RestFrom,
  type SplitCard,
  type UnitOf,
} from "./merge.ts";

/** Dolphin's EXIDeviceType for a raw memory card image (EXI_Device.h). */
const DOLPHIN_RAW_CARD = "1";

/** A card this shell can merge, and how it maps onto the card library's. */
export interface LocalCard {
  /** The card library's emulator name. */
  emulator: "pcsx2" | "dolphin";
  /** The folder the card's files are relative to. */
  root: string;
  /** Whether the card is there yet. A missing one is created from the
   *  server's. */
  exists: boolean;
  unitOf: UnitOf;
  restFrom: RestFrom;
  /** How a name under `root` relates to the library's, when they differ. */
  layout: MemberLayout | null;
}

/**
 * The card a launch of this platform uses, or the reason there is none to
 * merge. Null for a platform the card library holds no card for.
 */
export async function localCardFor(options: {
  emulatorId: string;
  platformSlug: string;
  /** The emulator's user folder. */
  folder: string;
  /** Where its saves are, already resolved. */
  saveRoot: string;
  layout: MemberLayout | null;
  platform: NodeJS.Platform;
  read: ReadText;
}): Promise<LocalCard | { skip: string } | null> {
  const path = options.platform === "win32" ? win32 : posix;
  const slug = options.platformSlug.toLowerCase();
  if (options.emulatorId === "pcsx2" && slug === "ps2") {
    const ini = options.read(path.join(options.folder, "inis", "PCSX2.ini"));
    const name =
      (ini && iniValue(ini, "MemoryCards", "Slot1_Filename")) || "Mcd001.ps2";
    // The name becomes a directory this shell writes into, so it has to be
    // one component, as PCSX2 itself takes it.
    if (!safeMemberName(name) || name.includes("/")) {
      return { skip: `slot 1's card name ${JSON.stringify(name)} is not one file name` };
    }
    const root = path.join(options.saveRoot, name);
    const kind = await pcsx2CardKind(root);
    if (kind === "file") {
      return { skip: `slot 1's card ${name} is a file card, and only a folder card syncs` };
    }
    if (kind === "unformatted") {
      return { skip: `slot 1's card ${name} is a folder PCSX2 has not formatted` };
    }
    return {
      emulator: "pcsx2",
      root,
      exists: kind === "folder",
      unitOf: pcsx2UnitOf,
      restFrom: "local",
      layout: null,
    };
  }
  if (options.emulatorId === "dolphin" && slug === "ngc") {
    const ini = options.read(path.join(options.folder, "Config", "Dolphin.ini"));
    if (ini && iniValue(ini, "Core", "SlotA") === DOLPHIN_RAW_CARD) {
      return { skip: "slot A is a raw memory card, and only a GCI folder syncs" };
    }
    return {
      emulator: "dolphin",
      root: options.saveRoot,
      // Its saves are files of their own, so a GC folder that is not there yet
      // is simply one with none in it.
      exists: true,
      unitOf: dolphinUnitOf,
      restFrom: "server",
      layout: options.layout,
    };
  }
  return null;
}

/** A name under the card's root, as the card library names it. */
function toLibrary(card: LocalCard, local: string): string {
  return card.layout ? card.layout.toArchive(local) : local;
}

/** A name as the card library has it, as a path under the card's root. */
function toLocal(card: LocalCard, name: string): string {
  return join(card.root, card.layout ? card.layout.toLocal(name) : name);
}

/**
 * Read the card, or null when it cannot be read whole.
 *
 * Whole or not at all: a card missing a save merges as one where that save was
 * deleted, which is not the same thing.
 */
export async function readLocalCard(
  card: LocalCard,
): Promise<SplitCard | null> {
  if (!card.exists) return null;
  const tree = await listTree(card.root);
  if (!tree.complete || tree.skipped.length > 0) return null;
  const files: CardFile[] = [];
  for (const [path, entry] of tree.files) {
    const name = toLibrary(card, path);
    // Dolphin's GC folder holds more than saves, and none of the rest is the
    // card library's.
    if (card.restFrom === "server" && card.unitOf(name) === null) continue;
    const contents = await readFile(join(card.root, path)).catch(() => null);
    if (!contents) return null;
    files.push({ name, contents, modifiedAt: entry.modifiedAt });
  }
  return splitCard(files, card.unitOf);
}

/** Why this path is not one to write, or null when it is. */
async function unsafePath(root: string, destination: string): Promise<string | null> {
  if (!isWithin(root, destination)) return `${destination} is outside ${root}`;
  const parts = relative(root, destination).split(sep).filter(Boolean);
  let walked = root;
  for (const part of parts) {
    walked = join(walked, part);
    if ((await lstat(walked).catch(() => null))?.isSymbolicLink()) {
      return `${walked} is a link`;
    }
  }
  return null;
}

/**
 * Write the server's saves into the card, each replacing what is there, and
 * the card's own files for a card that did not exist here.
 *
 * Every destination is checked before any is written. A failure after that is
 * thrown, and the caller treats the card as unsynced this run.
 */
export async function writeToLocalCard(
  card: LocalCard,
  units: readonly CardUnit[],
  rest: readonly CardFile[],
): Promise<void> {
  const files = [...rest, ...units.flatMap((unit) => unit.files)];
  for (const file of files) {
    if (!safeMemberName(file.name)) {
      throw new Error(`${file.name} is not a safe name to write`);
    }
    const refusal = await unsafePath(card.root, toLocal(card, file.name));
    if (refusal) throw new Error(refusal);
  }
  // A PCSX2 save is a folder, replaced whole so a file the server's copy no
  // longer has does not linger in it. A Dolphin save is one file.
  if (card.emulator === "pcsx2") {
    for (const unit of units) {
      await rm(join(card.root, unit.key), { recursive: true, force: true });
    }
  }
  await mkdir(card.root, { recursive: true });
  for (const file of files) {
    const destination = toLocal(card, file.name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.contents);
  }
}
