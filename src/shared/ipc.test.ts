import assert from "node:assert/strict";
import { test } from "node:test";
import { replyWith, toLaunchError } from "./ipc.ts";
import { LaunchError } from "./types.ts";

test("a value comes back as itself", async () => {
  assert.deepEqual(await replyWith(() => ({ romId: 7, emulator: "RPCS3" })), {
    ok: true,
    value: { romId: 7, emulator: "RPCS3" },
  });
});

test("a handler that returns nothing still answers", async () => {
  assert.deepEqual(await replyWith(() => {}), { ok: true, value: undefined });
});

test("a failure crosses as data rather than as a rejection", async () => {
  // The whole point. Rejecting out of the handler would have Electron
  // stringify this into the renderer's message, which is where the channel
  // name and the class name came from, and the code would not arrive at all.
  const message = `RomM Desktop cannot guess where RPCS3 ends up, so it has to be told. Point at it under "emulators" in the settings, then press Play again.`;
  const reply = await replyWith(() => {
    throw new LaunchError("emulator-not-found", message);
  });

  assert.deepEqual(reply, {
    ok: false,
    error: { code: "emulator-not-found", message },
  });
  assert.ok(!reply.ok && reply.error.message === message);
  assert.doesNotMatch(message, /Error invoking remote method/);
  assert.doesNotMatch(message, /LaunchError/);
});

test("an error that is not a LaunchError still arrives as one", async () => {
  const reply = await replyWith(() => {
    throw new TypeError("spawn ENOENT");
  });
  assert.deepEqual(reply, {
    ok: false,
    error: { code: "launch-failed", message: "spawn ENOENT" },
  });
});

test("a rejected promise is answered, not left to reject", async () => {
  const reply = await replyWith(() =>
    Promise.reject(new LaunchError("download-failed", "Launch cancelled")),
  );
  assert.deepEqual(reply, {
    ok: false,
    error: { code: "download-failed", message: "Launch cancelled" },
  });
});

test("toLaunchError keeps a LaunchError as it is", () => {
  const original = new LaunchError("already-running", "Mario is running.");
  assert.equal(toLaunchError(original), original);
});

test("toLaunchError gives a code to something thrown that is not an error", () => {
  const coerced = toLaunchError("not an error");
  assert.equal(coerced.code, "launch-failed");
  assert.equal(coerced.message, "not an error");
});
