// Getting the user to a login page once the server has stopped recognising them.
//
// The shell signs nobody in. It reloads the page and lets RomM's own frontend do
// what it does for any unauthenticated visit, which is to send them to the login
// it owns. That keeps the single credential path in this app the one the server
// ships: a username and password server gets its form, an OIDC server gets its
// provider, and neither is something written here.
//
// Called from every place that reads a status off the server, because the moment
// worth acting on is whichever one happens to notice first.

import { BrowserWindow } from "electron";
import { isServerOrigin } from "../window-policy.ts";
import { isOnLoginPage, isSignedOut } from "./status.ts";

/**
 * How long one observed sign-out stands for.
 *
 * A single launch asks the server several times -- the ROM, the disc list, the
 * firmware list, the save negotiation -- and an expired session fails all of
 * them. Without this, one launch would reload the window once per request, each
 * reload interrupting the last.
 */
const COOLDOWN_MS = 30_000;

let lastNudge = 0;

/**
 * Note a status the server answered with, and show the user when it means the
 * session has gone.
 *
 * Takes every status rather than only the interesting one, so the four places
 * that talk to the server each carry one line and the decision about which
 * status matters stays in `status.ts`.
 */
export function noteSignedOut(serverUrl: string, status: number): void {
  if (!isSignedOut(status)) return;

  const now = Date.now();
  if (now - lastNudge < COOLDOWN_MS) return;

  const windows = BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed(),
  );

  // A window with a parent is the auth excursion, which means a sign-in is
  // already under way. Reloading behind it would at best be noise and at worst
  // restart the flow the user is halfway through.
  if (windows.some((window) => window.getParentWindow() !== null)) return;

  const showing = windows.filter((window) => {
    const url = window.webContents.getURL();
    // Only a window actually on the server: the setup window is a local file,
    // and neither it nor anything off-origin is what a RomM session is about.
    return isServerOrigin(url, serverUrl) && !isOnLoginPage(url);
  });
  if (showing.length === 0) return;

  // Set only once there is something to reload, so a sign-out observed while
  // every window was already at the login page does not spend the cooldown that
  // the next one, with somewhere to go, would have wanted.
  lastNudge = now;
  for (const window of showing) {
    // Reloaded rather than sent to the server root, so RomM's own router decides
    // where they land and can return them afterwards to the page they were on.
    window.webContents.reload();
  }
}
