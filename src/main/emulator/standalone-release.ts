// Picking the right download for a standalone emulator.
//
// Each project publishes a JSON index of its releases, which is a good deal
// steadier than scraping a directory listing: Dolphin at
// dolphin-emu.org/update/latest/<channel>, PCSX2 at api.pcsx2.net, RPCS3 at
// update.rpcs3.net -- the endpoint its own in-app updater calls. Cemu publishes
// none of its own, so its GitHub release feed stands in, pinned to its own
// repository. This reads those four shapes and answers one question -- what
// should this machine download, and can the operating system install it
// unaided?
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
export type ArtifactKind =
  | "installer"
  | "disk-image"
  | "flatpak"
  | "archive"
  | "appimage";

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
 * An AppImage does not either, for a different reason: it is the emulator
 * itself rather than something that unpacks to one, so it lands wherever the
 * user keeps it and is theirs to point at.
 *
 * Not a reason to withhold the download. Dolphin publishes no Windows
 * installer, PCSX2 no macOS disk image, and RPCS3 nothing but archives on every
 * platform it builds for -- an archive someone can extract beats sending them
 * away to find it themselves.
 */
export function installsWhereDetectionLooks(kind: ArtifactKind): boolean {
  return kind !== "archive" && kind !== "appimage";
}

/**
 * Whether waiting for this to turn up is worth doing.
 *
 * Not the same question as the one above, and the difference is the whole
 * reason both exist. That one asks what *this file* will do when opened; this
 * one asks whether the emulator has any chance of appearing where detection
 * looks once the user is finished -- and a user who was handed nothing still
 * usually installs the thing, through a package manager or the project's own
 * installer, both of which land exactly there.
 *
 * So the only answer of no is the one where the emulator is a file the user
 * keeps somewhere of their own choosing. Waiting on that would be half an hour
 * of pretending; waiting on the others ends with the game starting by itself.
 */
export function mayAppearWhereDetectionLooks(
  artifact: ReleaseArtifact | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (artifact === null) return true;
  if (installsWhereDetectionLooks(artifact.kind)) return true;
  // A macOS archive is the exception, and it is not a small one: PCSX2's
  // .tar.xz and RPCS3's .7z both hold a .app, and a .app goes to Applications
  // -- which is the first place detection looks. No promise, since a .app runs
  // perfectly well from Downloads, but the wait is free and it usually ends
  // with the game starting rather than with a message about settings.
  //
  // Everywhere else an archive unpacks to a directory the user puts wherever
  // they like, and detection only ever looks where an install goes, so waiting
  // on one really would be waiting for nothing.
  return platform === "darwin" && artifact.kind === "archive";
}

/** Archive formats the shell is willing to hand to a file manager. */
const ARCHIVE_SUFFIXES = [
  ".7z",
  ".zip",
  ".tar.xz",
  ".tar.gz",
  ".tar.bz2",
  ".tar.zst",
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
  // Its own kind rather than an archive: there is nothing inside it to extract,
  // and unlike every other kind here it has to be made executable before it
  // will run at all. RPCS3 and Cemu publish one as their only Linux build.
  if (fileName.endsWith(".AppImage")) return "appimage";
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
 * Whether a URL is a release asset of one of the named GitHub repositories.
 *
 * Three of these projects publish through GitHub, so the origin policy has to
 * allow all of github.com and its asset CDN -- a release download redirects to
 * a host whose name has changed before. That is wide enough to cover any
 * repository on GitHub, so the entry the index hands over is pinned to the
 * project's own release path as well: otherwise an index that named someone
 * else's release would have it downloaded and, for an installer, run. Compared
 * after parsing, so a path with .. segments in it is normalised before it is
 * judged rather than after.
 */
function onGithubRelease(url: string, repositories: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== "https://github.com") return false;
  return repositories.some((repository) =>
    parsed.pathname.startsWith(`/${repository}/releases/download/`),
  );
}

/** Origins for a project whose assets are GitHub release downloads. The suffix
 *  is what is pinned rather than today's spelling of the asset host, whose name
 *  has changed before. */
const GITHUB_ASSET_POLICY: OriginPolicy = {
  origins: ["https://github.com"],
  hostSuffixes: ["githubusercontent.com"],
};

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
    if (!onGithubRelease(entry.url, ["PCSX2/pcsx2"])) continue;
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

/**
 * The Apple silicon build of the same release.
 *
 * RPCS3's update endpoint names one macOS build and it is the Intel one, so
 * Apple silicon would otherwise be handed a PS3 emulator to run under
 * translation -- the one kind of program least able to spare it, chosen on the
 * user's behalf and invisibly, since what arrives is simply "RPCS3".
 *
 * The native build is published from a repository of its own, from the same
 * build tag, under the same name with `_aarch64` before the suffix. That makes
 * it nameable rather than guessable: every part comes from the URL the endpoint
 * just gave, and the result is checked against the binary repositories like any
 * other artifact.
 *
 * A build that ever stops following this naming, or a commit whose arm64 build
 * did not publish, ends at a 404 the offer already handles by sending the user
 * to the download page -- where the native build is listed, which is where they
 * would have been sent anyway.
 */
function appleSiliconBuild(intel: ReleaseArtifact): ReleaseArtifact | null {
  const MACOS_SUFFIX = "_macos.7z";
  if (!intel.fileName.endsWith(MACOS_SUFFIX)) return null;
  const rename = (text: string): string =>
    text.slice(0, -MACOS_SUFFIX.length) + "_macos_aarch64.7z";
  const url = rename(
    intel.url.replace(
      "/RPCS3/rpcs3-binaries-mac/",
      "/RPCS3/rpcs3-binaries-mac-arm64/",
    ),
  );
  // The rename has to have moved it to the arm64 repository; otherwise this is
  // a URL of some shape this was not written for, and the Intel build is not
  // the answer to that.
  if (!onGithubRelease(url, ["RPCS3/rpcs3-binaries-mac-arm64"])) return null;
  return { ...intel, url, fileName: rename(intel.fileName) };
}

/**
 * The RPCS3 `latest_build` key this machine matches.
 *
 * The index carries exactly three builds, which is what the project's own
 * updater offers: a 64-bit Windows build, an x86-64 AppImage, and one x86-64
 * macOS archive. Anything outside that gets no key and is sent to the download
 * page rather than handed a build that is wrong for it.
 */
function rpcs3Key(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case "darwin":
      // The only macOS build here is x86-64. Apple silicon takes it as the
      // starting point and is handed its own build instead -- see
      // appleSiliconBuild.
      return "mac";
    case "win32":
      // arm64 Windows emulates x64, as it does for RetroArch. 32-bit cannot.
      return arch === "ia32" ? null : "windows";
    case "linux":
      return arch === "x64" ? "linux" : null;
    default:
      return null;
  }
}

/** The repositories RPCS3 publishes its builds from -- one per platform,
 *  separate from the source repository. */
const RPCS3_BINARY_REPOSITORIES = [
  "RPCS3/rpcs3-binaries-win",
  "RPCS3/rpcs3-binaries-linux",
  "RPCS3/rpcs3-binaries-mac",
  // The Apple silicon build, which the update endpoint does not mention. Named
  // here so a derived URL is checked against an allowlist like any other.
  "RPCS3/rpcs3-binaries-mac-arm64",
];

/**
 * Read RPCS3's update index.
 *
 * One build per platform, each an object with its own download URL, so there is
 * nothing to choose between: the platform key either has a usable asset or it
 * does not. Whether the endpoint answered at all is rpcs3LatestBuild's
 * question, and it is asked before this sees anything.
 */
export function pickRpcs3Artifact(
  release: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseArtifact | null {
  if (typeof release !== "object" || release === null) return null;
  const { version } = release as { version?: unknown };
  const key = rpcs3Key(platform, arch);
  if (!key) return null;
  const build: unknown = (release as Record<string, unknown>)[key];
  if (typeof build !== "object" || build === null) return null;
  const { download } = build as { download?: unknown };
  if (typeof download !== "string") return null;
  if (!onGithubRelease(download, RPCS3_BINARY_REPOSITORIES)) return null;
  const fileName = fileNameOf(download);
  if (!fileName) return null;
  const kind = kindOf(fileName);
  if (!kind) return null;
  const artifact: ReleaseArtifact = {
    url: download,
    fileName,
    kind,
    version: typeof version === "string" ? version : "latest",
  };
  // Apple silicon gets its own build of this same release, or nothing: falling
  // back to what the endpoint named would be handing it the Intel one, which is
  // the thing this exists to stop.
  if (platform === "darwin" && arch === "arm64") {
    return appleSiliconBuild(artifact);
  }
  return artifact;
}

/**
 * The Cemu release assets this machine can use, best first.
 *
 * Matched on the name, because a GitHub release lists assets and nothing else:
 * there are no tags to read, and the platform is only ever spelled out in the
 * file name. Anchored at the end, so a checksum or symbols file published
 * beside a build cannot be mistaken for one.
 */
function cemuAssetPatterns(
  platform: NodeJS.Platform,
  arch: string,
): RegExp[] | null {
  switch (platform) {
    case "darwin":
      // Built per architecture. An x86-64 build runs on Apple silicon under
      // Rosetta, so it is a fallback rather than something to refuse.
      return arch === "arm64"
        ? [/macos-.*-arm64\.dmg$/i, /macos-.*-x86_64\.dmg$/i]
        : [/macos-.*-x86_64\.dmg$/i];
    case "win32":
      // arm64 Windows emulates x64. 32-bit cannot.
      if (arch === "ia32") return null;
      // The installer first: it lands in LOCALAPPDATA\Cemu, which is exactly
      // where detection looks. The portable zip is the fallback, and someone
      // who extracts it has to point at it themselves.
      return [/windows-x64-installer\.exe$/i, /windows-x64\.zip$/i];
    case "linux":
      // The AppImage is the only Linux build published, and only for x86-64.
      // The Ubuntu zip beside it is a bare binary against that release's system
      // libraries, which is not something to hand someone unasked.
      return arch === "x64" ? [/-x86_64\.AppImage$/] : null;
    default:
      return null;
  }
}

interface GithubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

/**
 * Read Cemu's GitHub release feed.
 *
 * Cemu publishes no index of its own, so this is the release its download page
 * links to, read from GitHub's API. /releases/latest excludes drafts and
 * prereleases, so the answer is the same build the project is offering.
 */
export function pickCemuArtifact(
  release: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseArtifact | null {
  if (typeof release !== "object" || release === null) return null;
  const { tag_name: tag, assets } = release as {
    tag_name?: unknown;
    assets?: unknown;
  };
  if (!Array.isArray(assets)) return null;
  const patterns = cemuAssetPatterns(platform, arch);
  if (!patterns) return null;

  // Preference order is the pattern order, so the loop is over patterns rather
  // than over assets: whichever asset the release happens to list first should
  // not decide between an installer and a portable zip.
  for (const pattern of patterns) {
    for (const entry of assets as GithubReleaseAsset[]) {
      const url = entry?.browser_download_url;
      if (typeof entry?.name !== "string" || typeof url !== "string") continue;
      if (!pattern.test(entry.name)) continue;
      if (!onGithubRelease(url, ["cemu-project/Cemu"])) continue;
      // The name is what was matched, but the file on disk is named after the
      // URL, so that is what has to be classifiable.
      const fileName = fileNameOf(url);
      if (!fileName) continue;
      const kind = kindOf(fileName);
      if (!kind) continue;
      return {
        url,
        fileName,
        kind,
        version: typeof tag === "string" ? tag : "latest",
      };
    }
  }
  return null;
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
    artifactPolicy: GITHUB_ASSET_POLICY,
    pick: pickPcsx2Artifact,
  },
  rpcs3: {
    id: "rpcs3",
    label: "RPCS3",
    // The endpoint RPCS3's own updater calls. api=v2 is what returns the
    // per-platform objects below; without it the answer is the older shape.
    indexUrl: "https://update.rpcs3.net/?api=v2",
    downloadPage: "https://rpcs3.net/download",
    indexPolicy: { origins: ["https://update.rpcs3.net"] },
    artifactPolicy: GITHUB_ASSET_POLICY,
    pick: pickRpcs3Artifact,
  },
  cemu: {
    id: "cemu",
    label: "Cemu",
    // Cemu has no release index of its own, so this is the GitHub release its
    // download page points at. Pinned to the repository in the path, and the
    // assets are pinned again in pickCemuArtifact.
    indexUrl: "https://api.github.com/repos/cemu-project/Cemu/releases/latest",
    downloadPage: "https://cemu.info/",
    indexPolicy: { origins: ["https://api.github.com"] },
    artifactPolicy: GITHUB_ASSET_POLICY,
    pick: pickCemuArtifact,
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

/**
 * RPCS3 answers with a status code and the build beside it.
 *
 * A negative code is the error case, and the build alongside one is not to be
 * trusted: RPCS3's own updater bails on anything below zero, which covers
 * maintenance mode, an illegal search, and -- as the default when the key is
 * missing entirely -- a response that carries no code at all.
 *
 * Zero and above are both answers. Their own client reads 0 as "you are
 * already on this build" and anything higher as "there is a newer one", and
 * either way `latest_build` is the build to fetch. This shell has no installed
 * version to compare against, so it asks without a commit hash and is told 0;
 * demanding exactly that would break the offer the day the endpoint answers 1.
 */
export function rpcs3LatestBuild(index: unknown): unknown {
  if (typeof index !== "object" || index === null) return null;
  const { return_code: code, latest_build: build } = index as {
    return_code?: unknown;
    latest_build?: unknown;
  };
  if (typeof code !== "number" || !(code >= 0)) return null;
  return build ?? null;
}

/** The shape each source's index arrives in, reduced to the release itself. */
export function unwrapRelease(sourceId: string, index: unknown): unknown {
  switch (sourceId) {
    case "pcsx2":
      return pcsx2LatestStable(index);
    case "rpcs3":
      return rpcs3LatestBuild(index);
    default:
      // Dolphin and Cemu both answer with the release itself.
      return index;
  }
}
