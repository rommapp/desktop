// Page downloads bypass the native-launch pipeline. Observe Electron's transfer
// without changing its save dialog or treating a manually downloaded ROM as a
// cached launch. The session is shared with login windows, so ownership is
// checked before observing anything and the listener leaves with its window.

import type { DownloadItem, Session, WebContents } from "electron";
import { isServerOrigin } from "./window-policy.ts";

export interface PageDownloadFeedback {
  progress(value: number | null): void;
  finished(path: string): void;
  failed(message: string): void;
}

export function observePageDownloads(
  session: Session,
  contents: WebContents,
  serverUrl: string,
  feedback: PageDownloadFeedback,
): () => void {
  const active = new Map<DownloadItem, number>();
  const cleanups = new Set<() => void>();
  const render = (): void => {
    if (!active.size) feedback.progress(null);
    else if ([...active.values()].some((value) => value < 0)) feedback.progress(-1);
    else feedback.progress(
      [...active.values()].reduce((a, b) => a + b, 0) / active.size,
    );
  };
  const onDownload = (
    event: Electron.Event,
    item: DownloadItem,
    source: WebContents,
  ): void => {
    if (source !== contents) return;
    // A download of an API asset should never be an HTML document. In
    // particular, do not report a login redirect saved as a ROM as success.
    const urls = item.getURLChain();
    const apiAsset = urls.some((url) => {
      if (!isServerOrigin(url, serverUrl)) return false;
      return new URL(url).pathname.startsWith("/api/");
    });
    if (
      apiAsset &&
      /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(item.getMimeType())
    ) {
      event.preventDefault();
      feedback.failed(
        "The server returned a web page instead of a file. Sign in to RomM and try again.",
      );
      return;
    }
    const update = (): void => {
      const total = item.getTotalBytes();
      active.set(
        item,
        total > 0 ? Math.min(1, item.getReceivedBytes() / total) : -1,
      );
      render();
    };
    const cleanup = (): void => {
      item.removeListener("updated", update);
      item.removeListener("done", done);
      active.delete(item);
      cleanups.delete(cleanup);
    };
    const done = (_event: Electron.Event, state: string): void => {
      const path = item.getSavePath();
      cleanup();
      render();
      if (state === "completed") feedback.finished(path);
      else if (state !== "cancelled") feedback.failed(
        "The download was interrupted. Check your connection and try again.",
      );
    };
    cleanups.add(cleanup);
    item.on("updated", update);
    item.once("done", done);
    update();
  };
  session.on("will-download", onDownload);
  return () => {
    session.removeListener("will-download", onDownload);
    for (const cleanup of cleanups) cleanup();
    feedback.progress(null);
  };
}
