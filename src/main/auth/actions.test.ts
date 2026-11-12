import assert from "node:assert/strict";
import { test } from "node:test";
import { PairingActions } from "./actions.ts";

test("unpair requested during pairing runs afterwards with its original context", async () => {
  let approve!: () => void;
  const approval = new Promise<void>((resolve) => { approve = resolve; });
  const seen: string[] = [];
  let credential = false;
  const actions = new PairingActions<{ action: string; server: string; window: string }>(async (request) => {
    seen.push(`${request.action}:${request.server}:${request.window}`);
    if (request.action === "pair") { await approval; credential = true; }
    else credential = false;
  });
  const pair = actions.submit({ action: "pair", server: "one", window: "first" });
  const unpair = actions.submit({ action: "unpair", server: "one", window: "second" });
  await Promise.resolve();
  assert.deepEqual(seen, ["pair:one:first"]);
  approve();
  await Promise.all([pair, unpair]);
  assert.deepEqual(seen, ["pair:one:first", "unpair:one:second"]);
  assert.equal(credential, false);
});

test("failed or cancelled pairing still drains the next action", async () => {
  const seen: string[] = [];
  const actions = new PairingActions<string>(async (request) => {
    seen.push(request);
    if (request === "pair") throw new Error("cancelled");
  });
  const pair = actions.submit("pair");
  const unpair = actions.submit("unpair");
  await assert.rejects(pair, /cancelled/);
  await unpair;
  assert.deepEqual(seen, ["pair", "unpair"]);
});
