import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgressGate } from "./progress.ts";

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
