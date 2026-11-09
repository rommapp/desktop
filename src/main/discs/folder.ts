// Identify folder-based PS3 and Wii U games without importing Electron.
// RomM's file rows contain library-relative paths, including nested folders.
import { posix } from "node:path";
import { safeFileName } from "../safety.ts";
import { type DiscFile } from "./m3u.ts";

export interface FolderGame {
  files: { file: DiscFile; relativePath: string }[];
  bootFileId: number;
}

export function folderGame(files: DiscFile[], platformSlug: string): FolderGame | null {
  const ps3 = ["ps3", "ps3-games"].includes(platformSlug.toLowerCase());
  const wiiu = ["wiiu", "wii-u"].includes(platformSlug.toLowerCase());
  if (!ps3 && !wiiu) return null;
  const paths = files.map((file) => file.fullPath.replaceAll("\\", "/").split("/"));
  const entry = paths.findIndex((parts) =>
    ps3
      ? parts.slice(-3).join("/").toLowerCase() === "ps3_game/usrdir/eboot.bin"
      : parts.length >= 2 && parts.at(-1)?.toLowerCase().endsWith(".rpx") &&
        parts.at(-2)?.toLowerCase() === "code"
  );
  if (entry < 0) return null;
  const entryParts = paths[entry]!;
  const anchor = ps3 ? entryParts.length - 3 : entryParts.length - 2;
  const root = entryParts.slice(0, anchor);
  const staged: FolderGame["files"] = [];
  const seen = new Set<string>();
  for (let index = 0; index < files.length; index++) {
    const parts = paths[index]!;
    if (parts.length <= root.length ||
        root.some((part, i) => part !== parts[i])) return null;
    const relative = parts.slice(root.length);
    if (relative.some((part) => !part || part === "." || part === ".." ||
      safeFileName(part) !== part)) return null;
    const relativePath = posix.join(...relative);
    const key = relativePath.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    staged.push({ file: files[index]!, relativePath });
  }
  return { files: staged, bootFileId: files[entry]!.id };
}
