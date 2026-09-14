// Offering to fetch a standalone emulator at the moment someone needs it.
//
// RetroAchievements recognises no libretro core for PS2 or GameCube/Wii, so
// those two platforms need PCSX2 or Dolphin themselves. Detection finds one
// already installed; this covers the case where there is nothing to find, at
// the only moment the user has shown they care -- pressing Play on a game of
// that platform.
//
// Nothing is extracted. The file is handed to the operating system exactly as
// the RetroArch offer does: an installer runs, a disk image mounts, a Flatpak
// goes to the Flatpak installer, and an archive opens in Explorer or Archive
// Utility. The last of those leaves a portable build wherever the user puts it,
// which detection cannot guess, so it says so rather than pretending otherwise.

import { type BrowserWindow, app, dialog, net, shell } from "electron";
import { join } from "node:path";
import { LaunchError } from "../../shared/types.ts";
import { downloadToFile } from "../download.ts";
import { createProgressGate } from "../progress.ts";
import { type OriginPolicy, isAllowedDownloadOrigin } from "../safety.ts";
import {
  RELEASE_SOURCES,
  type ReleaseArtifact,
  installsWhereDetectionLooks,
  unwrapRelease,
} from "./standalone-release.ts";

/** Dolphin's macOS image is the largest of these at a few hundred megabytes. */
const MAX_EMULATOR_BYTES = 1024 * 1024 * 1024;

/** Kept beside the config, one at a time, like the RetroArch installer. */
function downloadDirectory(id: string): string {
  return join(app.getPath("userData"), "installers", id);
}

async function fetchIndex(
  url: string,
  policy: OriginPolicy,
  signal: AbortSignal,
): Promise<unknown> {
  if (!isAllowedDownloadOrigin(url, policy)) return null;
  const response = await net.fetch(url, { signal });
  if (!isAllowedDownloadOrigin(response.url || url, policy)) return null;
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    // A release index that is not JSON is one we cannot read; the caller falls
    // back to the download page rather than guessing a URL.
    return null;
  }
}

function ask(
  parent: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

/** What the user will have to do once the file opens. */
function whatHappensNext(artifact: ReleaseArtifact, label: string): string {
  switch (artifact.kind) {
    case "installer":
      return `${label}'s own installer will open. Run it, then press Play again.`;
    case "disk-image":
      return `The disk image will open. Drag ${label} to your Applications folder, then press Play again.`;
    case "flatpak":
      return `The Flatpak will open in your software installer. Install it, then press Play again.`;
    default:
      // The one case that does not end with the emulator somewhere findable.
      return `${label} publishes only a portable archive for this system, so it will open in your file manager. Extract it, then point at the executable under "emulators" in the settings.`;
  }
}

export interface InstallOffer {
  /** True when something was downloaded and handed over, so the caller should
   *  stop rather than carry on with a launch that cannot work yet. */
  handedOff: boolean;
}

/**
 * Ask whether to fetch a standalone emulator, and hand it over if so.
 *
 * Declining is free: the caller carries on with whatever it would have done,
 * so this never turns a launch that would have worked into one that does not.
 */
export async function offerStandaloneInstall({
  emulatorId,
  parent,
  signal,
}: {
  emulatorId: string;
  parent: BrowserWindow | null;
  signal: AbortSignal;
}): Promise<InstallOffer> {
  const source = RELEASE_SOURCES[emulatorId];
  if (!source) return { handedOff: false };

  const index = await fetchIndex(source.indexUrl, source.indexPolicy, signal);
  const artifact = index ? source.pick(unwrapRelease(source.id, index)) : null;

  const { response } = await ask(parent, {
    type: "question",
    buttons: artifact
      ? ["Not now", `Download ${source.label}`]
      : ["Not now", "Open download page"],
    defaultId: 1,
    cancelId: 0,
    title: `${source.label} is not installed`,
    message: `This game needs ${source.label}, which RomM Desktop could not find on this machine.`,
    detail: artifact
      ? `${source.label} ${artifact.version} can be downloaded from the project directly. ${whatHappensNext(artifact, source.label)}\n\nAlready have it somewhere unusual? Point at it under "emulators" in the settings instead.`
      : `Nothing could be fetched automatically for this system. The download page has the options.\n\nAlready have it somewhere unusual? Point at it under "emulators" in the settings instead.`,
  });

  if (response !== 1) return { handedOff: false };
  if (!artifact) {
    void shell.openExternal(source.downloadPage);
    return { handedOff: true };
  }

  try {
    const shouldReport = createProgressGate();
    const file = await downloadToFile({
      url: artifact.url,
      fileName: artifact.fileName,
      directory: downloadDirectory(source.id),
      policy: source.artifactPolicy,
      maxBytes: MAX_EMULATOR_BYTES,
      signal,
      onProgress: (received, total) => {
        if (!total) return;
        const fraction = received / total;
        if (!shouldReport(fraction)) return;
        parent?.setProgressBar(fraction);
      },
    });
    parent?.setProgressBar(-1);

    const failure = await shell.openPath(file);
    // An archive has no handler on Windows 10, and revealing it is a better
    // answer than silence. Worth doing for the portable case anyway, since the
    // user has to go and find what it unpacked.
    if (failure || !installsWhereDetectionLooks(artifact.kind)) {
      shell.showItemInFolder(file);
    }
    return { handedOff: true };
  } catch (error) {
    parent?.setProgressBar(-1);
    if (signal.aborted) return { handedOff: true };
    const { response: choice } = await ask(parent, {
      type: "error",
      buttons: ["Close", "Open download page"],
      defaultId: 1,
      cancelId: 0,
      title: `Could not download ${source.label}`,
      message: `${source.label} could not be downloaded.`,
      detail: `${error instanceof LaunchError || error instanceof Error ? error.message : String(error)}\n\nYou can install it yourself and RomM Desktop will find it.`,
    });
    if (choice === 1) void shell.openExternal(source.downloadPage);
    return { handedOff: true };
  }
}
