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

const launcher = new Launcher((state) => {
  broadcastLaunchState(state);
  // Quitting the emulator should land back in the shell rather than on the
  // desktop. A player on a couch has no mouse to click the window with.
  if (state.status === "exited") focusMainWindow();
});

/** Bring the existing window forward, whatever state it was left in. */
function focusMainWindow(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// Consumed the first time a window opens, so re-activating later returns to
// the server rather than reopening setup.
let forceSetup = isSetupMode();

// One instance owns the ROM cache and the launch registry; a second would race
// both, so hand the argv to the window that is already running instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);

  void start();
}

async function openInitialWindow(): Promise<void> {
  const config = await loadConfig();
  if (config.serverUrl && !forceSetup) {
    createMainWindow(config.serverUrl, config.fullscreen);
    return;
  }
  forceSetup = false;
  // Setup stays windowed whatever the setting says: filling a screen to ask
  // for one address is hostile, and it is the one screen needing a keyboard.
  createSetupWindow((serverUrl) =>
    createMainWindow(serverUrl, config.fullscreen),
  );
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
