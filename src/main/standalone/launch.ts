// The standalone side of a launch: what moves, and what is only reported.
//
// Two kinds of launch, and the difference is whether RomM could read the
// game's id out of the ROM. With an id there is a save set (set.ts) and it
// syncs, down before the emulator starts and up after it exits (saves.ts).
// Without one nothing moves: the folder is listed either side of the run and
// the difference is logged, which is how the folder and target logic is
// checked against a real install. States are the second case either way for
// now; they are the next piece of work.
//
// The order is why this sits between the launcher and the two halves. The
// pull finishes before the emulator starts, the listing is taken after the
// pull so a file that came down is not read as one the run wrote, and the
// folder claim outlives both.
//
// Best effort throughout: nothing here can fail a launch, and the only thing
// that leaves is the launch's own cancel.

import { type Session } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type DesktopConfig,
  type SaveSyncOutcome,
} from "../../shared/types.ts";
import { apiRequest } from "../saves/http.ts";
import { saveBaseName } from "../saves/paths.ts";
import { completeSync } from "../saves/sync.ts";
import { claimFolder } from "./claims.ts";
import { standaloneData } from "./data.ts";
import { parseRomIdentity, type RomIdentity } from "./identity.ts";
import { describeAfter, describeBefore } from "./report.ts";
import { pullSet, pushSet, type SetPullResult } from "./saves.ts";
import { saveTargetOf, type SaveTarget } from "./set.ts";
import { listTree, type Tree } from "./tree.ts";

export interface StandaloneLaunch {
  /** Send what the run wrote, and say what it did, once the emulator has
   *  exited. */
  finish(): Promise<void>;
  /** Give the folder up without looking, for a launch that never ran. */
  release(): void;
}

/**
 * How long the launch waits to be told what this game is.
 *
 * This answer is worth waiting for, since it decides whether a save set comes
 * down, but it is not worth waiting indefinitely: a request with no deadline
 * of its own that a launch now blocks on is a server that hangs holding the
 * game shut. Past this the launch goes ahead with no identity, which is the
 * same launch a server without the ROM reader produces.
 */
const IDENTITY_TIMEOUT_MS = 10_000;

/** Ask RomM what it read out of this ROM, or nothing when it cannot say. */
async function fetchIdentity(options: {
  serverUrl: string;
  session: Session;
  romId: number;
  signal: AbortSignal;
}): Promise<RomIdentity | null> {
  // The launch's own cancel and this deadline both end the request, and only
  // the first is the launch's to hear about, which is why the caller is still
  // handed the launch signal to re-throw on.
  const deadline = AbortSignal.timeout(IDENTITY_TIMEOUT_MS);
  const response = await apiRequest({
    serverUrl: options.serverUrl,
    session: options.session,
    path: `/api/roms/${options.romId}`,
    method: "GET",
    signal: AbortSignal.any([options.signal, deadline]),
  }).catch(() => null);
  if (!response) {
    if (deadline.aborted && !options.signal.aborted) {
      console.info(
        `[standalone] rom ${options.romId}: RomM did not answer within ${IDENTITY_TIMEOUT_MS / 1000}s, so this launch syncs no save set`,
      );
    }
    return null;
  }
  if (response.status >= 300) return null;
  return parseRomIdentity(response.body);
}

export interface StandaloneOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  /** The ROM's file name, which the archive is named after. */
  fileName: string;
  platformSlug: string;
  emulatorId: string;
  command: string;
  args: readonly string[];
  signal: AbortSignal;
  /** Told what moved, so the renderer can say so rather than only the log. */
  onSync?: (outcome: SaveSyncOutcome) => void;
}

/**
 * Settle a standalone launch's saves and take the before-reading of its
 * folders.
 *
 * Awaited before the spawn, the identity request included: what it answers
 * decides whether a set comes down, and a set has to come down before the
 * emulator reads it. A server that does not answer costs the sync, not the
 * launch.
 */
export async function startStandaloneSaves(
  options: StandaloneOptions,
): Promise<StandaloneLaunch | null> {
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

  const claim = claimFolder(data.folder);
  if (!claim) {
    console.info(
      `[standalone] rom ${romId}: another launch is using ${data.folder}, so this one leaves it alone`,
    );
    return null;
  }

  // Released on anything thrown between here and the return, so a launch that
  // fails to reach the emulator does not hold the folder against the next one.
  try {
    const identity = await fetchIdentity({
      serverUrl: config.serverUrl,
      session: options.session,
      romId,
      signal: options.signal,
    }).catch(() => null);

    const saveRoot = join(data.folder, data.saveRoot);
    const stateRoot = data.stateRoot ? join(data.folder, data.stateRoot) : null;
    const target = config.syncSaves ? saveTargetOf(identity) : null;
    const base = saveBaseName(options.fileName);

    // Before the listing below, so a file that came down reads as one that was
    // already there rather than as one the run wrote.
    const pulled = target
      ? await pullSet({
          config,
          session: options.session,
          romId,
          emulatorId: options.emulatorId,
          saveRoot,
          target,
          base,
          signal: options.signal,
        })
      : null;
    if (pulled?.outcome) options.onSync?.(pulled.outcome);

    const savesBefore = await listTree(saveRoot);
    const statesBefore = stateRoot ? await listTree(stateRoot) : null;
    console.info(describeBefore(romId, data, savesBefore, identity));

    return {
      finish: () =>
        finish({
          ...options,
          saveRoot,
          stateRoot,
          target,
          base,
          pulled,
          identity,
          savesBefore,
          statesBefore,
          claim,
        }),
      release: () => claim.release(),
    };
  } catch (error) {
    claim.release();
    throw error;
  }
}

/** What the run wrote: sent when the set is this launch's to send, and said in
 *  the log either way. */
async function finish(
  context: StandaloneOptions & {
    saveRoot: string;
    stateRoot: string | null;
    target: SaveTarget | null;
    base: string;
    pulled: SetPullResult | null;
    identity: RomIdentity | null;
    savesBefore: Tree;
    statesBefore: Tree | null;
    claim: { readonly contested: boolean; release(): void };
  },
): Promise<void> {
  const { romId, saveRoot, stateRoot, claim } = context;

  // Read and released before anything is sent: an upload has no deadline, and
  // a server that never answers must not keep the folder claimed.
  let savesAfter, statesAfter, contested;
  try {
    savesAfter = await listTree(saveRoot);
    statesAfter = stateRoot ? await listTree(stateRoot) : null;
    contested = claim.contested;
  } finally {
    claim.release();
  }

  console.info(
    describeAfter(
      romId,
      "save",
      context.savesBefore,
      savesAfter,
      context.identity,
      contested,
    ),
  );
  if (context.statesBefore && statesAfter) {
    console.info(
      describeAfter(
        romId,
        "state",
        context.statesBefore,
        statesAfter,
        null,
        contested,
      ),
    );
  }

  // A contested folder does not stop the set being sent. The diff above
  // cannot tell two launches' writes apart; the target can, since it names one
  // game's files and the other launch is a different game.
  const { target, pulled } = context;
  if (!target || !pulled?.deviceId || pulled.sessionId === null) return;

  const outcome = await pushSet({
    config: context.config,
    session: context.session,
    romId,
    emulatorId: context.emulatorId,
    saveRoot,
    target,
    base: context.base,
    deviceId: pulled.deviceId,
    before: pulled.before,
    allowance: pulled.allowance,
    signal: context.signal,
  });
  if (outcome) context.onSync?.(outcome);

  // The session the negotiation opened. Last, and a failure is not worth
  // acting on: an unclosed session is a stale row, not a lost save.
  const moved = [pulled.outcome, outcome].filter(
    (entry): entry is SaveSyncOutcome => entry !== null && entry !== undefined,
  );
  if (context.config.serverUrl) {
    await completeSync({
      serverUrl: context.config.serverUrl,
      session: context.session,
      sessionId: pulled.sessionId,
      completed: moved.filter((entry) => entry.action !== "failed").length,
      failed: moved.filter((entry) => entry.action === "failed").length,
      signal: context.signal,
    });
  }
}
