import { BrowserWindow, app } from "electron";
import { type DesktopConfig } from "../shared/types.ts";
import { isSetupMode } from "./argv.ts";
import { loadConfig } from "./config.ts";
import { offerRetroArchInstall } from "./emulator/bootstrap.ts";
import { broadcastLaunchState, registerIpc } from "./ipc.ts";
import { Launcher } from "./launcher.ts";
import { reportPlaySessions } from "./play/report.ts";
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

// openInitialWindow also runs on macOS "activate", so without this a user who
// answered "Not now" without ticking the box would be asked again every time
// they closed and reopened the window. The offer is once on startup.
let emulatorOfferMade = false;

function offerEmulatorOnce(
  config: Parameters<typeof offerRetroArchInstall>[0],
  window: BrowserWindow,
): void {
  if (emulatorOfferMade) return;
  emulatorOfferMade = true;
  // Wait for the page before asking anything. On macOS a dialog parented to a
  // window is a sheet, and only one sheet shows at a time: put up beside
  // loadURL, this one queues in front of the certificate-trust prompt that a
  // self-signed LAN server has to have answered before it can load at all. The
  // offer can then sit there for as long as an emulator install takes, with the
  // page never loading behind it.
  window.webContents.once("did-finish-load", () => {
    void offerRetroArchInstall(config, window);
  });
}

// One instance owns the ROM cache and the launch registry; a second would race
// both, so hand the argv to the window that is already running instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);

  void start();
}

/** The backlog belongs to the machine rather than to any one launch, so nothing
 *  cancels it. */
const NEVER_CANCELLED = new AbortController().signal;

/**
 * Offer the server whatever play sessions it has not been told about.
 *
 * Every other attempt happens when an emulator exits, which is enough for a
 * machine that is used again. It is not enough for one that was played offline
 * and then set down: without this, that session waits for a launch that may
 * never come. Unlike the emulator offer, this runs for every window rather than
 * once per run: a reopen is another chance at a server that was not there
 * before, and an empty queue costs a file that is not on disk.
 *
 * Held until the page has loaded, so it goes out over a session the user has had
 * the chance to sign back into.
 */
function reportBacklog(config: DesktopConfig, window: BrowserWindow): void {
  window.webContents.once("did-finish-load", () => {
    void reportPlaySessions({
      config,
      session: window.webContents.session,
      signal: NEVER_CANCELLED,
    });
  });
}

async function openInitialWindow(): Promise<void> {
  const config = await loadConfig();
  if (config.serverUrl && !forceSetup) {
    const window = createMainWindow(config.serverUrl, config.fullscreen);
    // After the page, not beside it: see offerEmulatorOnce.
    offerEmulatorOnce(config, window);
    reportBacklog(config, window);
    return;
  }
  forceSetup = false;
  // Setup stays windowed whatever the setting says: filling a screen to ask
  // for one address is hostile, and it is the one screen needing a keyboard.
  createSetupWindow((serverUrl) => {
    const window = createMainWindow(serverUrl, config.fullscreen);
    // Re-read rather than reuse: the config in hand predates the address just
    // saved, and the offer is gated on that being set. This is the true first
    // run, so it is the one time the offer matters most.
    void loadConfig().then((saved) => offerEmulatorOnce(saved, window));
  });
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

/** How long a quit waits for a save already on its way to the server. Bounded
 *  because a quit the user asked for has to happen, whatever the network is
 *  doing. */
const SAVE_SETTLE_MS = 5000;

let quitting = false;

app.on("before-quit", (event) => {
  launcher.dispose();
  if (quitting) return;

  // An upload in flight is not something a quit can finish or roll back, only
  // interrupt, and a request cut off mid-body is one the server may keep half
  // of. Hold the quit for it briefly instead of deciding that for the user. The
  // second pass through this handler is the one that actually quits.
  quitting = true;
  event.preventDefault();
  void Promise.race([
    launcher.saveSyncSettled(),
    new Promise<void>((resolve) => setTimeout(resolve, SAVE_SETTLE_MS)),
  ]).then(() => app.quit());
});
