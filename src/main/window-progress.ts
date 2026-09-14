// Showing a transfer on the taskbar or dock.
//
// Two lines of Electron, except for the part that is easy to miss: a download
// outlives the window that started it. Closing the window aborts the transfer,
// but the abort is only observed at the next chunk boundary, so a progress
// update can still arrive for a BrowserWindow that has been destroyed -- and
// calling anything on one of those throws. The guard lives here rather than at
// each call site so both offers get it.

import { type BrowserWindow } from "electron";

/** Show a fraction of a transfer, if there is still a window to show it on. */
export function showTaskbarProgress(
  parent: BrowserWindow | null,
  fraction: number,
): void {
  if (!parent || parent.isDestroyed()) return;
  parent.setProgressBar(fraction);
}

/** Take the indicator away again. Safe to call when it was never shown. */
export function clearTaskbarProgress(parent: BrowserWindow | null): void {
  showTaskbarProgress(parent, -1);
}
