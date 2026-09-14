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
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type DesktopConfig, LaunchError } from "../../shared/types.ts";
import { updateConfig } from "../config.ts";
import { createProgressGate } from "../progress.ts";
import {
  BUILDBOT_ORIGIN,
  MAX_INSTALLER_BYTES,
  PINNED_STABLE_VERSION,
  RETROARCH_DOWNLOAD_PAGE,
  type RetroArchInstaller,
  hasNoEmulator,
  latestStableVersion,
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

/**
 * Stream the installer to disk.
 *
 * Streamed rather than buffered, unlike a core: these are north of 200MB and
 * holding one in memory to write it straight back out would be pure waste.
 */
async function downloadInstaller({
  installer,
  directory,
  signal,
  onProgress,
}: {
  installer: RetroArchInstaller;
  directory: string;
  signal: AbortSignal;
  onProgress: (received: number, total: number | null) => void;
}): Promise<string> {
  // The URL is built here, but assert the origin anyway: this ends in a file
  // the operating system is asked to execute.
  if (new URL(installer.url).origin !== BUILDBOT_ORIGIN) {
    throw new LaunchError(
      "download-failed",
      `Refusing to download from ${new URL(installer.url).origin}`,
    );
  }

  const response = await net.fetch(installer.url, { signal });
  if (!response.ok) {
    throw new LaunchError(
      "download-failed",
      `Buildbot returned ${response.status} for ${installer.fileName}`,
    );
  }
  if (!response.body) {
    throw new LaunchError("download-failed", "Buildbot sent an empty response");
  }

  const declared = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  const total = Number.isFinite(declared) ? declared : null;
  if (total !== null && total > MAX_INSTALLER_BYTES) {
    throw new LaunchError(
      "download-failed",
      `${installer.fileName} is ${total} bytes, past the ${MAX_INSTALLER_BYTES} limit`,
    );
  }

  // Only ever one installer is kept: this runs at most once per machine, and
  // leaving a second 200MB file behind would be litter.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  const target = join(directory, installer.fileName);
  // Write beside the target and rename, so an interrupted transfer cannot leave
  // a truncated installer that the user then runs.
  const temp = `${target}.part`;
  const file = createWriteStream(temp);
  const reader = response.body.getReader();
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_INSTALLER_BYTES) {
        await reader.cancel();
        throw new LaunchError(
          "download-failed",
          `${installer.fileName} exceeded the ${MAX_INSTALLER_BYTES} byte limit`,
        );
      }
      // Respect the write stream's backpressure rather than holding a 200MB
      // transfer in memory.
      if (!file.write(value)) {
        await new Promise<void>((resolve, reject) => {
          file.once("drain", resolve);
          file.once("error", reject);
        });
      }
      onProgress(received, total);
    }
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    file.destroy();
    await rm(temp, { force: true });
    throw error instanceof LaunchError
      ? error
      : new LaunchError(
          "download-failed",
          error instanceof Error ? error.message : String(error),
        );
  }

  // A transfer that stopped early still leaves a file, so check it against what
  // the server said before handing it to the OS to run.
  if (total !== null && received !== total) {
    await rm(temp, { force: true });
    throw new LaunchError(
      "download-failed",
      `${installer.fileName} arrived as ${received} of ${total} bytes`,
    );
  }

  await rename(temp, target);
  return target;
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

  const { response, checkboxChecked } = await ask(parent, {
    type: "question",
    buttons: available
      ? ["Not now", "Download RetroArch"]
      : ["Not now", "Open download page"],
    defaultId: 1,
    cancelId: 0,
    title: "No emulator found",
    message: "RomM Desktop could not find an emulator on this machine.",
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
    const file = await downloadInstaller({
      installer,
      directory: installerDirectory(),
      signal: controller.signal,
      onProgress: (received, total) => {
        if (!total) return;
        const fraction = received / total;
        if (!shouldReport(fraction)) return;
        parent?.setProgressBar(fraction);
      },
    });
    parent?.setProgressBar(-1);

    // openPath runs the installer on Windows and mounts the image on macOS,
    // which is the whole point: the user completes the install themselves.
    const failure = await shell.openPath(file);
    if (failure) shell.showItemInFolder(file);
  } catch (error) {
    parent?.setProgressBar(-1);
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
