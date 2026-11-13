// RomM supports polling clients explicitly: claiming refreshes online presence
// and returns previously taken requests after a crash. Cancellation is polled
// during transfers; losing contact pauses rather than inventing an outcome.

import { BrowserWindow, type Session } from "electron";
import { setTimeout as pause } from "node:timers/promises";
import type { DesktopConfig } from "../../shared/types.ts";
import { createPairedSession, pairedIdentity, storedPairing } from "../auth/paired-session.ts";
import { DEVICE_CAPABILITIES, requirePairing } from "../auth/pairing.ts";
import { loadConfig } from "../config.ts";
import { downloadFromServer } from "../rom-cache.ts";
import { assertSeparateRoots, resolveDownloadUrl } from "../safety.ts";
import { apiRequest } from "../saves/http.ts";
import { setTransferProgress } from "../window-progress.ts";
import { isServerOrigin } from "../window-policy.ts";
import { readClaims, type InstallRequest } from "./plan.ts";
import { installedRoot, sweepInstallStages } from "./store.ts";
import { processInstall, type Liveness } from "./worker.ts";

const advertised = new WeakMap<Session, boolean>();
const swept = new Set<string>();

export async function runInstallCycle(options: {
  config: DesktopConfig; session: Session; signal: AbortSignal;
  stillCurrent?: () => Promise<boolean>;
}): Promise<void> {
  const { config, session, signal } = options;
  const identity = pairedIdentity(session);
  if (!identity || !config.serverUrl || identity.server !== new URL(config.serverUrl).origin) return;
  assertSeparateRoots(config);
  const serverUrl = identity.server;
  const devicePath = `/api/devices/${encodeURIComponent(identity.deviceId)}`;
  const enabled = config.acceptRemoteInstalls !== false;
  const ask = (path: string, method: "GET" | "POST" | "PUT", body?: unknown, ownerSignal = signal) => apiRequest({
    serverUrl, session, path, method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.any([ownerSignal, AbortSignal.timeout(10_000)]),
  });
  if (advertised.get(session) !== enabled) {
    const updated = await ask(devicePath, "PUT", { sync_mode: "api", capabilities: { ...DEVICE_CAPABILITIES, remote_install: enabled } });
    if (!updated || updated.status >= 300) throw new Error("Could not advertise install capabilities");
    advertised.set(session, enabled);
  }
  if (!enabled) return;
  const root = installedRoot(config, identity.userId);
  if (!swept.has(root)) { await sweepInstallStages(root); swept.add(root); }
  const claim = await ask(`${devicePath}/installs/claim`, "POST");
  if (!claim || claim.status !== 200) throw new Error(`Install claim unavailable (${claim?.status ?? "offline"})`);
  const requests = readClaims(claim.body, identity.userId, identity.deviceId);
  let lastPresence = Date.now();
  for (const request of requests) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const workSignal = AbortSignal.any([signal, controller.signal]);
    let lastCheck = 0;
    let live: Liveness = "unknown";
    const check = async (): Promise<Liveness> => {
      if (Date.now() - lastCheck < 1000) return live;
      if (options.stillCurrent && !(await options.stillCurrent())) return "unknown";
      const refresh = Date.now() - lastPresence >= 30_000;
      const response = await ask(`${devicePath}/installs${refresh ? "/claim" : ""}`, refresh ? "POST" : "GET", undefined, workSignal);
      lastCheck = Date.now();
      if (!response || response.status !== 200 || !Array.isArray(response.body)) return (live = "unknown");
      if (refresh) lastPresence = Date.now();
      const rows = readClaims(response.body.filter((row: { status?: unknown } | null) => row?.status === "taken"), identity.userId, identity.deviceId);
      return (live = rows.some((row) => row.id === request.id && row.rom_id === request.rom_id &&
        JSON.stringify(row.file_ids) === JSON.stringify(request.file_ids)) ? "taken" : "cancelled");
    };
    const monitor = (async () => {
      while (!workSignal.aborted) {
        await pause(2000, undefined, { signal: workSignal });
        if (await check() !== "taken") { controller.abort(); return; }
      }
    })().catch(() => controller.abort());
    let lastProgress = 0;
    try {
      const result = await processInstall({ request, root, server: serverUrl, signal: workSignal, transport: {
        metadata: async (romId, ownerSignal) => {
          const response = await ask(`/api/roms/${romId}`, "GET", undefined, ownerSignal);
          if (!response || response.status !== 200) throw new Error("ROM metadata is unavailable");
          return response.body;
        },
        download: async (romId, file, destination, ownerSignal, progress) => {
          const idle = new AbortController();
          const timer = setTimeout(() => idle.abort(), 120_000);
          timer.unref();
          try {
            await downloadFromServer({
              url: resolveDownloadUrl(serverUrl, `/api/roms/${romId}/content/${encodeURIComponent(file.name)}?file_ids=${file.id}`),
              session, destination, maxBytes: file.size,
              signal: AbortSignal.any([ownerSignal, idle.signal]),
              onProgress: (received, total) => { timer.refresh(); progress(received, total); },
            });
          } finally { clearTimeout(timer); }
        },
        live: async () => check(),
        report: async (job: InstallRequest, status, reason, ownerSignal) => {
          const response = await ask(`${devicePath}/installs/${encodeURIComponent(job.id)}`, "PUT", { status, reason }, ownerSignal);
          if (!response || response.status !== 200) throw new Error("Install outcome was not acknowledged");
        },
        progress: (romId, file, received, total) => {
          if (Date.now() - lastProgress < 1000 && received !== total) return;
          lastProgress = Date.now();
          console.info(`[installs] rom ${romId}: ${file}, ${received}/${total} bytes`);
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed() && isServerOrigin(window.webContents.getURL(), serverUrl)) setTransferProgress(window, "install", total ? received / total : 2);
          }
        },
      } });
      console.info(`[installs] rom ${request.rom_id}: ${result}, installed cache ${root}`);
      if (result === "deferred") break;
    } finally {
      controller.abort();
      await monitor;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && isServerOrigin(window.webContents.getURL(), serverUrl)) setTransferProgress(window, "install", null);
      }
    }
  }
}

export class InstallService {
  private readonly controller = new AbortController();
  private running: Promise<void> | null = null;
  start(): void { this.running ??= this.loop(); }
  async stop(): Promise<void> { this.controller.abort(); await this.running; }
  private async loop(): Promise<void> {
    const signal = this.controller.signal;
    let delay = 15_000;
    while (!signal.aborted) {
      try {
        const config = await loadConfig();
        if (config.serverUrl) {
          const record = await storedPairing(config.serverUrl);
          if (record) {
            requirePairing(record, true);
            const session = createPairedSession(record);
            await runInstallCycle({ config, session, signal, stillCurrent: async () => {
              const next = await loadConfig();
              if (next.serverUrl !== config.serverUrl || next.cachePath !== config.cachePath || next.acceptRemoteInstalls === false) return false;
              const paired = await storedPairing(config.serverUrl!);
              return paired?.token === record.token;
            } });
          }
        }
        delay = 15_000;
      } catch (error) {
        if (!signal.aborted) console.warn("[installs] polling paused", error instanceof Error ? error.message : "request failed");
        delay = Math.min(delay * 2, 60_000);
      }
      await pause(delay, undefined, { signal }).catch(() => {});
    }
  }
}
