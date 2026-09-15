import { BrowserWindow, ipcMain, shell } from "electron";
import { configPath, loadConfig, saveConfig } from "./config.ts";
import { type Launcher } from "./launcher.ts";
import {
  validateLaunchRequest,
  validatePlatformQueries,
  validatePlatformQuery,
} from "./safety.ts";

const LAUNCH_STATE_CHANNEL = "romm:launch-state";

export function registerIpc(launcher: Launcher): void {
  ipcMain.handle("romm:launch", async (event, raw: unknown) => {
    const request = validateLaunchRequest(raw);
    // The session comes from the calling window, never from the request, so a
    // launch always downloads with that window's own credentials. The window
    // comes along too, so an emulator offer is a sheet on the page that asked
    // rather than a dialog from nowhere.
    return launcher.launch(
      request,
      event.sender.session,
      BrowserWindow.fromWebContents(event.sender),
    );
  });

  ipcMain.handle("romm:cancel", (_event, romId: unknown) => {
    if (typeof romId === "number" && Number.isInteger(romId)) {
      launcher.cancel(romId);
    }
  });

  ipcMain.handle("romm:platform-support", (_event, raw: unknown) =>
    launcher.getPlatformSupport(validatePlatformQuery(raw)),
  );

  ipcMain.handle("romm:platform-support-all", (_event, raw: unknown) =>
    launcher.getPlatformSupportAll(validatePlatformQueries(raw)),
  );

  ipcMain.handle("romm:open-settings", async () => {
    // A config that has only ever been defaults was never written, so there
    // would be nothing to open. Writing it first also shows the user what
    // autodetection actually found.
    await saveConfig(await loadConfig());

    const target = configPath();
    // openPath does nothing when the OS has no handler for .json, which is
    // common on Windows, so fall back to revealing it in the file manager.
    const failure = await shell.openPath(target);
    if (failure) shell.showItemInFolder(target);
  });
}

/** Push launch progress to every open window. */
export function broadcastLaunchState(state: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(LAUNCH_STATE_CHANNEL, state);
  }
}
