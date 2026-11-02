// Which of a standalone emulator's save files belong to one game.
//
// A RetroArch save is one file in a directory of the game's own. A standalone
// emulator's are not: Dolphin keeps every Wii game's storage under one tree,
// RPCS3 every PS3 game's save folders under another, each named for the game's
// own id (GALE01, BLUS30001) rather than anything the shell was handed.
//
// RomM already reads that id out of the ROM when it scans it, along with the
// name the emulator gives the game's saves and how to apply it: a folder named
// exactly that, folders starting with it, files likewise, or a nested path.
// That is the `title_id`, `save_target` and `save_target_layout` on the ROM,
// and this is the part that turns them into a selection of files.
//
// The server's answer is matched at any depth under the emulator's save root
// rather than at its top: Dolphin files GameCube saves under a region and a
// card folder, and the id is several levels down. Matched without regard to
// case, since which case an emulator writes an id in varies, and two games'
// ids differing only by case do not exist.
//
// Nothing here turns a server value into a path. The target is only ever
// compared against names already found on disk, so a hostile one selects
// nothing rather than reaching somewhere else.

/** How RomM says to apply a save target, as its `SaveTargetLayout` spells it. */
export const SAVE_TARGET_LAYOUTS = [
  "folder-exact",
  "folder-prefix",
  "file-exact",
  "file-prefix",
  "folder-split",
] as const;

export type SaveTargetLayout = (typeof SAVE_TARGET_LAYOUTS)[number];

export interface RomIdentity {
  titleId: string | null;
  saveTarget: string | null;
  layout: SaveTargetLayout | null;
}

/** RomM's `TITLE_ID_MAX_LENGTH` is well under this; anything longer is not a
 *  value the server would have stored. */
const MAX_IDENTITY_LENGTH = 255;

function plainString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IDENTITY_LENGTH) return null;
  // Control characters are never part of an id, and NUL ends a path early.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/.test(trimmed) ? null : trimmed;
}

/** A target is one name, or for a split layout a short run of them. Never a
 *  path out of where it is matched, even though it is never used as one. */
function validTarget(target: string, layout: SaveTargetLayout): boolean {
  const parts = target.split("/");
  if (layout !== "folder-split" && parts.length !== 1) return false;
  return parts.every(
    (part) =>
      part !== "" && part !== "." && part !== ".." && !part.includes("\\"),
  );
}

/**
 * The identity a `/api/roms/{id}` body carries, with anything malformed read
 * as absent. A target without a layout it can be applied with is dropped too:
 * there is no telling a folder from a file prefix without one.
 */
export function parseRomIdentity(body: unknown): RomIdentity {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const titleId = plainString(record.title_id);
  const rawLayout = record.save_target_layout;
  const layout =
    SAVE_TARGET_LAYOUTS.find((known) => known === rawLayout) ?? null;
  const target = plainString(record.save_target);
  const usable =
    target !== null && layout !== null && validTarget(target, layout);
  return {
    titleId,
    saveTarget: usable ? target : null,
    layout: usable ? layout : null,
  };
}

/**
 * The files under a save root that this target names.
 *
 * `files` are paths relative to the root, "/"-separated, as a listing of it
 * produces them. A folder layout selects every file beneath a matching folder,
 * which is what a save set is: Dolphin's Wii `data/` and RPCS3's save folders
 * are several files that only mean anything together.
 */
export function selectSaveFiles(
  files: readonly string[],
  target: string,
  layout: SaveTargetLayout,
): string[] {
  const wanted = target.toLowerCase();
  const split = wanted.split("/");
  return files.filter((file) => {
    const parts = file.toLowerCase().split("/");
    const name = parts.at(-1) ?? "";
    const folders = parts.slice(0, -1);
    switch (layout) {
      case "folder-exact":
        return folders.includes(wanted);
      case "folder-prefix":
        return folders.some((folder) => folder.startsWith(wanted));
      case "file-exact":
        // A stem, so the extension the emulator adds does not stop the match.
        return name === wanted || name.startsWith(`${wanted}.`);
      case "file-prefix":
        return name.startsWith(wanted);
      case "folder-split":
        return folders.some((_, start) =>
          split.every((part, offset) => folders[start + offset] === part),
        );
    }
  });
}
