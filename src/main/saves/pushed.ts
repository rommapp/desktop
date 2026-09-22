// What this machine's own pushes left in RomM, written down beside the slots.
//
// The mirror's two halves have to agree on which rows are this machine's own,
// and neither clock can say: the push runs after the exit that wrote the state,
// so RomM's stamp is always the later of the two. The answer is recorded at the
// push and read back at the next pull.
//
// Free of Electron imports: the directory comes from the caller, so the round
// trip can be tested against a temporary one.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PUSHED_FILE, readPushedRows, type PushedRow } from "./states.ts";

/** Where a half-written record sits until it is complete. Dotted and `.part`,
 *  the shape the pull sweeps, so one left by a write that died does not stay. */
const TEMP_NAME = `.${PUSHED_FILE}.part`;

/** The rows this ROM's directory has recorded, or none when it has none. */
export async function readPushedFile(
  directory: string,
): Promise<Record<string, PushedRow>> {
  try {
    const raw = await readFile(join(directory, PUSHED_FILE), "utf8");
    return readPushedRows(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Record the rows this run left, so the next pull does not fetch them back.
 *
 *  Read and rewritten whole, through a temporary name: a record written half
 *  way reads as one with rows missing. */
export async function rememberPushedRows(
  directory: string,
  landed: Record<string, PushedRow>,
): Promise<void> {
  const temp = join(directory, TEMP_NAME);
  try {
    const known = await readPushedFile(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(temp, JSON.stringify({ ...known, ...landed }));
    await rename(temp, join(directory, PUSHED_FILE));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    console.warn(
      `[states] could not record what this run pushed, ${String(error)}`,
    );
  }
}
