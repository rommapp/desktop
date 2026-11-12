import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { DownloadItem, Session, WebContents } from "electron";
import { observePageDownloads } from "./page-downloads.ts";

function fixture() {
  const session = new EventEmitter();
  const contents = {} as WebContents;
  const progress: (number | null)[] = [];
  const finished: string[] = [];
  const failed: string[] = [];
  const stop = observePageDownloads(session as Session, contents, "https://romm.test", {
    progress: (value) => progress.push(value),
    finished: (path) => finished.push(path),
    failed: (message) => failed.push(message),
  });
  function download(mime = "application/octet-stream", source = contents) {
    const item = Object.assign(new EventEmitter(), {
      total: 100,
      received: 25,
      getTotalBytes() { return this.total; },
      getReceivedBytes() { return this.received; },
      getSavePath: () => "/downloads/game.zip",
      getURLChain: () => ["https://romm.test/api/roms/1/content/game.zip"],
      getMimeType: () => mime,
    });
    let prevented = false;
    session.emit("will-download", { preventDefault() { prevented = true; } }, item as unknown as DownloadItem, source);
    return { item, prevented };
  }
  return { session, progress, finished, failed, stop, download };
}

test("page download reports progress and the completed destination", () => {
  const f = fixture();
  const { item } = f.download();
  assert.equal(f.progress.at(-1), 0.25);
  item.received = 75;
  item.emit("updated", {}, "progressing");
  assert.equal(f.progress.at(-1), 0.75);
  item.emit("done", {}, "completed");
  assert.deepEqual(f.finished, ["/downloads/game.zip"]);
  assert.equal(f.progress.at(-1), null);
  assert.equal(item.listenerCount("updated"), 0);
});

test("unknown lengths are indeterminate and concurrent completion retains progress", () => {
  const f = fixture();
  const a = f.download().item;
  a.total = 0;
  a.emit("updated", {}, "progressing");
  assert.equal(f.progress.at(-1), -1);
  const b = f.download().item;
  a.emit("done", {}, "completed");
  assert.equal(f.progress.at(-1), 0.25);
  b.emit("done", {}, "cancelled");
  assert.equal(f.progress.at(-1), null);
  assert.deepEqual(f.failed, []);
});

test("interrupted transfers report failure without claiming a saved file", () => {
  const f = fixture();
  f.download().item.emit("done", {}, "interrupted");
  assert.equal(f.failed.length, 1);
  assert.deepEqual(f.finished, []);
});

test("HTML API responses are rejected before saving", () => {
  const f = fixture();
  const { item, prevented } = f.download("text/html; charset=utf-8");
  assert.equal(prevented, true);
  assert.match(f.failed[0]!, /Sign in/);
  assert.equal(item.listenerCount("done"), 0);
});

test("shared-session downloads from other windows are left alone", () => {
  const f = fixture();
  const { item, prevented } = f.download("text/html", {} as WebContents);
  assert.equal(prevented, false);
  assert.equal(item.listenerCount("done"), 0);
  assert.deepEqual(f.progress, []);
  assert.deepEqual(f.failed, []);
});

test("closing the owning window removes session and item listeners", () => {
  const f = fixture();
  const { item } = f.download();
  f.stop();
  assert.equal(f.session.listenerCount("will-download"), 0);
  assert.equal(item.listenerCount("updated"), 0);
  assert.equal(item.listenerCount("done"), 0);
  assert.equal(f.progress.at(-1), null);
});
