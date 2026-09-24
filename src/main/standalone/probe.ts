// A standalone emulator's saves, looked at around a launch and not yet moved.
//
// Moving a save set means knowing three things at once: the emulator's user
// folder on this machine, which files in it are this game's, and whether the
// id RomM read out of the ROM names those files the way the emulator does.
// Each has been worked out from documentation and defaults rather than from a
// real install, so before anything is written into an emulator's folder this
// says, in the log, what each one came to: where the saves are, what RomM's
// save target selects there, and which files the run actually wrote. A launch
// whose target selects nothing, or selects files the run never touched, is
// the case to look at. What the lines say is decided in report.ts.
//
// Reads only, like the rest of launch sync, nothing here can fail a launch.

import { type Session } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { apiRequest } from "../saves/http.ts";
import { claimFolder } from "./claims.ts";
import { standaloneData } from "./data.ts";
import { parseRomIdentity, type RomIdentity } from "./identity.ts";
import { describeAfter, describeBefore } from "./report.ts";
import { listTree } from "./tree.ts";

export interface StandaloneProbe {
  /** Look again once the emulator has exited, and say what the run wrote. */
  finish(): Promise<void>;
  /** Give the folder up without looking, for a launch that never ran. */
  release(): void;
}

/** Ask RomM what it read out of this ROM, or nothing when it cannot say. */
async function fetchIdentity(options: {
  serverUrl: string;
  session: Session;
  romId: number;
  signal: AbortSignal;
}): Promise<RomIdentity | null> {
  const response = await apiRequest({
    serverUrl: options.serverUrl,
    session: options.session,
    path: `/api/roms/${options.romId}`,
    method: "GET",
    signal: options.signal,
  }).catch(() => null);
  if (!response || response.status >= 300) return null;
  return parseRomIdentity(response.body);
}

/**
 * Take the before-reading of a standalone launch's save and state folders.
 *
 * Awaited before the spawn, since a listing taken after the emulator started
 * could already include what it wrote. The identity request is not waited on:
 * it only colours the log, and a slow server should not hold a game back.
 */
export async function startStandaloneProbe(options: {
  config: DesktopConfig;
  session: Session;
  romId: number;
  platformSlug: string;
  emulatorId: string;
  command: string;
  args: readonly string[];
  signal: AbortSignal;
}): Promise<StandaloneProbe | null> {
  const { config, romId } = options;
  if (!config.serverUrl || (!config.syncSaves && !config.syncStates)) {
    return null;
  }
  const data = standaloneData({
    emulatorId: options.emulatorId,
    platformSlug: options.platformSlug,
    command: options.command,
    args: options.args,
    configured: config.standaloneDataPaths,
    home: homedir(),
  });
  if (!data) return null;

  const release = claimFolder(data.folder);
  if (!release) {
    console.info(
      `[standalone] rom ${romId}: another launch is using ${data.folder}, so this one leaves it alone`,
    );
    return null;
  }

  const identity = fetchIdentity({
    serverUrl: config.serverUrl,
    session: options.session,
    romId,
    signal: options.signal,
  });
  const saveRoot = join(data.folder, data.saveRoot);
  const stateRoot = data.stateRoot ? join(data.folder, data.stateRoot) : null;
  const savesBefore = await listTree(saveRoot);
  const statesBefore = stateRoot ? await listTree(stateRoot) : null;

  void identity.then((known) =>
    console.info(describeBefore(romId, data, savesBefore, known)),
  );

  return {
    async finish() {
      try {
        const known = await identity;
        const savesAfter = await listTree(saveRoot);
        const statesAfter = stateRoot ? await listTree(stateRoot) : null;
        console.info(
          describeAfter(romId, "save", savesBefore, savesAfter, known),
        );
        if (statesBefore && statesAfter) {
          console.info(
            describeAfter(romId, "state", statesBefore, statesAfter, null),
          );
        }
      } finally {
        release();
      }
    },
    release,
  };
}
