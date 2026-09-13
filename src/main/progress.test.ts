import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgressGate, createRateMeter } from "./progress.ts";

/** A clock the test moves by hand, so nothing waits on real time. */
function fakeClock(start = 1_000) {
  let value = start;
  return { now: () => value, advance: (ms: number) => (value += ms) };
}

test("the first update always passes", () => {
  const clock = fakeClock();
  const gate = createProgressGate(100, clock.now);
  assert.equal(gate(0), true);
});

test("a burst inside one interval collapses to a single update", () => {
  const clock = fakeClock();
  const gate = createProgressGate(100, clock.now);
  assert.equal(gate(0.01), true);

  let passed = 0;
  for (let i = 0; i < 5_000; i++) {
    clock.advance(0);
    if (gate(0.01 + i / 1_000_000)) passed++;
  }
  assert.equal(passed, 0, "no further update should pass within the interval");
});

test("an update passes once the interval has elapsed", () => {
  const clock = fakeClock();
  const gate = createProgressGate(100, clock.now);
  gate(0.1);

  clock.advance(99);
  assert.equal(gate(0.2), false);
  clock.advance(1);
  assert.equal(gate(0.3), true);
});

test("a completed transfer is never throttled away", () => {
  const clock = fakeClock();
  const gate = createProgressGate(100, clock.now);
  gate(0.5);
  clock.advance(1);
  assert.equal(gate(1), true, "100% must reach the renderer");
});

test("progress of unknown size is still rate limited", () => {
  const clock = fakeClock();
  const gate = createProgressGate(100, clock.now);
  assert.equal(gate(undefined), true);
  assert.equal(gate(undefined), false);
  clock.advance(100);
  assert.equal(gate(undefined), true);
});

test("the rate meter has nothing to report from a single sample", () => {
  const clock = fakeClock();
  const rate = createRateMeter(2_000, clock.now);
  assert.equal(rate(0), undefined);
});

test("the rate meter converges on a steady transfer speed", () => {
  const clock = fakeClock();
  const rate = createRateMeter(2_000, clock.now);

  // 1MB every 100ms is 10MB/s.
  const MB = 1024 * 1024;
  let received = 0;
  let reported: number | undefined;
  rate(received);
  for (let i = 0; i < 200; i++) {
    clock.advance(100);
    received += MB;
    reported = rate(received);
  }

  assert.ok(reported !== undefined, "a rate should be reported");
  const mbPerSecond = reported / MB;
  assert.ok(
    Math.abs(mbPerSecond - 10) < 0.1,
    `expected about 10MB/s, got ${mbPerSecond.toFixed(2)}`,
  );
});

test("the rate meter smooths rather than tracking each sample", () => {
  const clock = fakeClock();
  const rate = createRateMeter(2_000, clock.now);
  const MB = 1024 * 1024;

  let received = 0;
  rate(received);
  for (let i = 0; i < 100; i++) {
    clock.advance(100);
    received += MB;
    rate(received);
  }

  // One stalled interval should dent the figure, not zero it.
  clock.advance(100);
  const afterStall = rate(received);
  assert.ok(afterStall !== undefined);
  const mbPerSecond = afterStall / MB;
  assert.ok(
    mbPerSecond > 5 && mbPerSecond < 10,
    `a single stalled sample should dent the rate, got ${mbPerSecond.toFixed(2)}`,
  );
});

test("the rate meter ignores samples that share a timestamp", () => {
  const clock = fakeClock();
  const rate = createRateMeter(2_000, clock.now);
  rate(0);
  clock.advance(100);
  const first = rate(1_000);
  assert.equal(rate(2_000), first, "no elapsed time means no new measurement");
});
