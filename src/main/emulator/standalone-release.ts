// Picking the right download for a standalone emulator.
//
// Both projects publish a JSON index of their releases, which is a good deal
// steadier than scraping a directory listing: Dolphin at
// dolphin-emu.org/update/latest/<channel>, PCSX2 at api.pcsx2.net. This reads
// those two shapes and answers one question -- what should this machine
// download, and can the operating system install it unaided?
//
// The shell never extracts anything. As with RetroArch, the file is handed to
// the OS and the user completes the install through the flow they already know.
// Where a project publishes nothing the OS can install by itself, the answer is
// to send them to the download page rather than to unpack an archive on their
// behalf.
//
// Kept free of Electron imports so every platform's selection can be checked
// against the real payloads; the fetching lives in standalone-install.ts.

/** What the operating system will do when handed the file. */
export type ArtifactKind = "installer" | "disk-image" | "flatpak" | "archive";

export interface ReleaseArtifact {
  url: string;
  fileName: string;
  kind: ArtifactKind;
  /** The release this came from, for saying what is about to be installed. */
  version: string;
}

/**
 * Whether handing this to the OS actually installs anything.
 *
 * An archive does not: opening a .7z or a .tar.xz produces a folder somewhere,
 * which is not an install and leaves the user worse off than a download page
 * would. Dolphin publishes no Windows installer and PCSX2 no macOS disk image,
 * so this is false rather more often than one would like.
 */
export function canHandOffToOs(kind: ArtifactKind): boolean {
  return kind !== "archive";
}

function kindOf(fileName: string): ArtifactKind {
  if (fileName.endsWith(".dmg")) return "disk-image";
  if (fileName.endsWith(".flatpak")) return "flatpak";
  // Only an actual installer counts; a bare .exe could be anything.
  if (fileName.endsWith("installer.exe")) return "installer";
  return "archive";
}

function fileNameOf(url: string): string {
  const last = url.split("/").pop() ?? "";
  // A query string or fragment would end up in the filename on disk.
  return last.split(/[?#]/)[0] ?? "";
}

/** The Dolphin `system` label this machine matches. */
function dolphinSystem(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case "darwin":
      // One universal build covers both arches.
      return "macOS";
    case "win32":
      return arch === "arm64" ? "Windows arm64" : "Windows x64";
    case "linux":
      if (arch === "x64") return "Linux x86_64";
      if (arch === "arm64") return "Linux aarch64";
      return null;
    default:
      return null;
  }
}

interface DolphinRelease {
  shortrev?: unknown;
  artifacts?: unknown;
}

/**
 * Read Dolphin's update index.
 *
 * Its `system` strings are prose rather than identifiers -- "macOS (ARM/Intel
 * Universal)", "Linux x86_64 (Flatpak)" -- so this matches on a prefix and
 * tolerates the parenthetical changing.
 */
export function pickDolphinArtifact(
  release: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseArtifact | null {
  if (typeof release !== "object" || release === null) return null;
  const { shortrev, artifacts } = release as DolphinRelease;
  if (!Array.isArray(artifacts)) return null;
  const wanted = dolphinSystem(platform, arch);
  if (!wanted) return null;

  for (const entry of artifacts) {
    if (typeof entry !== "object" || entry === null) continue;
    const { system, url } = entry as { system?: unknown; url?: unknown };
    if (typeof system !== "string" || typeof url !== "string") continue;
    if (!system.startsWith(wanted)) continue;
    // Android ships an .apk under a system string of its own, so a prefix match
    // cannot stray onto it.
    const fileName = fileNameOf(url);
    if (!fileName) continue;
    return {
      url,
      fileName,
      kind: kindOf(fileName),
      version: typeof shortrev === "string" ? shortrev : "latest",
    };
  }
  return null;
}

/** The PCSX2 `assets` key this machine matches. */
function pcsx2Key(platform: NodeJS.Platform): string | null {
  switch (platform) {
    case "darwin":
      return "MacOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return null;
  }
}

interface Pcsx2Asset {
  url?: unknown;
  additionalTags?: unknown;
}

/**
 * Read PCSX2's release index.
 *
 * Its assets are grouped by operating system and distinguished by tags rather
 * than by name, and several are things nobody wants installed -- a symbols
 * archive sits beside the build it belongs to. Preference order per platform is
 * therefore explicit: whatever the OS can install, then anything else, so the
 * caller can still tell the user where to go.
 */
export function pickPcsx2Artifact(
  release: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseArtifact | null {
  if (typeof release !== "object" || release === null) return null;
  const { version, assets } = release as {
    version?: unknown;
    assets?: unknown;
  };
  if (typeof assets !== "object" || assets === null) return null;
  const key = pcsx2Key(platform);
  if (!key) return null;
  const group: unknown = (assets as Record<string, unknown>)[key];
  if (!Array.isArray(group)) return null;

  const candidates: ReleaseArtifact[] = [];
  for (const entry of group as Pcsx2Asset[]) {
    if (typeof entry?.url !== "string") continue;
    const tags = Array.isArray(entry.additionalTags)
      ? entry.additionalTags.filter(
          (tag): tag is string => typeof tag === "string",
        )
      : [];
    // A debug-symbols archive is published alongside the build and is never
    // what anyone means by "install PCSX2".
    if (tags.includes("symbols")) continue;
    const fileName = fileNameOf(entry.url);
    if (!fileName) continue;
    // Only x64 is published, so an arm64 Windows machine takes the x64 build it
    // can emulate, exactly as it does for RetroArch.
    if (platform === "win32" && arch === "ia32") continue;
    candidates.push({
      url: entry.url,
      fileName,
      kind: kindOf(fileName),
      version: typeof version === "string" ? version : "latest",
    });
  }
  if (candidates.length === 0) return null;
  // Something installable wins; otherwise hand back the first so the caller can
  // still name a version and point at the download page.
  return candidates.find((one) => canHandOffToOs(one.kind)) ?? candidates[0]!;
}
