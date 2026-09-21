import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { onBeat } from "./beat.ts";

/** A promise with its settle function, for holding a look open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every microtask that is ready run, which is what a tick of the mocked
 *  clock cannot do on its own: the work is async. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test("a look that outlasts its interval skips the beats it overran", async () => {
  // Otherwise a slow upload leaves a queue of looks nothing is draining, and
  // the moment it finishes the queue runs end to end, hashing the save as fast
  // as the disk allows instead of at the interval it was given.
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const slow = deferred<void>();
    let looks = 0;

    const beat = onBeat(10, async () => {
      looks += 1;
      if (looks === 1) await slow.promise;
      return true;
    });

    mock.timers.tick(10);
    await drain();
    assert.equal(looks, 1);

    // Five intervals pass while the first look is still going.
    mock.timers.tick(50);
    await drain();
    assert.equal(looks, 1, "beats fired while a look was underway");

    slow.resolve();
    await drain();
    assert.equal(looks, 1, "the skipped beats ran back to back");

    mock.timers.tick(10);
    await drain();
    assert.equal(looks, 2);

    await beat.stop();
  } finally {
    mock.timers.reset();
  }
});

test("stopping waits for the look already underway", async () => {
  // The quit is held for this: a save on the wire when the emulator exits has
  // to land before the shell forgets it was sending one.
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const slow = deferred<void>();
    let finished = false;

    const beat = onBeat(10, async () => {
      await slow.promise;
      finished = true;
      return true;
    });

    mock.timers.tick(10);
    await drain();

    let stopped = false;
    const stopping = beat.stop().then(() => {
      stopped = true;
    });
    await drain();
    assert.equal(stopped, false);

    slow.resolve();
    await stopping;
    assert.equal(finished, true);
  } finally {
    mock.timers.reset();
  }
});

test("work that has said everything ends its own beat", async () => {
  // How the watcher stops itself once the slot it was offering saves to has
  // moved on under the run.
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let looks = 0;
    const beat = onBeat(10, async () => {
      looks += 1;
      return false;
    });

    mock.timers.tick(30);
    await drain();
    assert.equal(looks, 1);

    await beat.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a look that throws is not the end of the beat", async () => {
  // The next look is another chance at whatever failed, and a failed upload is
  // not a reason to stop watching a game that is still running.
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let looks = 0;
    const beat = onBeat(10, async () => {
      looks += 1;
      if (looks === 1) throw new Error("the wire went away");
      return true;
    });

    mock.timers.tick(10);
    await drain();
    mock.timers.tick(10);
    await drain();
    assert.equal(looks, 2);

    await beat.stop();
  } finally {
    mock.timers.reset();
  }
});
