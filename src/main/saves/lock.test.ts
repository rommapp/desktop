import assert from "node:assert/strict";
import { test } from "node:test";

import { inTurn, PendingRomWork, saveSyncKey } from "./lock.ts";

/** A promise with its settle functions, for holding a turn open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a second turn does not start until the first has finished", async () => {
  const first = deferred<string>();
  const order: string[] = [];

  const a = inTurn("save", async () => {
    order.push("a:start");
    const value = await first.promise;
    order.push("a:end");
    return value;
  });
  const b = inTurn("save", async () => {
    order.push("b:start");
    return "b";
  });

  // The push is still on the wire, so the relaunch has not read the file yet.
  await Promise.resolve();
  assert.deepEqual(order, ["a:start"]);

  first.resolve("a");
  assert.equal(await a, "a");
  assert.equal(await b, "b");
  assert.deepEqual(order, ["a:start", "a:end", "b:start"]);
});

test("two turns taken in the same tick queue rather than both going first", async () => {
  // The registration has to happen before any await inside the work can yield,
  // or an exit and the relaunch that follows it both decide the file is theirs.
  let live = 0;
  let most = 0;

  const runs = [1, 2, 3].map(() =>
    inTurn("save", async () => {
      live += 1;
      most = Math.max(most, live);
      await Promise.resolve();
      live -= 1;
    }),
  );

  await Promise.all(runs);
  assert.equal(most, 1);
});

test("a turn that throws still hands the file on", async () => {
  const failed = inTurn("save", () =>
    Promise.reject(new Error("upload cut off")),
  );
  await assert.rejects(failed, /upload cut off/);

  // The next launch inherits the file, not the failure.
  assert.equal(await inTurn("save", () => Promise.resolve("pulled")), "pulled");
});

test("different saves do not wait for each other", async () => {
  const held = deferred<void>();
  const slow = inTurn("one", () => held.promise);

  // Two games can be open at once, and one game's upload is not the other's.
  assert.equal(await inTurn("two", () => Promise.resolve("done")), "done");

  held.resolve();
  await slow;
});

test("a selected disc pull waits for the playlist upload to update the server", async () => {
  const upload = deferred<void>();
  let server = "old";
  const key = saveSyncKey("https://romm.example", 42);
  const push = inTurn(key, async () => {
    await upload.promise;
    server = "playlist progress";
  });
  let pulled: string | null = null;
  const pull = inTurn(saveSyncKey("https://romm.example", 42), async () => {
    pulled = server;
  });
  await Promise.resolve();
  assert.equal(pulled, null);
  assert.notEqual(key, saveSyncKey("https://romm.example", 43));
  assert.notEqual(key, saveSyncKey("https://other.example", 42));
  upload.resolve();
  await Promise.all([push, pull]);
  assert.equal(pulled, "playlist progress");
});

test("relaunch waits even before exit work has queued its upload", async () => {
  const pending = new PendingRomWork();
  const watcher = deferred<void>();
  const order: string[] = [];
  const exit = (async () => {
    await watcher.promise;
    order.push("uploaded");
  })();
  pending.track(42, exit);
  const launch = pending.wait(42).then(() => order.push("pull"));
  await pending.wait(43);
  assert.deepEqual(order, []);
  watcher.resolve();
  await launch;
  assert.deepEqual(order, ["uploaded", "pull"]);
});
