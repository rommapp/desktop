// Installed games have an account/server-scoped cache, distinct from transient
// launch downloads. A completion manifest is the pin: it is published with the
// whole directory, never while a download can still be mistaken for a game.

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopConfig } from "../../shared/types.ts";
import { safeFileName } from "../safety.ts";
import { installFiles, MAX_INSTALL_FILES, type InstallFile } from "./plan.ts";

export const INSTALL_MANIFEST = ".romm-installed.json";
export interface InstallManifest {
  server: string;
  userId: number;
  romId: number;
  requestId: string;
  files: InstallFile[];
}
export function installedRoot(config: Pick<DesktopConfig, "serverUrl" | "cachePath">, userId: number): string {
  if (!config.serverUrl || !config.cachePath || !Number.isSafeInteger(userId) || userId < 1) throw new Error("Missing install identity or cache");
  const scope = createHash("sha256").update(JSON.stringify([new URL(config.serverUrl).origin, userId])).digest("hex");
  return join(config.cachePath, ".installed", scope);
}

/** Symlinked components are never accepted as a completed installation. */
export async function readInstallation(directory: string): Promise<InstallManifest | null> {
  try {
    if (!(await lstat(directory)).isDirectory()) return null;
    const marker = join(directory, INSTALL_MANIFEST);
    if (!(await lstat(marker)).isFile()) return null;
    const row = JSON.parse(await readFile(marker, "utf8")) as InstallManifest;
    if (!row || typeof row.server !== "string" || !Number.isSafeInteger(row.userId) || row.userId < 1 ||
        !Number.isSafeInteger(row.romId) || row.romId < 1 || typeof row.requestId !== "string" ||
        !Array.isArray(row.files) || row.files.length < 1 || row.files.length > MAX_INSTALL_FILES) return null;
    for (const file of row.files) {
      if (!file || typeof file.path !== "string" || typeof file.revision !== "string" || file.revision.length > 600 || !Number.isSafeInteger(file.size) || file.size < 0) return null;
      const parts = file.path.split("/");
      if (parts.some((part) => !part || safeFileName(part) !== part)) return null;
      let path = directory;
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const info = await lstat(path);
        if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.size !== file.size) return null;
      }
    }
    return row;
  } catch { return null; }
}

export async function installedCache(config: DesktopConfig, userId: number, romId: number): Promise<string | null> {
  try {
    const root = installedRoot(config, userId);
    const row = await readInstallation(join(root, String(romId)));
    return row?.server === new URL(config.serverUrl!).origin && row.userId === userId && row.romId === romId ? root : null;
  } catch { return null; }
}

/** Reserved staging trees cannot be live after the owning process exits. */
export async function sweepInstallStages(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && /^\.install-stage-[a-zA-Z0-9]+$/.test(entry.name)) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

/** Validate current metadata before exposing a pinned cache to the launcher.
 *  Restrict staging to the installed snapshot so a later DLC upload does not
 *  mutate a pinned tree during an ordinary launch. */
export async function installedLaunch(config: DesktopConfig, userId: number, romId: number, metadata: () => Promise<unknown>): Promise<{
  cachePath: string; metadata: unknown; files: InstallFile[];
} | null> {
  const cachePath = await installedCache(config, userId, romId);
  if (!cachePath) return null;
  try {
    const manifest = await readInstallation(join(cachePath, String(romId)));
    if (!manifest) return null;
    const body = await metadata();
    const selected = installFiles(body, { rom_id: romId, file_ids: manifest.files.map((file) => file.id) });
    if (JSON.stringify(selected) !== JSON.stringify(manifest.files)) return null;
    const ids = new Set(selected.map((file) => file.id));
    const row = body as { files: { id: number }[] };
    return { cachePath, files: selected, metadata: { ...row, files: row.files.filter((file) => ids.has(file.id)) } };
  } catch { return null; }
}
