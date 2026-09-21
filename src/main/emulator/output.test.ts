import assert from "node:assert/strict";
import { test } from "node:test";

import { createLineSink, splitLines } from "./output.ts";

test("a line split across two chunks is reported once, whole", () => {
  // A stream hands over bytes, not lines: holding the tail is the only way the
  // save path RetroArch names arrives as one string.
  const first = splitLines("", "[INFO] SRAM will be saved");
  assert.deepEqual(first.lines, []);

  const second = splitLines(
    first.rest,
    ' to: "/saves/game.srm"\n[INFO] next\n',
  );
  assert.deepEqual(second.lines, [
    '[INFO] SRAM will be saved to: "/saves/game.srm"',
    "[INFO] next",
  ]);
  assert.equal(second.rest, "");
});

test("blank lines and Windows endings are not lines of their own", () => {
  const { lines, rest } = splitLines("", "one\r\n\r\ntwo\r\n");
  assert.deepEqual(lines, ["one", "two"]);
  assert.equal(rest, "");
});

test("the capture stops at its limit and says that it did", () => {
  // An emulator writes a line per frame drop, and a log nobody can find the
  // launch in is no better than no log.
  const seen: string[] = [];
  const sink = createLineSink((line) => seen.push(line), 2);

  sink.write("a\nb\nc\nd\n");

  assert.deepEqual(seen, ["a", "b", "... capped at 2 lines"]);
});

test("a stream that ends mid-line still reports it", () => {
  const seen: string[] = [];
  const sink = createLineSink((line) => seen.push(line));

  sink.write("done\nhalf");
  sink.end();
  sink.end();

  assert.deepEqual(seen, ["done", "half"]);
});
