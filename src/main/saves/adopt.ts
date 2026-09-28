// Bringing a save the player already has along to the first launch.
//
// Someone arriving from RetroDECK, EmuDeck or a RetroArch they have played for
// years has progress on this machine already, just not where the shell keeps
// it. The shell's save directory is keyed on the RomM rom id, so on a game's
// first launch it is empty, and without this the first thing the shell does
// with that game is boot it from nothing and then push the empty result to
// RomM as the save.
//
// Where those installations keep a game's save is not a path list: it moves
// with sorting options, override files and the core's own library name.
// emu-atlas reads all of that the way RetroArch does, so this asks it rather
// than guessing, and only copies. The other installation's file is never
// written, moved or deleted, and the copy lands only where the shell's own save
// does not exist yet.
//
// What happens next is the ordinary save sync. The adopted file is a local
// save like any other: a RomM that holds nothing takes it on the push, and a
// RomM that holds something is negotiated with exactly as a save written here
// would be, which archives rather than overwrites.
//
// Like everything a launch moves, none of this can fail it. A machine without
// emu-atlas, an installation that does not know the game, and a question that
// times out all end with nothing copied and the game starting as it would
// have.

import { copyFile, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  chooseAdoption,
  contentPathFor,
  isOwnSave,
  isSafeAtlasId,
  readInstallations,
  readRomDir,
  saveCandidates,
  type FoundSave,
} from "../atlas/answers.ts";
import { type AskAtlas } from "../atlas/cli.ts";
import { MAX_SAVE_BYTES } from "./plan.ts";

/** More installations than any machine plausibly holds of one kind each, and
 *  a bound on how many questions a first launch can wait on. */
const MAX_INSTALLATIONS = 4;

export interface AdoptOptions {
  ask: AskAtlas;
  romId: number;
  /** RomM's platform slug, which is IGDB's slug for most platforms and is
   *  asked of the crosswalk as one. */
  platformSlug: string;
  /** The core file this launch runs, e.g. mgba_libretro.so. */
  coreFile: string;
  /** The content the emulator is about to be handed. */
  romPath: string;
  /** The shell's own save file for this game, which must not exist yet. */
  saveFile: string;
  saveDataPath: string | null;
  signal: AbortSignal;
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

interface Candidate {
  kind: string;
  path: string;
}

async function asFound(candidate: Candidate): Promise<FoundSave | null> {
  const info = await stat(candidate.path).catch(() => null);
  if (!info?.isFile()) return null;
  return {
    path: candidate.path,
    size: info.size,
    modifiedAt: info.mtimeMs,
  };
}

/** Every file emu-atlas says could be this game's save, across every
 *  installation it found, before any of them has been looked at. */
async function gatherCandidates(options: AdoptOptions): Promise<Candidate[]> {
  const { ask, platformSlug, coreFile, romPath, signal } = options;

  const installations = readInstallations(
    await ask(["systems-for-platform", "igdb", platformSlug], signal),
  ).slice(0, MAX_INSTALLATIONS);

  const candidates: Candidate[] = [];
  for (const { kind, system } of installations) {
    if (signal.aborted) break;
    const only = `--installation=${kind}`;
    const romDir = system
      ? readRomDir(await ask(["rom-location", system, only], signal))
      : null;
    const content = contentPathFor(romPath, romDir);
    // Every value in the `--flag=value` form, so a path can never be read as
    // a flag of its own whatever it starts with.
    const answer = await ask(
      [
        "savefile-location",
        `--core=${coreFile}`,
        `--content=${content}`,
        ...(system ? [`--system=${system}`] : []),
        only,
      ],
      signal,
    );
    for (const path of saveCandidates(answer, content)) {
      candidates.push({ kind, path });
    }
  }
  return candidates;
}

/**
 * Copy the save another installation keeps for this game into the shell's own
 * save file, when there is one and the shell has none.
 *
 * Resolves to the path that was copied, or null when nothing was. Never
 * rejects: a cancel resolves null as well, and the caller's own signal check is
 * what turns it into a cancelled launch.
 */
export async function adoptLocalSave(
  options: AdoptOptions,
): Promise<string | null> {
  const { romId, platformSlug, saveFile, saveDataPath, signal } = options;
  // The slug came from the renderer and is about to become an argument.
  if (!isSafeAtlasId(platformSlug)) return null;
  const temp = join(dirname(saveFile), `.${basename(saveFile)}.adopt`);

  try {
    // Checked first and again just before the rename: the shell's own save is
    // never replaced by this, whatever happened in between.
    if (await exists(saveFile)) return null;

    const candidates = await gatherCandidates(options);
    if (signal.aborted) return null;

    const byPath = new Map<string, Candidate>();
    for (const candidate of candidates) {
      if (!isOwnSave(candidate.path, saveDataPath)) {
        byPath.set(candidate.path, candidate);
      }
    }
    const found = (
      await Promise.all([...byPath.values()].map((c) => asFound(c)))
    ).filter((save): save is FoundSave => save !== null);

    const chosen = chooseAdoption(found, MAX_SAVE_BYTES);
    if (!chosen) {
      console.info(
        `[atlas] rom ${romId}: no existing save found in ${
          new Set(candidates.map((c) => c.kind)).size
        } installation(s)`,
      );
      return null;
    }

    // Copied beside the target and renamed into place, so an interrupted copy
    // never leaves a half save under the name the emulator reads.
    await copyFile(chosen.path, temp);
    // The adopted bytes are as old as the file they came from. The negotiation
    // compares times when this device has no history with the server, and a
    // copy stamped "now" would beat a newer save RomM already holds.
    const when = new Date(chosen.modifiedAt);
    await utimes(temp, when, when);
    if (await exists(saveFile)) {
      await rm(temp, { force: true });
      return null;
    }
    await rename(temp, saveFile);

    const kind = byPath.get(chosen.path)?.kind ?? "an installation";
    const others = found.filter((save) => save.path !== chosen.path);
    console.info(
      `[atlas] rom ${romId}: brought along the save ${kind} keeps at ${chosen.path}` +
        (others.length > 0
          ? `, the most recent of ${found.length} (${others
              .map((save) => save.path)
              .join(", ")} left alone)`
          : ""),
    );
    return chosen.path;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (!signal.aborted) {
      console.warn(`[atlas] rom ${romId}: could not bring a save along`, error);
    }
    return null;
  }
}
