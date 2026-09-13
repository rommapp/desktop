import { BrowserWindow, app } from "electron";
import { isSetupMode } from "./argv.ts";
import { loadConfig } from "./config.ts";
import { broadcastLaunchState, registerIpc } from "./ipc.ts";
import { Launcher } from "./launcher.ts";
import {
  createMainWindow,
  createSetupWindow,
  installCertificateTrust,
} from "./window.ts";

const launcher = new Launcher(broadcastLaunchState);

// Consumed the first time a window opens, so re-activating later returns to
// the server rather than reopening setup.
let forceSetup = isSetupMode();

// One instance owns the ROM cache and the launch registry; a second would race
// both, so hand the argv to the window that is already running instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void start();
}

async function openInitialWindow(): Promise<void> {
  const config = await loadConfig();
  if (config.serverUrl && !forceSetup) {
    createMainWindow(config.serverUrl);
    return;
  }
  forceSetup = false;
  createSetupWindow((serverUrl) => createMainWindow(serverUrl));
}

async function start(): Promise<void> {
  await app.whenReady();
  installCertificateTrust();
  registerIpc(launcher);
  await openInitialWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openInitialWindow();
  });
}

app.on("window-all-closed", () => {
  launcher.dispose();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => launcher.dispose());
