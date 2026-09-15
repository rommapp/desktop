// Offering to fetch a standalone emulator at the moment someone needs it.
//
// RetroAchievements recognises no libretro core for PS2 or GameCube/Wii, and
// libretro has no core at all for PS3 or Wii U, so those platforms need PCSX2,
// Dolphin, RPCS3 or Cemu themselves. Detection finds one already installed;
// this covers the case where there is nothing to find, at the only moment the
// user has shown they care -- pressing Play on a game of that platform.
//
// Nothing is extracted. The file is handed to the operating system exactly as
// the RetroArch offer does: an installer runs, a disk image mounts, a Flatpak
// goes to the Flatpak installer, and an archive opens in Explorer or Archive
// Utility. The last of those leaves a portable build wherever the user puts it,
// which detection cannot guess, so it says so rather than pretending otherwise.
//
// An AppImage is the one thing not handed over at all. It is the emulator
// itself, so opening it would mean this shell running a binary it has just
// downloaded -- the one thing every other kind here avoids by letting the OS
// ask. It is made executable, revealed in the file manager, and left for the
// user to start.

import { type BrowserWindow, app, dialog, net, shell } from "electron";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { LaunchError } from "../../shared/types.ts";
import { downloadToFile } from "../download.ts";
import { createProgressGate } from "../progress.ts";
import { type OriginPolicy, isAllowedDownloadOrigin } from "../safety.ts";
import {
  clearTaskbarProgress,
  showTaskbarProgress,
} from "../window-progress.ts";
import {
  RELEASE_SOURCES,
  type ReleaseArtifact,
  type ReleaseSource,
  installsWhereDetectionLooks,
  mayAppearWhereDetectionLooks,
  unwrapRelease,
} from "./standalone-release.ts";

/** Dolphin's macOS image is the largest of these at a few hundred megabytes. */
const MAX_EMULATOR_BYTES = 1024 * 1024 * 1024;

/**
 * Kept beside the config, one at a time, like the RetroArch installer.
 *
 * One directory per emulator, and never the shared `installers` root itself:
 * each download empties its own directory, and the RetroArch offer cleans up
 * its own, so neither can take the other's file with it.
 */
function downloadDirectory(id: string): string {
  return join(app.getPath("userData"), "installers", id);
}

/**
 * Read a release index, or nothing when it cannot be read.
 *
 * Offline, DNS, TLS and a body that is not JSON all land here alike: none of
 * them is a reason to fail the launch, because the offer still has the download
 * page to fall back to. Cancellation is the exception -- that is the user
 * having changed their mind, and it has to reach the caller as one.
 */
async function fetchIndex(
  url: string,
  policy: OriginPolicy,
  signal: AbortSignal,
): Promise<unknown> {
  if (!isAllowedDownloadOrigin(url, policy)) return null;
  try {
    const response = await net.fetch(url, { signal });
    if (!isAllowedDownloadOrigin(response.url || url, policy)) return null;
    if (!response.ok) return null;
    return await response.json();
  } catch {
    if (signal.aborted) throw cancelled();
    return null;
  }
}

/** The launch's own cancellation error, so a cancel reads as one rather than
 *  as whatever Electron threw when the socket went away. */
function cancelled(): LaunchError {
  return new LaunchError("download-failed", "Launch cancelled");
}

function ask(
  parent: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

/**
 * What the user will have to do once the file opens.
 *
 * An installer, a disk image and a Flatpak all end with the emulator where
 * detection looks, so the launch waits and starts the game itself -- saying so
 * is the difference between a hand-off that feels finished and one that reads
 * as a chore. An AppImage and a portable archive cannot promise that, and say
 * what they do need instead.
 */
function whatHappensNext(
  artifact: ReleaseArtifact,
  label: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // A macOS archive holds a .app, so it ends the way a disk image does: drag it
  // to Applications and the launch finds it there.
  if (artifact.kind === "archive" && platform === "darwin") {
    return `The archive will open in Finder. Drag ${label} into your Applications folder and your game starts by itself.`;
  }
  switch (artifact.kind) {
    case "installer":
      return `${label}'s own installer will open. Run it and your game starts by itself.`;
    case "disk-image":
      return `The disk image will open. Drag ${label} into your Applications folder and your game starts by itself.`;
    case "flatpak":
      return `The Flatpak will open in your software installer. Install it and your game starts by itself.`;
    case "appimage":
      // Not an installer and not an archive: one executable file, which is the
      // emulator. There is nothing to extract and nothing to open.
      return `${label} publishes an AppImage for this system, which is the emulator itself rather than an installer. It will be made executable and shown in your file manager; point at it under "emulators" in the settings.`;
    default:
      // The one case that does not end with the emulator somewhere findable.
      return `${label} publishes only a portable archive for this system, so it will open in your file manager. Extract it, then point at the executable under "emulators" in the settings.`;
  }
}

export interface InstallOffer {
  /** True when something was downloaded and handed over, so the caller should
   *  stop rather than carry on with a launch that cannot work yet. */
  handedOff: boolean;
  /** True when the emulator may still turn up where detection looks once the
   *  user is done, so waiting for it is worth doing. False only for a portable
   *  archive or an AppImage, which are a file the user keeps wherever they
   *  like. */
  mayAppear: boolean;
}

const DECLINED: InstallOffer = { handedOff: false, mayAppear: false };

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
  onProgress,
}: {
  emulatorId: string;
  parent: BrowserWindow | null;
  signal: AbortSignal;
  /** Reported alongside the taskbar indicator, so the page that asked for the
   *  game can show the wait rather than appearing to have ignored the click. */
  onProgress?: (received: number, total: number | null) => void;
}): Promise<InstallOffer> {
  const source = RELEASE_SOURCES[emulatorId];
  if (!source) return DECLINED;
  return runOffer(source, parent, signal, onProgress);
}

async function runOffer(
  source: ReleaseSource,
  parent: BrowserWindow | null,
  signal: AbortSignal,
  onProgress?: (received: number, total: number | null) => void,
): Promise<InstallOffer> {
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
      : `Nothing could be fetched automatically for this system. The download page has the options; install it from there and your game starts by itself.\n\nAlready have it somewhere unusual? Point at it under "emulators" in the settings instead.`,
  });

  if (response !== 1) return DECLINED;
  if (!artifact) {
    // Awaited, because the wait that follows is only justified by the page
    // having actually opened. A browser that refuses to start would otherwise
    // leave the launch polling for half an hour behind nothing at all, so a
    // failure here is no hand-off: the launch carries on and fails the way it
    // would have without the offer.
    try {
      await shell.openExternal(source.downloadPage);
    } catch {
      return DECLINED;
    }
    // Nothing was fetched, but the user is off to install it by whatever means
    // that page offers -- a package manager, the project's own installer --
    // and both of those land where detection looks. So this waits like any
    // other hand-off rather than failing the launch in front of someone who is
    // in the middle of doing exactly what was asked of them.
    return { handedOff: true, mayAppear: true };
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
        const fraction = total ? received / total : undefined;
        if (!shouldReport(fraction)) return;
        onProgress?.(received, total);
        if (fraction !== undefined) showTaskbarProgress(parent, fraction);
      },
    });
    clearTaskbarProgress(parent);
    // The last stretch of downloadToFile -- closing the file and renaming it --
    // does not watch the signal, so a cancel landing in it would otherwise be
    // answered by opening the installer anyway.
    if (signal.aborted) throw cancelled();

    // An AppImage is never opened. Handing this one to the OS would run it, and
    // "the shell does not execute what it downloads" is the whole reason every
    // other kind goes through the installer the user already recognises. What it
    // does need is the executable bit, which a downloaded file does not carry
    // and without which nothing will start it.
    if (artifact.kind === "appimage") {
      // A failure here leaves a file the user can chmod themselves, and the
      // file manager is about to show them where it is, so it is not worth
      // failing a launch over.
      await chmod(file, 0o755).catch(() => {});
      shell.showItemInFolder(file);
      return { handedOff: true, mayAppear: false };
    }

    const failure = await shell.openPath(file);
    // An archive has no handler on Windows 10, and revealing it is a better
    // answer than silence. Worth doing for the portable case anyway, since the
    // user has to go and find what it unpacked -- which is what this asks, not
    // whether the launch should wait afterwards.
    if (failure || !installsWhereDetectionLooks(artifact.kind)) {
      shell.showItemInFolder(file);
    }
    // Waiting is a separate question, and a failed openPath does not change its
    // answer: an installer revealed rather than opened is one the user runs
    // from their file manager, and it installs itself in the same place it
    // would have -- a reason to keep waiting, not to give up on their behalf.
    return { handedOff: true, mayAppear: mayAppearWhereDetectionLooks(artifact) };
  } catch (error) {
    clearTaskbarProgress(parent);
    // Neither of these handed anything over, and saying they did would have the
    // caller tell the user to go and configure an emulator that was never
    // downloaded. A cancel is the launch's own cancellation; a failure keeps
    // the reason it failed for.
    if (signal.aborted) throw cancelled();
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
    throw error instanceof LaunchError
      ? error
      : new LaunchError(
          "download-failed",
          error instanceof Error ? error.message : String(error),
        );
  }
}
