// Moving a memory card between this machine and RomM's card library.
//
// RomM keeps PS2 and GameCube saves as whole cards per user and emulator,
// which is what its own streaming lays down and stores back. This keeps the
// card on this machine in step with the same library, so progress made in
// either place reaches the other. The card used is the one streaming would
// use: the user's most recently synced card for the emulator, created on the
// first upload when there is none.
//
// What is merged, and why it is safe to, is merge.ts; what is read and written
// on disk is local.ts. This is the IO between them, and it holds the line the
// rest of the shell holds: nothing here fails a launch. An unreachable server,
// a missing scope, a card that will not read and a malformed answer all end
// the same way, nothing moves and the log says why. Only the user's own cancel
// is re-thrown.
//
// Order matters where a step can lose something. This machine's card goes up
// as a version of its own before any of its unsynced saves is replaced, the
// agreement is recorded only once both sides hold the merged card, and a run
// that fails part way records nothing, so the next one settles it again.

import { type Session } from "electron";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { resolveDownloadUrl } from "../safety.ts";
import { apiRequest } from "../saves/http.ts";
import { multipartBody } from "../saves/multipart.ts";
import { readZipFiles, writeZip } from "../zip.ts";
import { readLocalCard, writeToLocalCard, type LocalCard } from "./local.ts";
import {
  baseWithoutPulls,
  planCardMerge,
  splitCard,
  type CardFile,
  type SplitCard,
} from "./merge.ts";
import { cardStatePath, readCardBase, writeCardBase } from "./state.ts";

/** RomM's own ceiling on a card (`MEMORY_CARD_MAX_BYTES`). */
const MAX_CARD_BYTES = 256 * 1024 * 1024;
/** Far past any real card: a PCSX2 folder card holds a few hundred files. */
const MAX_CARD_ENTRIES = 20_000;

interface Context {
  serverUrl: string;
  session: Session;
  signal: AbortSignal;
}

function isCancel(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** The user's card for this emulator, the one streaming would mount, or null
 *  when there is none. Undefined when the library could not be asked. */
async function findCard(
  context: Context,
  emulator: string,
): Promise<number | null | undefined> {
  const response = await apiRequest({
    ...context,
    path: `/api/memory-cards?emulator=${encodeURIComponent(emulator)}`,
    method: "GET",
  });
  if (!response || response.status !== 200 || !Array.isArray(response.body)) {
    return undefined;
  }
  // Newest-synced first, as the server orders them.
  for (const card of response.body as unknown[]) {
    const record = card as Record<string, unknown> | null;
    if (
      record &&
      typeof record.id === "number" &&
      Number.isInteger(record.id) &&
      record.emulator === emulator
    ) {
      return record.id;
    }
  }
  return null;
}

/** The card's newest version, split, or null when it has none yet. Undefined
 *  when it could not be fetched or read. */
async function fetchServerCard(
  context: Context,
  cardId: number,
  local: LocalCard,
): Promise<SplitCard | null | undefined> {
  const versions = await apiRequest({
    ...context,
    path: `/api/memory-cards/${cardId}/versions`,
    method: "GET",
  });
  if (!versions || versions.status !== 200 || !Array.isArray(versions.body)) {
    return undefined;
  }
  if (versions.body.length === 0) return null;

  const scratch = await mkdtemp(join(tmpdir(), "romm-card-")).catch(() => null);
  if (!scratch) return undefined;
  try {
    const destination = join(scratch, "card.zip");
    await downloadFromServer({
      url: resolveDownloadUrl(context.serverUrl, `/api/memory-cards/${cardId}/content`),
      session: context.session,
      destination,
      signal: context.signal,
      maxBytes: MAX_CARD_BYTES,
      onProgress: () => {},
    });
    const files: CardFile[] = readZipFiles(await readFile(destination), {
      maxEntries: MAX_CARD_ENTRIES,
      maxTotalBytes: MAX_CARD_BYTES,
    });
    return splitCard(files, local.unitOf);
  } catch (error) {
    if (isCancel(context.signal)) throw error;
    console.warn(`[cards] card ${cardId} could not be fetched or read:`, error);
    return undefined;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function createCard(
  context: Context,
  emulator: string,
): Promise<number | null> {
  const response = await apiRequest({
    ...context,
    path: "/api/memory-cards",
    method: "POST",
    headers: { "content-type": "application/json" },
    // The name the server's own import gives a card it creates.
    body: JSON.stringify({
      name: `${emulator} memory card`,
      emulator,
      platform_id: null,
      is_public: false,
    }),
  });
  const id = (response?.body as Record<string, unknown> | null)?.id;
  return response && response.status < 300 && typeof id === "number" ? id : null;
}

async function uploadVersion(
  context: Context,
  cardId: number,
  files: readonly CardFile[],
): Promise<boolean> {
  const body = multipartBody([
    { field: "cardFile", fileName: "card.zip", bytes: writeZip(files) },
  ]);
  const response = await apiRequest({
    ...context,
    path: `/api/memory-cards/${cardId}/versions`,
    method: "POST",
    body: body.body,
    headers: { "content-type": body.contentType },
  });
  return !!response && response.status >= 200 && response.status < 300;
}

export interface CardSyncOptions {
  config: DesktopConfig;
  session: Session;
  romId: number;
  card: LocalCard;
  /** Write what the server won into the card here. False after the game has
   *  exited, when the folder is no longer this launch's to write. */
  writeLocal: boolean;
  /** The card as read already, for a sync that read it while the folder was
   *  still claimed. Read here when absent. */
  local?: SplitCard | null;
  signal: AbortSignal;
}

/**
 * Bring this machine's card and the library's into step. Never throws but for
 * a cancel; returns whether the card is in step afterwards, for the log.
 */
export async function syncMemoryCard(options: CardSyncOptions): Promise<boolean> {
  const { config, romId, card, signal } = options;
  const serverUrl = config.serverUrl;
  if (!serverUrl || !config.saveDataPath) return false;
  const context: Context = { serverUrl, session: options.session, signal };
  const log = (message: string) =>
    console.info(`[cards] rom ${romId}: ${card.emulator} card: ${message}`);

  try {
    const local =
      options.local !== undefined ? options.local : await readLocalCard(card);
    if (card.exists && local === null) {
      log(`${card.root} could not be read whole, so nothing is synced`);
      return false;
    }

    const found = await findCard(context, card.emulator);
    if (found === undefined) {
      log("the card library could not be reached, so nothing is synced");
      return false;
    }
    const server = found === null ? null : await fetchServerCard(context, found, card);
    if (server === undefined) {
      log("the library's card could not be read, so nothing is synced");
      return false;
    }

    const statePath = cardStatePath(config.saveDataPath, serverUrl, card.emulator);
    const base = found === null ? {} : await readCardBase(statePath, found);
    const plan = planCardMerge({ base, local, server, restFrom: card.restFrom });
    for (const conflict of plan.conflicts) {
      log(`${conflict.key} changed on both sides; kept ${conflict.kept === "local" ? "this machine's" : "the server's"}, the newer`);
    }

    let cardId = found;
    if (plan.archiveFirst && cardId !== null) {
      if (!(await uploadVersion(context, cardId, plan.archiveFirst))) {
        log("this machine's card could not be filed before replacing part of it, so nothing is synced");
        return false;
      }
      log("filed this machine's card as a version before replacing part of it");
    }

    if (options.writeLocal && (plan.pull.length > 0 || plan.pullRest.length > 0)) {
      try {
        await writeToLocalCard(card, plan.pull, plan.pullRest);
      } catch (error) {
        log(`the server's saves could not be written here, so this run records nothing: ${String(error)}`);
        return false;
      }
      log(`brought down ${plan.pull.length} saves: ${plan.pull.map((u) => u.key).join(", ")}`);
    }

    if (plan.upload) {
      if (cardId === null) cardId = await createCard(context, card.emulator);
      if (cardId === null || !(await uploadVersion(context, cardId, plan.upload))) {
        log("the merged card could not be sent; the next launch tries again");
        return false;
      }
      log(`sent the merged card (${plan.upload.length} files)`);
    }

    if (cardId !== null) {
      await writeCardBase(
        statePath,
        cardId,
        options.writeLocal ? plan.base : baseWithoutPulls(plan, local),
      );
    }
    return true;
  } catch (error) {
    if (isCancel(signal)) throw error;
    log(`skipped: ${String(error)}`);
    return false;
  }
}
