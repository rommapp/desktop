// A paired credential belongs to native requests, never to the remote page's
// cookie jar. Use an in-memory session with a gate on every outbound request,
// including redirects. Cookie authentication takes priority on RomM, so strip
// cookies as well as limiting where the bearer may be sent.

import { app, safeStorage, session as electronSession, type Session } from "electron";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { mayUsePairing, pairedHeaders, type PairingRecord } from "./pairing.ts";
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

export async function nativeSession(server: string, browser: Session, signal?: AbortSignal): Promise<Session> {
  let record: PairingRecord | null;
  try {
    const codec = secretCodec();
    if (!codec) return browser;
    record = await readPairing(pairingRoot(), server, codec);
  } catch { return browser; }
  if (!record) return browser;
  // Bind a launch to its initiating account. A different signed-in account
  // continues using its own cookie session; a signed-out window can use the
  // paired account. Unknown identity is never taken as proof of sign-out.
  try {
    const response = await browser.fetch(new URL("/api/users/me", server).toString(), {
      credentials: "include", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
    });
    const user: unknown = response.status === 200 ? await response.json() : null;
    if (!mayUsePairing(response.status, user, record.userId)) return browser;
  } catch (error) { if (signal?.aborted) throw error; return browser; }
  return createPairedSession(record);
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
