// Store only ciphertext, one file per server. Encryption is supplied by the
// main process's OS-backed safeStorage; callers must refuse insecure backends.
// Atomic replacement keeps an interrupted re-pair from destroying a usable key.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPairingRecord, type PairingRecord } from "./pairing.ts";

export interface SecretCodec {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export function pairingFile(root: string, server: string): string {
  return join(root, `${createHash("sha256").update(new URL(server).origin).digest("hex")}.bin`);
}

export async function readPairing(root: string, server: string, codec: SecretCodec): Promise<PairingRecord | null> {
  try {
    return readPairingRecord(JSON.parse(codec.decrypt(await readFile(pairingFile(root, server)))), server);
  } catch { return null; }
}

export async function savePairing(root: string, record: PairingRecord, codec: SecretCodec): Promise<void> {
  readPairingRecord(record, record.server);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = pairingFile(root, record.server);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, codec.encrypt(JSON.stringify(record)), { mode: 0o600, flag: "wx" });
    await rename(temp, target);
  } finally { await rm(temp, { force: true }); }
}

export async function installIdentifier(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "install-id");
  try { await writeFile(path, randomUUID(), { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const identifier = await readFile(path, "utf8");
  if (!/^[a-f0-9-]{36}$/.test(identifier)) throw new Error("Invalid desktop install identifier.");
  return identifier;
}
