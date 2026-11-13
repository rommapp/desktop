// A page download should keep its taskbar feedback while background installs
// run. Track both sources so finishing one transfer cannot erase the other's
// progress, and keep window ownership weak so closing it needs no cleanup.

interface ProgressWindow {
  isDestroyed(): boolean;
  setProgressBar(value: number): void;
}
const progress = new WeakMap<ProgressWindow, Map<"page" | "emulator" | "install", number>>();
export function setTransferProgress(window: ProgressWindow, source: "page" | "emulator" | "install", value: number | null): void {
  if (window.isDestroyed()) return;
  const sources = progress.get(window) ?? new Map<"page" | "emulator" | "install", number>();
  if (value === null) sources.delete(source);
  else sources.set(source, value);
  progress.set(window, sources);
  window.setProgressBar(sources.get("page") ?? sources.get("emulator") ?? sources.get("install") ?? -1);
}

/** Existing emulator offers use these wrappers and keep their progress above
 *  background installs, with the same destroyed-window guard. */
export function showTaskbarProgress(parent: ProgressWindow | null, fraction: number): void {
  if (parent) setTransferProgress(parent, "emulator", fraction < 0 ? null : fraction);
}
export function clearTaskbarProgress(parent: ProgressWindow | null): void {
  showTaskbarProgress(parent, -1);
}
