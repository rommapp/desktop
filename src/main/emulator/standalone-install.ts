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
  clearTaskbarProgress,
  showTaskbarProgress,
} from "../window-progress.ts";
import {
  RELEASE_SOURCES,
  type ReleaseArtifact,
  type ReleaseSource,
  installsWhereDetectionLooks,
  unwrapRelease,
} from "./standalone-release.ts";

/** Dolphin's macOS image is the largest of these at a few hundred megabytes. */
const MAX_EMULATOR_BYTES = 1024 * 1024 * 1024;

/** Kept beside the config, one at a time, like the RetroArch installer. */
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
  } catch (error) {
    if (signal.aborted) throw error;
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

/**
 * What the user will have to do once the file opens.
 *
 * Three of the four end with the emulator where detection looks, so the launch
 * waits and starts the game itself -- saying so is the difference between a
 * hand-off that feels finished and one that reads as a chore. The fourth cannot
 * promise that, and says what it does need instead.
 */
function whatHappensNext(artifact: ReleaseArtifact, label: string): string {
  switch (artifact.kind) {
    case "installer":
      return `${label}'s own installer will open. Run it and your game starts by itself.`;
    case "disk-image":
      return `The disk image will open. Drag ${label} into your Applications folder and your game starts by itself.`;
    case "flatpak":
      return `The Flatpak will open in your software installer. Install it and your game starts by itself.`;
    default:
      // The one case that does not end with the emulator somewhere findable.
      return `${label} publishes only a portable archive for this system, so it will open in your file manager. Extract it, then point at the executable under "emulators" in the settings.`;
  }
}

export interface InstallOffer {
  /** True when something was downloaded and handed over, so the caller should
   *  stop rather than carry on with a launch that cannot work yet. */
  handedOff: boolean;
  /** True when what was handed over installs where detection looks, so waiting
   *  for it to appear will eventually succeed. False for a portable archive,
   *  which lands somewhere only the user knows. */
  detectable: boolean;
}

const DECLINED: InstallOffer = { handedOff: false, detectable: false };

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

  // A transfer this long should not outlive the window that asked for it. The
  // launch's own signal already covers a cancel from the page and the app
  // quitting; this adds the parent closing on its own, which on macOS leaves
  // the app -- and otherwise the download -- running.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  parent?.once("closed", abort);
  app.once("before-quit", abort);
  try {
    return await runOffer(source, parent, controller.signal, onProgress);
  } finally {
    signal.removeEventListener("abort", abort);
    if (parent && !parent.isDestroyed()) parent.off("closed", abort);
    app.off("before-quit", abort);
  }
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
      : `Nothing could be fetched automatically for this system. The download page has the options.\n\nAlready have it somewhere unusual? Point at it under "emulators" in the settings instead.`,
  });

  if (response !== 1) return DECLINED;
  if (!artifact) {
    void shell.openExternal(source.downloadPage);
    // Nothing was fetched, so there is nothing to wait for appearing.
    return { handedOff: true, detectable: false };
  }

  const detectable = installsWhereDetectionLooks(artifact.kind);
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

    const failure = await shell.openPath(file);
    // An archive has no handler on Windows 10, and revealing it is a better
    // answer than silence. Worth doing for the portable case anyway, since the
    // user has to go and find what it unpacked.
    if (failure || !detectable) shell.showItemInFolder(file);
    return { handedOff: true, detectable: detectable && !failure };
  } catch (error) {
    clearTaskbarProgress(parent);
    if (signal.aborted) return { handedOff: true, detectable: false };
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
    return { handedOff: true, detectable: false };
  }
}
