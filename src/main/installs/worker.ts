// Process a taken request with injected transport. Stage every selected file in
// a fresh tree, verify its exact size, and publish only when the request is
// still live. Network uncertainty leaves the server's claim recoverable; a
// completed manifest makes a lost outcome acknowledgement safe to retry.

import { mkdir, mkdtemp, rename, rm, stat, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inTurn } from "../saves/lock.ts";
import { installFiles, type InstallFile, type InstallRequest } from "./plan.ts";
import { INSTALL_MANIFEST, readInstallation, type InstallManifest } from "./store.ts";

export type InstallOutcome = "done" | "already_installed" | "failed";
export type Liveness = "taken" | "cancelled" | "unknown";
export interface InstallTransport {
  metadata(romId: number, signal: AbortSignal): Promise<unknown>;
  download(romId: number, file: InstallFile, destination: string, signal: AbortSignal, progress: (received: number, total: number | null) => void): Promise<void>;
  live(request: InstallRequest, signal: AbortSignal): Promise<Liveness>;
  report(request: InstallRequest, status: InstallOutcome, reason: string | null, signal: AbortSignal): Promise<void>;
  progress?(romId: number, file: string, received: number, total: number): void;
}
interface ProcessOptions {
  request: InstallRequest; root: string; server: string; transport: InstallTransport; signal: AbortSignal;
}
export function processInstall(options: ProcessOptions): Promise<InstallOutcome | "deferred"> {
  return inTurn(join(options.root, String(options.request.rom_id)), () => runInstall(options));
}
async function runInstall(options: ProcessOptions): Promise<InstallOutcome | "deferred"> {
  const { request, root, server, transport, signal } = options;
  let stage: string | null = null;
  let durable = false;
  try {
    signal.throwIfAborted();
    const files = installFiles(await transport.metadata(request.rom_id, signal), request);
    const target = join(root, String(request.rom_id));
    const existing = await readInstallation(target);
    const same = existing?.server === server && existing.userId === request.user_id && existing.romId === request.rom_id &&
      JSON.stringify(existing.files) === JSON.stringify(files);
    if (same) {
      durable = true;
      if (await transport.live(request, signal) !== "taken") return "deferred";
      await transport.report(request, "already_installed", null, signal);
      return "already_installed";
    }
    if (await lstat(target).catch(() => null)) throw new Error("An existing installation differs. Remove its local directory before reinstalling.");
    await mkdir(root, { recursive: true });
    stage = await mkdtemp(join(root, ".install-stage-"));
    let completed = 0;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      signal.throwIfAborted();
      if (await transport.live(request, signal) !== "taken") return "deferred";
      const destination = join(stage, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await transport.download(request.rom_id, file, destination, signal, (received) =>
        transport.progress?.(request.rom_id, file.name, completed + received, total),
      );
      const written = await stat(destination);
      if (!written.isFile() || written.size !== file.size) throw new Error(`Incomplete download of ${file.name}`);
      completed += written.size;
    }
    signal.throwIfAborted();
    if (await transport.live(request, signal) !== "taken") return "deferred";
    const manifest: InstallManifest = { server, userId: request.user_id, romId: request.rom_id, requestId: request.id, files };
    await writeFile(join(stage, INSTALL_MANIFEST), JSON.stringify(manifest), { flag: "wx" });
    await rename(stage, target);
    stage = null;
    durable = true;
    // Publication precedes acknowledgement. If the response is lost, the next
    // claim sees the manifest and reports already_installed without downloading.
    await transport.report(request, "done", null, signal);
    return "done";
  } catch (error) {
    if (signal.aborted) return "deferred";
    // A published installation is durable even if reporting went offline.
    if (durable) return "deferred";
    const live = await transport.live(request, signal).catch(() => "unknown" as const);
    if (live !== "taken") return "deferred";
    const reason = (error instanceof Error ? error.message : "Install failed").slice(0, 500);
    await transport.report(request, "failed", reason, signal).catch(() => {});
    return "failed";
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
