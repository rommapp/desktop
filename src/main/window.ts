import { BrowserWindow, app, dialog, shell } from "electron";
import { join } from "node:path";
import { type DesktopConfig } from "../shared/types.ts";
import { loadConfig, updateConfig } from "./config.ts";
import { isSpikeMode, spikeScript } from "./spike.ts";
import {
  classifyNavigation,
  isAuthFlowComplete,
  shouldGrantPermission,
} from "./window-policy.ts";

const SETUP_PAGE = join(__dirname, "../../resources/setup.html");

/** No preload and no Node, the same as the main window, for pages that are
 *  more foreign still: an identity provider we have not bound ourselves to. */
const AUTH_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
  webSecurity: true,
  spellcheck: false,
} as const;

/** Confine a window to its RomM server. The renderer paints metadata from ten
 *  third-party providers, so only same-origin navigation stays in-window. */
function confineToServer(window: BrowserWindow, serverUrl: string): void {
  let authWindow: BrowserWindow | null = null;

  const openAuthWindow = (url: string): void => {
    if (authWindow && !authWindow.isDestroyed()) {
      // A second attempt while one is open restarts the flow in the window
      // already there, rather than stacking another over it.
      void authWindow.loadURL(url);
      authWindow.focus();
      return;
    }
    authWindow = createAuthWindow(window, serverUrl, url, (returnUrl) => {
      // The auth window is a child, so quitting mid-login closes it and this
      // arrives with nothing left to load.
      if (!window.isDestroyed()) void window.loadURL(returnUrl);
    });
    authWindow.on("closed", () => {
      authWindow = null;
    });
  };

  const openExternally = (url: string): void => {
    // classifyNavigation has already established this is a scheme we open.
    void shell.openExternal(url);
  };

  const route = (event: Electron.Event, url: string): void => {
    switch (classifyNavigation(url, serverUrl)) {
      case "in-window":
        return;
      case "auth-window":
        event.preventDefault();
        openAuthWindow(url);
        return;
      case "external":
        event.preventDefault();
        openExternally(url);
        return;
      case "blocked":
        event.preventDefault();
        return;
    }
  };

  window.webContents.on("will-navigate", route);

  // A same-origin request that answers with an off-origin redirect never
  // reaches will-navigate, so without this the confinement has a gap the
  // server itself can walk the window through.
  window.webContents.on("will-redirect", route);

  window.webContents.setWindowOpenHandler(({ url }) => {
    // RomM opens the OIDC endpoint with window.open, so this path has to reach
    // the auth window too. Nothing else is given a window of its own: a link
    // asking for one still goes to the user's browser, as it did before.
    switch (classifyNavigation(url, serverUrl)) {
      case "auth-window":
        openAuthWindow(url);
        break;
      case "in-window":
      case "external":
        openExternally(url);
        break;
      case "blocked":
        break;
    }
    return { action: "deny" };
  });

  // Attaching a webview would bypass the checks above, and RomM never uses one.
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );

  window.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback, details) => {
      callback(shouldGrantPermission(permission, details, serverUrl));
    },
  );
}

/**
 * A window for an authentication flow that has to leave the server's origin.
 *
 * Confining the main window is what makes it safe to point a renderer at a
 * remote page, and an OIDC login is the one thing RomM does that cannot live
 * inside that rule: the identity provider is off-origin by definition. So the
 * excursion gets a window of its own that permits it. That window shares the
 * default session, and therefore the cookie jar, so the session the provider
 * establishes is the one the main window goes on to use -- which is exactly
 * what handing the flow to the system browser could never do.
 *
 * It carries no preload, so `window.rommNative` stays reachable only from the
 * server's own page and never from a provider's.
 */
function createAuthWindow(
  parent: BrowserWindow,
  serverUrl: string,
  startUrl: string,
  onComplete: (url: string) => void,
): BrowserWindow {
  const authWindow = new BrowserWindow({
    parent,
    width: 520,
    height: 720,
    minWidth: 380,
    minHeight: 480,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    title: "Sign in",
    // Shown once the provider's page is ready to paint rather than now. A
    // provider that still has a session of its own answers immediately and the
    // flow finishes below without this window ever appearing, so the common
    // case is no window at all instead of one that flashes open and shut.
    show: false,
    webPreferences: AUTH_WEB_PREFERENCES,
  });

  authWindow.once("ready-to-show", () => {
    if (!authWindow.isDestroyed()) authWindow.show();
  });

  const finish = (event: Electron.Event, url: string): void => {
    if (!isAuthFlowComplete(url, serverUrl)) return;
    // Stopping a hop short of loading this page: the session was established by
    // the response that asked for this redirect, so the main window can go
    // there itself and this one has nothing left to show.
    event.preventDefault();
    onComplete(url);
    authWindow.close();
  };

  authWindow.webContents.on("will-navigate", finish);
  authWindow.webContents.on("will-redirect", finish);

  // A provider that runs part of the flow in a popup -- a passkey prompt, a
  // second factor -- needs it to open, and to keep its opener. Denying it here
  // would strand the same flow this window exists to allow.
  authWindow.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { webPreferences: AUTH_WEB_PREFERENCES },
  }));

  void authWindow.loadURL(startUrl);
  return authWindow;
}

function createWindow(preload: string, fullscreen = false): BrowserWindow {
  return new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    fullscreen,
    title: "RomM",
    webPreferences: {
      preload,
      // The preload has no Node access to read package metadata, so the shell
      // version it reports to the page is passed in as an argv flag.
      additionalArguments: [`--romm-shell-version=${app.getVersion()}`],
      // The renderer is remote content. It gets no Node, no shared globals
      // with the preload, and its own OS sandbox.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
}

export function createSetupWindow(
  onSaved: (serverUrl: string) => void,
): BrowserWindow {
  const window = createWindow(join(__dirname, "../preload/setup.js"));
  void window.loadFile(SETUP_PAGE);
  window.webContents.ipc.handle("setup:save", async (_event, raw: unknown) => {
    const serverUrl = normalizeServerUrl(raw);
    await updateConfig({ serverUrl });
    onSaved(serverUrl);
    window.close();
  });
  return window;
}

/** Accept what a user would actually type and reject anything that is not a web origin. */
export function normalizeServerUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Enter the address of your RomM server.");
  }
  const candidate = raw.trim();
  const withScheme = /^https?:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http:// and https:// addresses are supported.");
  }
  return url.origin;
}

export function createMainWindow(
  serverUrl: string,
  fullscreen = false,
): BrowserWindow {
  const window = createWindow(
    join(__dirname, "../preload/index.js"),
    fullscreen,
  );
  confineToServer(window, serverUrl);
  if (isSpikeMode()) installSpike(window);
  void window.loadURL(serverUrl);
  return window;
}

/** TEMPORARY: see spike.ts. Remove with the harness. */
function installSpike(window: BrowserWindow): void {
  window.webContents.on("did-finish-load", () => {
    void window.webContents
      .executeJavaScript(spikeScript())
      .then((result) => console.error(`[spike] ${result}`))
      .catch((error) => console.error("[spike] injection failed", error));
  });
}

/** Self-signed certificates are common on a LAN, so ask once and remember the
 *  fingerprint rather than locking those servers out. */
export function installCertificateTrust(): void {
  app.on(
    "certificate-error",
    (event, webContents, url, error, certificate, callback) => {
      void (async () => {
        const config: DesktopConfig = await loadConfig();
        if (config.trustedCertificates.includes(certificate.fingerprint)) {
          event.preventDefault();
          callback(true);
          return;
        }

        const parent = BrowserWindow.fromWebContents(webContents);
        const options = {
          type: "warning" as const,
          buttons: ["Cancel", "Trust this certificate"],
          defaultId: 0,
          cancelId: 0,
          title: "Untrusted certificate",
          message: `The certificate for ${new URL(url).host} could not be verified.`,
          detail: `${error}\n\nFingerprint: ${certificate.fingerprint}\n\nOnly continue if this is your own server.`,
        };
        const { response } = parent
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);

        if (response !== 1) {
          callback(false);
          return;
        }

        await updateConfig({
          trustedCertificates: [
            ...config.trustedCertificates,
            certificate.fingerprint,
          ],
        });
        event.preventDefault();
        callback(true);
      })();
    },
  );
}
