import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVICE_SCOPES, mayUsePairing, pairedHeaders, pairDevice, readPairingRecord } from "./pairing.ts";

const server = "https://romm.test";
const challenge = { device_code: "a".repeat(64), user_code: "ABCDEFGH", expires_in: 600, interval: 5 };
const token = { id: 1, access_token: "rmm_secret", device_id: "device-7", expires_at: null };

function fixture(replies: { status: number; body: unknown }[]) {
  let time = 0;
  const calls: { path: string; body: unknown }[] = [];
  const delays: number[] = [];
  const shown: string[] = [];
  const controller = new AbortController();
  return {
    calls, delays, shown, controller,
    options: {
      server, metadata: { client: "desktop" }, signal: controller.signal,
      now: () => time,
      pause: async (ms: number) => { delays.push(ms); time += ms; },
      show: async (code: string, url: string) => { shown.push(code, url); },
      request: async (path: string, body: unknown) => {
        calls.push({ path, body });
        const reply = replies.shift();
        assert.ok(reply, "unexpected pairing request");
        return reply;
      },
    },
  };
}

test("pairing requests explicit scopes and exchanges only after the server cadence", async () => {
  const f = fixture([
    { status: 201, body: { ...challenge, verification_path_complete: "https://evil.test/steal" } },
    { status: 400, body: { detail: "authorization_pending" } },
    { status: 400, body: { detail: "slow_down" } },
    { status: 429, body: null },
    { status: 200, body: token },
  ]);
  assert.deepEqual(await pairDevice(f.options), {
    server, token: "rmm_secret", tokenId: 1, deviceId: "device-7", expiresAt: null,
  });
  assert.deepEqual(f.delays, [5000, 5000, 10000, 15000]);
  assert.deepEqual(f.shown, ["ABCDEFGH", `${server}/pair/device?user_code=ABCDEFGH`]);
  assert.deepEqual(f.calls[0], { path: "/api/auth/device/init", body: { client: "desktop", requested_scopes: DEVICE_SCOPES } });
  assert.deepEqual(f.calls[1], { path: "/api/auth/device/token", body: { device_code: challenge.device_code } });
});

test("denied, expired and unsupported pairing never produce a credential", async () => {
  for (const detail of ["access_denied", "expired_token"]) {
    const f = fixture([{ status: 201, body: challenge }, { status: 400, body: { detail } }]);
    await assert.rejects(pairDevice(f.options), detail === "access_denied" ? /denied/ : /expired/);
  }
  await assert.rejects(pairDevice(fixture([{ status: 404, body: null }]).options), /HTTP 404/);
  const f = fixture([{ status: 201, body: { ...challenge, expires_in: 1 } }]);
  await assert.rejects(pairDevice(f.options), /expired/);
  assert.equal(f.calls.length, 1);
});

test("cancellation stops polling, and invalid challenge values are refused", async () => {
  const f = fixture([{ status: 201, body: challenge }]);
  f.options.pause = async () => { f.controller.abort(); };
  await assert.rejects(pairDevice(f.options), { name: "AbortError" });
  assert.equal(f.calls.length, 1);
  for (const patch of [{ interval: 0 }, { expires_in: 601 }, { user_code: "<script>" }, { device_code: "bad" }]) {
    await assert.rejects(pairDevice(fixture([{ status: 201, body: { ...challenge, ...patch } }]).options), /Invalid/);
  }
});

test("paired account selection requires the same signed-in user or explicit sign-out", () => {
  assert.equal(mayUsePairing(200, { id: 7 }, 7), true);
  assert.equal(mayUsePairing(401, null, 7), true);
  for (const [status, body] of [[200, { id: 8 }], [200, null], [403, null], [500, null]] as const) {
    assert.equal(mayUsePairing(status, body, 7), false);
  }
});

test("bearer headers are API-only and never combined with cookie auth", () => {
  assert.deepEqual(pairedHeaders(`${server}/api/saves`, server, "rmm_secret", {
    Cookie: "other-user", authorization: "old", "X-CSRFToken": "old", "Content-Type": "application/json",
  }), { "Content-Type": "application/json", Authorization: "Bearer rmm_secret" });
  for (const url of ["https://evil.test/api/saves", `${server}/login`, `${server}:443.evil/api/roms`,
    "http://romm.test/api/saves", "https://user@romm.test/api/saves", "data:text/plain,test", "bad-url"]) {
    assert.equal(pairedHeaders(url, server, "rmm_secret", {}), null);
  }
});

test("stored credentials reject foreign servers, malformed tokens and invalid owners", () => {
  const record = { server, userId: 7, deviceId: "device", tokenId: 2, token: "rmm_secret", expiresAt: null };
  assert.deepEqual(readPairingRecord(record, server), record);
  for (const patch of [{ server: "https://evil.test" }, { userId: 0 }, { token: "rmm_secret\r\nInjected: true" },
    { tokenId: -1 }, { deviceId: "" }, { expiresAt: "not a date" }]) {
    assert.throws(() => readPairingRecord({ ...record, ...patch }, server));
  }
});
