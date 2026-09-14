// The first-run offer to get an emulator onto a machine that has none.
//
// Without this the shell is a dead end for a new user: nothing launches, the
// core downloading in install.ts never fires because it requires an emulator to
// already be present, and the only explanation is a message on a button they
// may never press.
//
// Nothing is installed here, and nothing is extracted. The shell fetches
// RetroArch's own installer and hands it to the operating system, so the
// consent, the signing prompts and the updates all stay where they belong. See
// retroarch.ts for why that is the shape of this rather than an install.

import { type BrowserWindow, app, dialog, net, shell } from "electron";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type DesktopConfig } from "../../shared/types.ts";
import { updateConfig } from "../config.ts";
import { downloadToFile } from "../download.ts";
import { detectedStandaloneLabels } from "./standalone.ts";
import { createProgressGate } from "../progress.ts";
import {
  clearTaskbarProgress,
  showTaskbarProgress,
} from "../window-progress.ts";
import {
  BUILDBOT_ORIGIN,
  MAX_INSTALLER_BYTES,
  PINNED_STABLE_VERSION,
  RETROARCH_DOWNLOAD_PAGE,
  hasNoEmulator,
  latestStableVersion,
  noEmulatorMessage,
  retroarchInstaller,
  shouldOfferRetroArch,
} from "./retroarch.ts";

/** Where a downloaded installer is kept, beside the config. */
export function installerDirectory(): string {
  return join(app.getPath("userData"), "installers");
}

/** Drop a downloaded installer once it has evidently been used. */
async function forgetInstaller(): Promise<void> {
  await rm(installerDirectory(), { recursive: true, force: true }).catch(
    () => {},
  );
}

/** Read the buildbot's stable index, falling back to the pinned version. */
async function resolveLatestStableVersion(
  signal: AbortSignal,
): Promise<string> {
  try {
    const response = await net.fetch(`${BUILDBOT_ORIGIN}/stable/`, { signal });
    if (!response.ok) return PINNED_STABLE_VERSION;
    return latestStableVersion(await response.text()) ?? PINNED_STABLE_VERSION;
  } catch {
    // Offline, or the index moved. The pinned version still names a real
    // installer, and the download below reports it if it does not.
    return PINNED_STABLE_VERSION;
  }
}

function openDownloadPage(): void {
  void shell.openExternal(RETROARCH_DOWNLOAD_PAGE);
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
 * Offer to fetch RetroArch's own installer and hand it to the OS, when this
 * machine has no emulator at all.
 */
export async function offerRetroArchInstall(
  config: DesktopConfig,
  parent: BrowserWindow | null,
): Promise<void> {
  if (!shouldOfferRetroArch(config)) {
    // An emulator turned up since the offer was last made, so the installer
    // that produced it is 200MB of litter.
    if (!hasNoEmulator(config)) await forgetInstaller();
    return;
  }

  // The version is resolved only once the user says yes; this asks whether
  // there is anything to offer on this system at all.
  const available = retroarchInstaller(PINNED_STABLE_VERSION) !== null;

  // Detection can have turned up PCSX2 or Dolphin, which play one platform
  // each. Still worth offering RetroArch for the rest of the library, but not
  // worth claiming to have found nothing.
  const alreadyHere = config.useDetectedEmulators
    ? detectedStandaloneLabels()
    : [];

  const { response, checkboxChecked } = await ask(parent, {
    type: "question",
    buttons: available
      ? ["Not now", "Download RetroArch"]
      : ["Not now", "Open download page"],
    defaultId: 1,
    cancelId: 0,
    title:
      alreadyHere.length > 0
        ? "Most platforms need RetroArch"
        : "No emulator found",
    message: noEmulatorMessage(alreadyHere),
    detail: available
      ? "It can download RetroArch's official installer (about 200 MB) and open it for you. The install is RetroArch's own, so it runs with the usual prompts and keeps updating itself afterwards.\n\nAlready have an emulator somewhere unusual? Point at it in the settings instead."
      : "On Linux, RetroArch is best installed through your distribution's package manager, which will also keep it updated. The download page lists the options.\n\nAlready have an emulator somewhere unusual? Point at it in the settings instead.",
    checkboxLabel: "Don't ask again",
    checkboxChecked: false,
  });

  if (checkboxChecked) await updateConfig({ offerRetroArchInstall: false });
  if (response !== 1) return;
  if (!available) {
    openDownloadPage();
    return;
  }

  await runInstallerDownload(parent);
}

async function runInstallerDownload(
  parent: BrowserWindow | null,
): Promise<void> {
  const controller = new AbortController();
  // A transfer this long should not outlive the window that started it, nor
  // hold up a quit.
  const abort = () => controller.abort();
  parent?.once("closed", abort);
  app.once("before-quit", abort);

  try {
    const version = await resolveLatestStableVersion(controller.signal);
    const installer = retroarchInstaller(version);
    if (!installer) {
      openDownloadPage();
      return;
    }

    // The taskbar and dock already have somewhere to show this, which beats a
    // dialog that cannot update itself.
    const shouldReport = createProgressGate();
    const file = await downloadToFile({
      url: installer.url,
      fileName: installer.fileName,
      directory: installerDirectory(),
      policy: { origins: [BUILDBOT_ORIGIN] },
      maxBytes: MAX_INSTALLER_BYTES,
      signal: controller.signal,
      onProgress: (received, total) => {
        if (!total) return;
        const fraction = received / total;
        if (!shouldReport(fraction)) return;
        showTaskbarProgress(parent, fraction);
      },
    });
    clearTaskbarProgress(parent);

    // openPath runs the installer on Windows and mounts the image on macOS,
    // which is the whole point: the user completes the install themselves.
    const failure = await shell.openPath(file);
    if (failure) shell.showItemInFolder(file);
  } catch (error) {
    clearTaskbarProgress(parent);
    if (controller.signal.aborted) return;

    const { response } = await ask(parent, {
      type: "error",
      buttons: ["Close", "Open download page"],
      defaultId: 1,
      cancelId: 0,
      title: "Could not download RetroArch",
      message: "The installer could not be downloaded.",
      detail: `${error instanceof Error ? error.message : String(error)}\n\nYou can install RetroArch yourself and RomM Desktop will find it.`,
    });
    if (response === 1) openDownloadPage();
  } finally {
    parent?.off("closed", abort);
    app.off("before-quit", abort);
  }
}
