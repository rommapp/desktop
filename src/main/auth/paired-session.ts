// A paired credential belongs to native requests, never to the remote page's
// cookie jar. Use an in-memory session with a gate on every outbound request,
// including redirects. Cookie authentication takes priority on RomM, so strip
// cookies as well as limiting where the bearer may be sent.

import { app, safeStorage, session as electronSession, type Session } from "electron";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LaunchError } from "../../shared/types.ts";
import { loadConfig } from "../config.ts";
import { requirePairing, mayUsePairing, pairedHeaders, type PairingRecord } from "./pairing.ts";
import { readPairing, type SecretCodec } from "./pairing-store.ts";

const credentials = new WeakMap<Session, PairingRecord>();
export function pairedIdentity(session: Session): PairingRecord | undefined {
  return credentials.get(session);
}
export function pairingRoot(): string { return join(app.getPath("userData"), "pairings"); }
export function secretCodec(): SecretCodec | null {
  if (!safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) return null;
  return { encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) };
}

export async function storedPairing(server: string): Promise<PairingRecord | null> {
  const codec = secretCodec();
  return codec ? readPairing(pairingRoot(), server, codec) : null;
}

export async function nativeSession(server: string, browser: Session, signal?: AbortSignal): Promise<Session> {
  const codec = secretCodec();
  const record = requirePairing(codec ? await readPairing(pairingRoot(), server, codec) : null, Boolean(codec));
  // The browser identifies what account is asking to play. A different or
  // unknown account blocks native work instead of changing credentials.
  let status: number;
  let user: unknown;
  try {
    const response = await browser.fetch(new URL("/api/users/me", server).toString(), {
      credentials: "include", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
    });
    status = response.status;
    user = status === 200 ? await response.json() : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new LaunchError("launch-failed", "Could not verify the browsing account. Check your connection and try again.");
  }
  if (!mayUsePairing(status, user, record.userId)) {
    throw new LaunchError("launch-failed", status === 200
      ? "This desktop is paired with a different account. Sign in as the paired account or restart with --pair."
      : "Could not verify the browsing account. Check your connection and try again.");
  }
  const target = createPairedSession(record);
  try {
    const response = await target.fetch(new URL("/api/users/me", server).toString(), {
      credentials: "omit", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
    });
    if (response.status === 401) throw new LaunchError("launch-failed", "Device pairing expired or was revoked. Restart with --pair to reconnect.");
    const owner = response.ok ? await response.json() as { id?: unknown } : null;
    if (owner?.id !== record.userId) throw new LaunchError("launch-failed", "The paired account could not be verified. Restart with --pair to reconnect.");
  } catch (error) {
    if (signal?.aborted || error instanceof LaunchError) throw error;
    throw new LaunchError("launch-failed", "Could not verify device pairing. Check your connection and try again.");
  }
  return target;
}

/** Shared by launches and the runtime transport check; never used by a renderer. */
export function createPairedSession(record: PairingRecord): Session {
  const key = createHash("sha256").update(record.server + record.token).digest("hex");
  const target = electronSession.fromPartition(`romm-native-${key}`, { cache: false });
  if (!credentials.has(target)) {
    // Trust the same explicitly remembered LAN certificate as the browsing
    // window. A private partition otherwise has no window to answer its prompt.
    target.setCertificateVerifyProc((request, callback) => {
      void loadConfig().then((config) => {
        const trusted = request.hostname === new URL(record.server).hostname &&
          config.trustedCertificates.includes(request.certificate.fingerprint);
        callback(trusted ? 0 : -3);
      }).catch(() => callback(-3));
    });
    const filter = { urls: ["<all_urls>"] };
    target.webRequest.onBeforeRequest(filter, (details, callback) => {
      callback({ cancel: pairedHeaders(details.url, record.server, record.token, {}) === null });
    });
    target.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const headers = pairedHeaders(details.url, record.server, record.token, details.requestHeaders);
      callback(headers ? { requestHeaders: headers } : { cancel: true });
    });
    credentials.set(target, record);
  }
  return target;
}
