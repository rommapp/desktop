// Pairing is an explicit native action, independent of the server frontend's
// version. This local window contains only a public code and an approval link;
// the secret device code and resulting bearer never enter a renderer.

import { app, BrowserWindow, dialog, shell } from "electron";
import { hostname, platform } from "node:os";
import { rm } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { DEVICE_CAPABILITIES, pairDevice, readPairingRecord } from "./pairing.ts";
import { installIdentifier, pairingFile, savePairing } from "./pairing-store.ts";
import { loadConfig } from "../config.ts";
import { pairingRoot, secretCodec } from "./paired-session.ts";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export async function pairDesktop(parent: BrowserWindow, server: string, forget = false): Promise<void> {
  let window: BrowserWindow | null = null;
  const controller = new AbortController();
  const closed = () => controller.abort();
  parent.once("closed", closed);
  try {
    if (forget) {
      await rm(pairingFile(pairingRoot(), server), { force: true });
      await dialog.showMessageBox(parent, {
        message: "Local pairing removed.",
        detail: "Native play is disabled until this desktop is paired again. Revoke the client token in RomM's settings to remove its server-side access too. Existing runs keep their original credentials until they finish.",
      });
      return;
    }
    const codec = secretCodec();
    if (!codec) throw new Error("Secure credential storage is unavailable. Enable your OS keychain and try pairing again. Browsing still works, but native play requires pairing.");
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
    const request = async (path: string, body: unknown) => {
      const response = await parent.webContents.session.fetch(new URL(path, server).toString(), {
        method: "POST", credentials: "omit", redirect: "error",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      return { status: response.status, body: await response.json().catch(() => null) as unknown };
    };
    const result = await pairDevice({
      server,
      metadata: {
        client_device_identifier: await installIdentifier(pairingRoot()),
        name: `RomM Desktop on ${hostname()}`.slice(0, 255),
        client: "desktop", platform: platform(), client_version: app.getVersion(),
      },
      request,
      signal,
      now: Date.now,
      pause: async (ms) => { await pause(ms, undefined, { signal }); },
      show: async (code, url) => {
        window = new BrowserWindow({
          parent, width: 560, height: 340, title: "Pair RomM Desktop", autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        window.once("closed", closed);
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        window.webContents.setWindowOpenHandler((details) => {
          if (details.url === url) void shell.openExternal(url);
          return { action: "deny" };
        });
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Pair RomM Desktop</title><style>body{font:16px system-ui;padding:28px;background:#10121a;color:#e8eaf2}a{color:#aeb6ff}strong{font-size:28px;letter-spacing:4px}</style></head><body><h2>Pair this desktop</h2><p>Open your server's pairing page and approve this code:</p><p><strong>${code}</strong></p><p><a href="${escapeHtml(url)}" target="_blank">Open pairing page on ${escapeHtml(new URL(server).host)}</a></p><p>This window closes after approval. Close it to cancel.</p></body></html>`)}`);
      },
    });
    // The account id is derived from the issued bearer alone, never from the
    // browsing session, which may have changed during out-of-band approval.
    const response = await parent.webContents.session.fetch(new URL("/api/users/me", server).toString(), {
      credentials: "omit", redirect: "error", headers: { Authorization: `Bearer ${result.token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error("The approved token cannot read its account. Include me.read when approving, then pair again.");
    const user = await response.json() as { id?: unknown };
    const record = readPairingRecord({ ...result, userId: user.id }, server);
    await savePairing(pairingRoot(), record, codec);
    // Approval creates the bound device; declare supported operations without
    // registering a second fingerprint-based row. Metadata failure is nonfatal.
    await parent.webContents.session.fetch(new URL(`/api/devices/${encodeURIComponent(record.deviceId)}`, server).toString(), {
      method: "PUT", credentials: "omit", redirect: "error",
      headers: { Authorization: `Bearer ${record.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sync_mode: "api", capabilities: { ...DEVICE_CAPABILITIES, remote_install: (await loadConfig()).acceptRemoteInstalls !== false } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }).catch(() => undefined);
    if (window && !(window as BrowserWindow).isDestroyed()) (window as BrowserWindow).close();
    if (!parent.isDestroyed()) await dialog.showMessageBox(parent, {
      message: "Desktop paired.", detail: "Native requests now use this device's client token. The browsing window keeps its own sign-in.",
    });
  } catch (error) {
    if (!controller.signal.aborted && !parent.isDestroyed()) await dialog.showMessageBox(parent, {
      type: "error", message: "Pairing did not complete.",
      detail: error instanceof Error && error.name !== "AbortError" ? error.message : "The pairing request timed out. Try again.",
    });
  } finally {
    parent.removeListener("closed", closed);
    if (window && !(window as BrowserWindow).isDestroyed()) (window as BrowserWindow).close();
    controller.abort();
  }
}
