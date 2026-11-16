// Memory cards, as the per-game save set meets them.
//
// PCSX2 and Dolphin keep GameCube and PS2 saves on a memory card, and a card
// holds many games at once. A per-game set only works where the card keeps
// each game apart on disk, which both emulators can do:
//
// - PCSX2's folder memory card is a directory, `Mcd001.ps2/`, holding one
//   folder per save named for the game (`BASLUS-20312AC04`), which is what
//   RomM's PS2 save target is a prefix of. Its default is a file card: one
//   8 MB image with every game inside, which nothing here can take apart.
// - Dolphin's slot A defaults to a GCI folder, one `.gci` per save. Set to a
//   memory card instead, it writes one raw image, which is the same problem.
//
// Two things follow. A restore may only write into a PCSX2 card that is
// already a formatted folder card: creating `Mcd001.ps2/` from nothing leaves
// a directory with no `_pcsx2_superblock`, which PCSX2 does not read as a
// card, and one where a file card sits fails on its first write. And a card
// that cannot sync per game is worth saying so in the log, since the only
// symptom is a game that never syncs.
//
// No Electron here, so all of it can be tested.

import { lstat } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { iniValue, type ReadText } from "./moved.ts";

/** What PCSX2 writes into a folder card when it formats one. */
export const PCSX2_SUPERBLOCK = "_pcsx2_superblock";

/** Dolphin's EXIDeviceType for a raw memory card image (EXI_Device.h). */
const DOLPHIN_RAW_CARD = "1";

/** The card a member of a PCSX2 set sits in: its first segment, when that is
 *  a card's name. */
export function pcsx2CardOf(member: string): string | null {
  const first = member.split("/")[0] ?? "";
  return /\.ps2$/i.test(first) ? first : null;
}

export type CardKind = "folder" | "unformatted" | "file" | "missing";

/** What sits at a PCSX2 card's path. */
export async function pcsx2CardKind(card: string): Promise<CardKind> {
  const info = await lstat(card).catch(() => null);
  if (!info) return "missing";
  if (!info.isDirectory()) return "file";
  return (await lstat(join(card, PCSX2_SUPERBLOCK)).catch(() => null))?.isFile()
    ? "folder"
    : "unformatted";
}

/**
 * Why a PCSX2 restore must not write these members, or null when it may.
 *
 * Every card the members name has to be a formatted folder card already.
 * Members outside a card are left to the restore's own checks.
 */
export async function pcsx2RestoreRefusal(
  saveRoot: string,
  members: readonly string[],
  kindOf: (card: string) => Promise<CardKind> = pcsx2CardKind,
): Promise<string | null> {
  const cards = new Set(
    members.map(pcsx2CardOf).filter((card): card is string => card !== null),
  );
  for (const card of [...cards].sort()) {
    const kind = await kindOf(join(saveRoot, card));
    if (kind === "folder") continue;
    return {
      missing: `${card} does not exist here, and a folder card PCSX2 has not formatted is not one it reads`,
      unformatted: `${card} is a folder PCSX2 has not formatted as a card`,
      file: `${card} is a file memory card, which holds every game in one image`,
    }[kind];
  }
  return null;
}

/**
 * A line for the log when this emulator's card cannot sync per game, or null.
 *
 * Read from the emulator's own settings, so it describes the card the run
 * will actually use.
 */
export async function memoryCardHint(options: {
  emulatorId: string;
  platformSlug: string;
  /** The emulator's user folder. */
  folder: string;
  /** Where its saves are, already resolved. */
  saveRoot: string;
  platform: NodeJS.Platform;
  read: ReadText;
  kindOf?: (card: string) => Promise<CardKind>;
}): Promise<string | null> {
  const path = options.platform === "win32" ? win32 : posix;
  switch (options.emulatorId) {
    case "pcsx2": {
      const ini = options.read(path.join(options.folder, "inis", "PCSX2.ini"));
      const card =
        (ini && iniValue(ini, "MemoryCards", "Slot1_Filename")) || "Mcd001.ps2";
      const kind = await (options.kindOf ?? pcsx2CardKind)(
        path.join(options.saveRoot, card),
      );
      return kind === "file"
        ? `PCSX2's slot 1 card ${card} is a file card, so PS2 saves do not sync per game. Converting it to a folder card in PCSX2's Memory Cards settings lets them.`
        : null;
    }
    case "dolphin": {
      if (options.platformSlug.toLowerCase() === "wii") return null;
      const ini = options.read(
        path.join(options.folder, "Config", "Dolphin.ini"),
      );
      return ini && iniValue(ini, "Core", "SlotA") === DOLPHIN_RAW_CARD
        ? "Dolphin's slot A is a raw memory card, so GameCube saves do not sync per game. Setting slot A to GCI Folder in Dolphin's GameCube settings lets them."
        : null;
    }
    default:
      return null;
  }
}
