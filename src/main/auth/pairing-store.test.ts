import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installIdentifier, pairingFile, readPairing, savePairing, type SecretCodec } from "./pairing-store.ts";

// Exercise ciphertext IO with authenticated encryption. Runtime uses OS-backed
// safeStorage instead; this fixture needs neither Electron nor an OS keyring.
function codec(): SecretCodec {
  const key = randomBytes(32);
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decrypt(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}

test("pairings persist as owner-only ciphertext, scoped to an origin and encryption key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "romm-pairing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = codec();
  const record = { server: "https://romm.test", userId: 7, tokenId: 2, token: "rmm_secret", deviceId: "device", expiresAt: null };
  await savePairing(root, record, secret);
  const file = pairingFile(root, record.server);
  assert.equal((await readFile(file)).includes("rmm_secret"), false);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readPairing(root, record.server, secret), record);
  assert.equal(await readPairing(root, "https://other.test", secret), null);
  assert.equal(await readPairing(root, record.server, codec()), null);
  await writeFile(file, "corrupt");
  assert.equal(await readPairing(root, record.server, secret), null);
  assert.equal(await installIdentifier(root), await installIdentifier(root));
});
