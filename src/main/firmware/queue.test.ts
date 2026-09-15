import assert from "node:assert/strict";
import { test } from "node:test";
import { LaunchError } from "../../shared/types.ts";
import { oneAtATime, untilSettledOrCancelled } from "./queue.ts";

/** A promise that settles when the test says so, standing in for a sync that is
 *  still fetching. */
function pending<T>() {
  let settle: (value: T) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

/** A key of its own per test, since the queue is module state. */
let keys = 0;
function key() {
  keys += 1;
  return `/bios/platform-${keys}`;
}

const NEVER_CANCELLED = new AbortController().signal;

test("a second launch takes the running sync's result rather than repeating it", async () => {
  // Two PS1 games started together want the same mirror. Asking the server
  // twice to be told it is already correct is work nobody asked for.
  const first = pending<string>();
  let runs = 0;
  const work = () => {
    runs += 1;
    return first.promise;
  };
  const shared = key();
  const a = oneAtATime(shared, NEVER_CANCELLED, work);
  const b = oneAtATime(shared, NEVER_CANCELLED, work);
  first.settle("mirrored");
  assert.deepEqual(await Promise.all([a, b]), ["mirrored", "mirrored"]);
  assert.equal(runs, 1, "the work runs once for both launches");
});

test("a cancelled launch stops waiting rather than sitting behind the transfer", async () => {
  // Firmware can be a 200MB PS3 PUP. A user who has cancelled should not have
  // to wait out someone else's download to find out.
  const first = pending<string>();
  const shared = key();
  const a = oneAtATime(shared, NEVER_CANCELLED, () => first.promise);
  const controller = new AbortController();
  const b = oneAtATime(shared, controller.signal, () => first.promise);
  controller.abort();
  await assert.rejects(b, (error: unknown) => {
    assert.ok(error instanceof LaunchError);
    assert.equal(error.code, "download-failed");
    assert.match(error.message, /cancelled/i);
    return true;
  });
  // And the sync carries on for the launch that started it.
  first.settle("mirrored");
  assert.equal(await a, "mirrored");
});

test("a waiting launch tries for itself when the running sync fails", async () => {
  // The likeliest failure is the first launch being cancelled, which says
  // nothing about whether this one would have worked.
  const first = pending<string>();
  const shared = key();
  const a = oneAtATime(shared, NEVER_CANCELLED, () => first.promise);
  const b = oneAtATime(shared, NEVER_CANCELLED, () =>
    Promise.resolve("mirrored by the second"),
  );
  first.fail(new Error("the first launch was cancelled"));
  await assert.rejects(a, { message: "the first launch was cancelled" });
  assert.equal(await b, "mirrored by the second");
});

test("a later launch runs again once the first has finished", async () => {
  // The queue holds nothing between launches: firmware can change in RomM
  // between one game and the next.
  const shared = key();
  let runs = 0;
  const work = () => {
    runs += 1;
    return Promise.resolve(runs);
  };
  assert.equal(await oneAtATime(shared, NEVER_CANCELLED, work), 1);
  assert.equal(await oneAtATime(shared, NEVER_CANCELLED, work), 2);
});

test("two platforms do not wait on each other", async () => {
  // A PS1 game and a Saturn game started together are two different mirrors.
  const psx = pending<string>();
  const saturn = pending<string>();
  const waitingOnPsx = oneAtATime(key(), NEVER_CANCELLED, () => psx.promise);
  const waitingOnSaturn = oneAtATime(
    key(),
    NEVER_CANCELLED,
    () => saturn.promise,
  );
  saturn.settle("saturn mirrored");
  assert.equal(await waitingOnSaturn, "saturn mirrored");
  psx.settle("psx mirrored");
  assert.equal(await waitingOnPsx, "psx mirrored");
});

test("a launch cancelled before it ever waited does not wait either", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    untilSettledOrCancelled(pending<string>().promise, controller.signal),
    { code: "download-failed" },
  );
});

test("waiting leaves no abort listener behind on either outcome", async () => {
  // The signal outlives the wait, and one listener per launch on a long-lived
  // signal is a leak that nothing would ever report.
  const controller = new AbortController();
  let listeners = 0;
  const { addEventListener, removeEventListener } = controller.signal;
  Object.assign(controller.signal, {
    addEventListener: (...args: unknown[]) => {
      listeners += 1;
      return (addEventListener as (...a: unknown[]) => void).apply(
        controller.signal,
        args,
      );
    },
    removeEventListener: (...args: unknown[]) => {
      listeners -= 1;
      return (removeEventListener as (...a: unknown[]) => void).apply(
        controller.signal,
        args,
      );
    },
  });

  const settling = pending<string>();
  const resolved = untilSettledOrCancelled(settling.promise, controller.signal);
  settling.settle("done");
  await resolved;
  assert.equal(listeners, 0);

  const failing = pending<string>();
  const rejected = untilSettledOrCancelled(failing.promise, controller.signal);
  failing.fail(new Error("no"));
  await assert.rejects(rejected);
  assert.equal(listeners, 0);
});
