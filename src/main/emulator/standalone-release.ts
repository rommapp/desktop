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

import { type OriginPolicy } from "../safety.ts";

/** Where each project publishes its releases, and where its bytes may come
 *  from. Both indexes are the ones the projects' own download pages call. */
export interface ReleaseSource {
  id: string;
  label: string;
  indexUrl: string;
  /** Shown when there is nothing this machine can be handed. */
  downloadPage: string;
  /** Origins the index may answer from. */
  indexPolicy: OriginPolicy;
  /** Origins the artifact may answer from, redirects included. */
  artifactPolicy: OriginPolicy;
  pick(
    release: unknown,
    platform?: NodeJS.Platform,
    arch?: string,
  ): ReleaseArtifact | null;
}

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
 * Whether opening this leaves the emulator somewhere the shell will find it.
 *
 * An installer, a disk image and a Flatpak all end with the application in a
 * standard location, which is exactly where detection looks. An archive does
 * not: it unpacks a portable build wherever the user puts it, so it still works
 * -- Windows 11 opens a .7z in Explorer and macOS gives a .tar.xz to Archive
 * Utility -- but the user has to be told the extra step, because nothing will
 * detect a folder we cannot guess.
 *
 * Not a reason to withhold the download. Dolphin publishes no Windows installer
 * and PCSX2 no macOS disk image, and an archive someone can extract beats
 * sending them away to find it themselves.
 */
export function installsWhereDetectionLooks(kind: ArtifactKind): boolean {
  return kind !== "archive";
}

/** Archive formats the shell is willing to hand to a file manager. */
const ARCHIVE_SUFFIXES = [
  ".7z",
  ".zip",
  ".tar.xz",
  ".tar.gz",
  ".tar.bz2",
  ".tar.zst",
  ".AppImage",
];

/**
 * What an artifact is, or null when it is nothing this should open.
 *
 * An allowlist rather than an "everything else is an archive" default, because
 * every kind here ends at shell.openPath and on Windows that runs an .exe. A
 * bare executable in a release index -- an updater, an uninstaller, anything
 * added later -- would otherwise be classified as an archive and then executed,
 * which is the one thing calling it "not an installer" was meant to prevent.
 */
function kindOf(fileName: string): ArtifactKind | null {
  if (fileName.endsWith(".dmg")) return "disk-image";
  if (fileName.endsWith(".flatpak")) return "flatpak";
  // Only an actual installer counts; a bare .exe could be anything. Matched on
  // a word boundary, because "uninstaller.exe" ends with "installer.exe" and
  // running one of those is the opposite of what was asked for.
  if (/(^|[-_. ])installer\.exe$/i.test(fileName)) return "installer";
  if (ARCHIVE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
    return "archive";
  }
  return null;
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
      // Dolphin dropped 32-bit Windows long ago, and the x64 build will not
      // start on a 32-bit OS, so there is nothing to offer rather than
      // something that cannot run.
      if (arch === "ia32") return null;
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
    const kind = kindOf(fileName);
    if (!kind) continue;
    return {
      url,
      fileName,
      kind,
      version: typeof shortrev === "string" ? shortrev : "latest",
    };
  }
  return null;
}

/**
 * The PCSX2 `assets` key this machine matches.
 *
 * PCSX2 is an x86-64 recompiler and publishes nothing else: the Windows and
 * Linux groups hold x64 builds only, and the macOS one is a universal binary.
 * A machine outside that gets no key, so it is sent to the download page
 * rather than handed a build it cannot run.
 */
function pcsx2Key(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case "darwin":
      return "MacOS";
    case "win32":
      // arm64 Windows emulates x64, as it does for RetroArch. 32-bit cannot.
      return arch === "ia32" ? null : "Windows";
    case "linux":
      return arch === "x64" ? "Linux" : null;
    default:
      return null;
  }
}

/**
 * Where PCSX2 publishes its assets.
 *
 * The origin policy has to allow all of github.com and its asset CDN, because
 * a release download redirects to a host whose name has changed before. That
 * is wide enough to cover any repository on GitHub, so the entry the index
 * hands over is pinned to PCSX2's own release path as well -- otherwise an
 * index that named someone else's release would have it downloaded and, for an
 * installer, run. Compared after parsing, so a path with .. segments in it is
 * normalised before it is judged rather than after.
 */
function onPcsx2Releases(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.origin === "https://github.com" &&
    parsed.pathname.startsWith("/PCSX2/pcsx2/releases/download/")
  );
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
  const key = pcsx2Key(platform, arch);
  if (!key) return null;
  const group: unknown = (assets as Record<string, unknown>)[key];
  if (!Array.isArray(group)) return null;

  const candidates: ReleaseArtifact[] = [];
  for (const entry of group as Pcsx2Asset[]) {
    if (typeof entry?.url !== "string") continue;
    if (!onPcsx2Releases(entry.url)) continue;
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
    const kind = kindOf(fileName);
    if (!kind) continue;
    candidates.push({
      url: entry.url,
      fileName,
      kind,
      version: typeof version === "string" ? version : "latest",
    });
  }
  if (candidates.length === 0) return null;
  // Something that installs itself wins -- the Flatpak over the AppImage on
  // Linux, the installer over the portable .7z on Windows. Otherwise the first,
  // so an archive is still offered rather than nothing.
  return (
    candidates.find((one) => installsWhereDetectionLooks(one.kind)) ??
    candidates[0]!
  );
}

export const RELEASE_SOURCES: Record<string, ReleaseSource> = {
  dolphin: {
    id: "dolphin",
    label: "Dolphin",
    // The beta channel, not dev: RetroAchievements wants a release build, and
    // a nightly would change under the user daily.
    indexUrl: "https://dolphin-emu.org/update/latest/beta",
    downloadPage: "https://dolphin-emu.org/download/",
    indexPolicy: { origins: ["https://dolphin-emu.org"] },
    // Serves its own artifacts; no redirect to a CDN.
    artifactPolicy: { origins: ["https://dl.dolphin-emu.org"] },
    pick: pickDolphinArtifact,
  },
  pcsx2: {
    id: "pcsx2",
    label: "PCSX2",
    indexUrl: "https://api.pcsx2.net/v1/latestReleasesAndPullRequests",
    downloadPage: "https://pcsx2.net/downloads/",
    indexPolicy: { origins: ["https://api.pcsx2.net"] },
    // Release assets live on GitHub and redirect to its asset host, whose name
    // has changed before, so the suffix is what is pinned rather than today's
    // spelling of it.
    artifactPolicy: {
      origins: ["https://github.com"],
      hostSuffixes: ["githubusercontent.com"],
    },
    pick: pickPcsx2Artifact,
  },
};

/** PCSX2 wraps its releases in an envelope; unwrap before picking. */
export function pcsx2LatestStable(index: unknown): unknown {
  if (typeof index !== "object" || index === null) return null;
  const releases = (index as { stableReleases?: unknown }).stableReleases;
  if (typeof releases !== "object" || releases === null) return null;
  const data = (releases as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data[0] ?? null;
}

/** The shape each source's index arrives in, reduced to the release itself. */
export function unwrapRelease(sourceId: string, index: unknown): unknown {
  return sourceId === "pcsx2" ? pcsx2LatestStable(index) : index;
}
