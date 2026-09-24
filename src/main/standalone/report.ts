// What a standalone launch's probe says in the log.
//
// Kept apart from the probe itself, which reaches Electron through the API
// request and so cannot be loaded by a test. These lines are what the folder
// and save target logic is checked against on real installs, so what they
// claim is worth pinning down.

import { join } from "node:path";
import { type StandaloneData } from "./data.ts";
import { selectSaveFiles, type RomIdentity } from "./identity.ts";
import { changedFiles, type Tree } from "./tree.ts";

/** How many changed paths a line names before it only counts them. */
const MAX_NAMED = 10;

export function describeTarget(identity: RomIdentity | null): string {
  if (!identity) return "RomM did not say what this game is";
  if (!identity.saveTarget || !identity.layout) {
    return identity.titleId
      ? `RomM knows it as ${identity.titleId} but names no save target`
      : "RomM has no id for this game";
  }
  return `RomM names ${identity.saveTarget} (${identity.layout})`;
}

function listed(paths: readonly string[]): string {
  const named = paths.slice(0, MAX_NAMED).join(", ");
  return paths.length > MAX_NAMED
    ? `${named} and ${paths.length - MAX_NAMED} more`
    : named;
}

function selectedCount(
  files: readonly string[],
  identity: RomIdentity | null,
): number | null {
  return identity?.saveTarget && identity.layout
    ? selectSaveFiles(files, identity.saveTarget, identity.layout).length
    : null;
}

/** The line logged as the emulator starts. */
export function describeBefore(
  romId: number,
  data: StandaloneData,
  saves: Tree,
  identity: RomIdentity | null,
): string {
  const where = `${data.emulatorId} keeps saves in ${join(data.folder, data.saveRoot)} (${data.source}${data.exists ? "" : ", not there yet"})`;
  const selected = selectedCount([...saves.files.keys()], identity);
  const count =
    selected === null
      ? ""
      : `, which selects ${selected} of ${saves.files.size}${saves.complete ? "" : " listed"} files there`;
  return `[standalone] rom ${romId}: ${where}; ${describeTarget(identity)}${count}`;
}

/** The line logged once the emulator has exited, for its saves or states. */
export function describeAfter(
  romId: number,
  kind: "save" | "state",
  before: Tree,
  after: Tree,
  identity: RomIdentity | null,
): string {
  const changed = changedFiles(before, after);
  if (changed === null) {
    return `[standalone] rom ${romId}: the ${kind} folder could not be read whole, so what the run wrote there is not known`;
  }
  if (changed.length === 0) {
    return `[standalone] rom ${romId}: the run wrote no ${kind} files`;
  }
  const selected = selectedCount(changed, identity);
  const target =
    selected === null ? "" : `; RomM's target selects ${selected} of them`;
  return `[standalone] rom ${romId}: the run wrote ${changed.length} ${kind} files: ${listed(changed)}${target}`;
}
