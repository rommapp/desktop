// A claim contains file ids, never paths. Resolve those ids against current ROM
// metadata and preserve the same layouts the native launcher stages. Reject a
// missing row or ambiguous path instead of calling an incomplete game installed.

import { folderGame } from "../discs/folder.ts";
import { readRomFiles } from "../discs/m3u.ts";

export const MAX_INSTALL_FILES = 10_000;
export interface InstallRequest {
  id: string;
  user_id: number;
  device_id: string;
  rom_id: number;
  file_ids: number[];
  status: "taken";
}
export interface InstallFile {
  id: number;
  name: string;
  path: string;
  size: number;
  revision: string;
}
export function readClaims(value: unknown, userId: number, deviceId: string): InstallRequest[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("Invalid install queue");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid install request");
    const row = entry as InstallRequest;
    if (typeof row.id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(row.id) || ids.has(row.id) ||
        row.user_id !== userId || row.device_id !== deviceId || row.status !== "taken" ||
        !Number.isSafeInteger(row.rom_id) || row.rom_id < 1 || !Array.isArray(row.file_ids) ||
        row.file_ids.length === 0 || row.file_ids.length > MAX_INSTALL_FILES ||
        row.file_ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(row.file_ids).size !== row.file_ids.length) {
      throw new Error("Invalid or foreign install request");
    }
    ids.add(row.id);
    return row;
  });
}

export function installFiles(body: unknown, request: Pick<InstallRequest, "rom_id" | "file_ids">): InstallFile[] {
  if (!body || typeof body !== "object") throw new Error("Missing ROM metadata");
  const metadata = body as { id?: unknown; platform_slug?: unknown; files?: unknown };
  if (metadata.id !== request.rom_id || typeof metadata.platform_slug !== "string" ||
      !Array.isArray(metadata.files) || metadata.files.length > MAX_INSTALL_FILES) throw new Error("Invalid ROM metadata");
  const files = readRomFiles(body, true).filter((file) => request.file_ids.includes(file.id));
  if (files.length !== request.file_ids.length || new Set(files.map((file) => file.id)).size !== files.length) {
    throw new Error("The requested game files changed or are unavailable");
  }
  const folder = folderGame(files, metadata.platform_slug);
  const folderPlatform = ["ps3", "ps3-games", "wiiu", "wii-u"].includes(metadata.platform_slug.toLowerCase());
  if (folderPlatform && files.length > 1 && !folder) throw new Error("Unsupported or unsafe folder layout");
  const paths = new Map(folder?.files.map(({ file, relativePath }) => [file.id, relativePath]) ?? []);
  const rows = new Map((metadata.files as Record<string, unknown>[]).filter((row) => row && typeof row === "object").map((row) => [row.id, row]));
  const planned = files.map((file) => {
    const row = rows.get(file.id)!;
    // These describe the server's revision, not a promise that a checksum was
    // verified locally. Include mtime where a scanner has not computed hashes.
    const revision = ["sha1_hash", "md5_hash", "crc_hash", "last_modified"].map((key) => {
      const value = row[key];
      return typeof value === "string" && value.length <= 128 ? `${key}:${value}` : "";
    }).join("|");
    return { id: file.id, name: file.fileName, path: paths.get(file.id) ?? file.fileName, size: file.sizeBytes, revision };
  });
  if (new Set(planned.map((file) => file.path.toLowerCase())).size !== planned.length ||
      planned.some((file) => !Number.isSafeInteger(file.size)) ||
      !Number.isSafeInteger(planned.reduce((sum, file) => sum + file.size, 0))) throw new Error("Ambiguous or oversized install layout");
  return planned;
}
