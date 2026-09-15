// Where the firmware RomM already holds ends up on this machine.
//
// RomM has a firmware library of its own: BIOS files uploaded per platform and
// served from /api/firmware. Nothing on this side used it, so someone whose
// scph5501.bin was already sitting in RomM still had to copy it into
// RetroArch's system directory by hand, and then again on the next machine.
//
// Handled the same way as a ROM, deliberately: fetched from the same server
// over the same session, cached under a directory the shell owns, skipped when
// what is on disk already matches what the server reports, and written to a
// .part file that is renamed on success so an interrupted transfer never looks
// finished. Two things differ, and both follow from what firmware is for.
//
// A ROM is cached per id because only the shell has to find it. Firmware is
// cached per platform because the *emulator* has to find it, by the name it
// expects: a core looking for scph5501.bin in its system directory will not
// take <id>/scph5501.bin. So the layout is one directory per platform, holding
// the server's own filenames.
//
// And a ROM cache is evicted when it grows. Firmware is not: these are a few
// megabytes that a launch depends on, and evicting one would break the game it
// belongs to. The directory is kept as a mirror of the server's list instead,
// so removing a file in RomM removes it here too.
//
// Kept free of Electron and filesystem imports, so the layout and the generated
// config can be checked directly; the fetching lives in sync.ts.

import { join } from "node:path";
import { safeFileName } from "../safety.ts";

/** Where a platform's firmware lives while the shell owns it. */
export interface BiosPaths {
  /** The directory itself, which is what "{bios}" expands to. */
  directory: string;
  /**
   * A generated RetroArch config, which is what "{biosconfig}" expands to.
   *
   * Written rather than edited into the user's own retroarch.cfg:
   * --appendconfig layers on top for one run and leaves their settings alone,
   * so switching the mirror off switches this off completely.
   *
   * It exists whenever the mirror is on, and sets system_directory only when
   * there is firmware to point at -- with nothing but comments in it otherwise.
   * That is what makes it safe to name unconditionally: a row that always
   * passes --appendconfig is passing a file that changes no settings on a
   * platform with no firmware, rather than one that overrides the user's own
   * system_directory with an empty directory.
   */
  appendConfig: string;
}

/**
 * The directory holding the generated RetroArch configs.
 *
 * Leading dot on purpose: a platform's own directory is named with
 * safeFileName, which strips leading dots, so no slug can ever resolve to this
 * name and collide with it.
 */
const GENERATED_DIRECTORY = ".retroarch";

/**
 * Work out where a platform's firmware belongs, or null when the user has
 * switched the mirror off.
 *
 * Pure, and derived from nothing but the config and the slug, so the launch and
 * the platform-support probe compute the same answer without either touching
 * the network. That is what lets "{bios}" resolve for a probe that has not
 * synced anything.
 */
export function resolveBiosPaths(
  biosPath: string | null,
  platformSlug: string,
): BiosPaths | null {
  if (!biosPath) return null;
  // The slug reaches here from the renderer and becomes a directory name.
  const slug = safeFileName(platformSlug.toLowerCase());
  return {
    directory: join(biosPath, slug),
    appendConfig: join(biosPath, GENERATED_DIRECTORY, `${slug}.cfg`),
  };
}

/** The header every generated config carries, so anyone who opens one knows
 *  where it came from and that editing it is pointless. */
const GENERATED_HEADER = [
  "# Written by RomM Desktop, and regenerated on every launch that syncs",
  "# firmware. Layered over your own settings with --appendconfig, so",
  "# nothing here changes your retroarch.cfg. Editing it is pointless.",
];

/**
 * The config that tells RetroArch where this platform's firmware is.
 *
 * A null directory means there is no firmware for this platform, and the answer
 * is a file of comments -- not the absence of a file. An appended config that
 * sets nothing changes nothing, which is exactly what is wanted: a row that
 * names this file unconditionally keeps working on a platform with no firmware,
 * and RetroArch's own system_directory is left alone rather than overridden
 * with an empty directory.
 *
 * Returns null for a directory that cannot be expressed in RetroArch's config
 * format. Its values are double-quoted with no escape for a quote inside one,
 * so a path containing one would end the value early and leave the rest of the
 * line to be read as something else. Nothing is lost by declining: "{bios}"
 * still has the directory and only the RetroArch shortcut is skipped.
 */
export function retroarchSystemConfig(directory: string | null): string | null {
  if (directory === null) {
    return [
      ...GENERATED_HEADER,
      "# This platform has no firmware in RomM, so this file sets nothing.",
      "",
    ].join("\n");
  }
  if (/["\r\n]/.test(directory)) return null;
  return [...GENERATED_HEADER, `system_directory = "${directory}"`, ""].join(
    "\n",
  );
}
