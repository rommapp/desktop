import assert from "node:assert/strict";
import { test } from "node:test";
import { isSpikeMode, spikeScript } from "./spike.ts";

test("isSpikeMode only triggers on the explicit flag", () => {
  assert.equal(isSpikeMode(["electron", ".", "--spike"]), true);
  assert.equal(isSpikeMode(["electron", "."]), false);
  assert.equal(isSpikeMode([]), false);
});

test("the injected script is syntactically valid", () => {
  assert.doesNotThrow(() => new Function(spikeScript()));
});

test("the injected route regex survives template-literal escaping", () => {
  const line = spikeScript()
    .split("\n")
    .find((l) => l.includes("location.pathname.match"));
  assert.ok(line, "route matcher is present");

  const pattern = line.match(/match\((\/.*\/)\)/)?.[1];
  assert.ok(pattern, "route matcher is a regex literal");
  const route = new RegExp(pattern.slice(1, -1));

  assert.equal("/rom/42".match(route)?.[1], "42");
  assert.equal("/rom/1234/ejs".match(route)?.[1], "1234");
  assert.equal("/platform/3".match(route), null);
});

test("the script bails out rather than duplicating its panel", () => {
  const script = spikeScript();
  assert.match(script, /getElementById\(ID\)\) return "already-injected"/);
  assert.match(script, /if \(!window\.rommNative\) return "no-bridge"/);
});

test("the panel can cancel an in-flight download", () => {
  const script = spikeScript();
  assert.match(script, /window\.rommNative\.cancel\(rom\.id\)/);
  // The cancel control must start hidden, or it shows with nothing to cancel.
  assert.match(script, /cancel\.hidden = true/);
});

test("a cancelled launch is not reported as a failure", () => {
  const script = spikeScript();
  // launch() rejects on cancel and the state handler also fires, so both paths
  // have to check the flag or one overwrites the other with "Failed".
  assert.match(script, /cancelling \? "Cancelled\."/);
  assert.match(script, /if \(!cancelling\) say/);
});

test("the panel reports speed and remaining time, not just a percentage", () => {
  const script = spikeScript();
  assert.match(script, /s\.bytesPerSecond/);
  assert.match(script, /" left"/);
  // The formatters have to tolerate a server that declares no length.
  assert.match(script, /if \(n === undefined \|\| n === null\) return ""/);
});
