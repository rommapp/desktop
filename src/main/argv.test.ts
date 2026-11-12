import assert from "node:assert/strict";
import { test } from "node:test";
import { isSetupMode } from "./argv.ts";

test("isSetupMode only triggers on the explicit flag", () => {
  assert.equal(isSetupMode(["electron", ".", "--setup"]), true);
  assert.equal(isSetupMode(["electron", "."]), false);
  assert.equal(isSetupMode([]), false);
});

test("isSetupMode does not match a flag that merely starts with it", () => {
  assert.equal(isSetupMode(["electron", ".", "--setup-window"]), false);
});

test("pairing requires explicit flags and unpair takes precedence", async () => {
  const { pairingAction } = await import("./argv.ts");
  assert.equal(pairingAction(["--pair"]), "pair");
  assert.equal(pairingAction(["--unpair"]), "unpair");
  assert.equal(pairingAction(["--pair", "--unpair"]), "unpair");
  assert.equal(pairingAction(["--pairing"]), null);
});
