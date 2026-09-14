// The contract between the renderer (RomM's web frontend), the preload bridge
// and the main process. Kept free of Electron and Node imports so the frontend
// can depend on these shapes without pulling the shell into its bundle.

/** Why a launch could not be started. The renderer maps these to messages. */
export type LaunchErrorCode =
  | "unsupported-platform"
  | "no-emulator-configured"
  | "emulator-not-found"
  | "download-failed"
  | "already-running"
  | "invalid-request"
  | "launch-failed";

export class LaunchError extends Error {
  code: LaunchErrorCode;

  constructor(code: LaunchErrorCode, message: string) {
    super(message);
    this.name = "LaunchError";
    this.code = code;
  }
}

/** A launch as the renderer asks for it: it names the game and its candidate
 *  cores, never an executable. The main process resolves the emulator. */
export interface LaunchRequest {
  romId: number;
  /** Server-relative download path, as built by the frontend's getDownloadPath. */
  downloadPath: string;
  /** Used to name the cached file, never used as a path on its own. */
  fileName: string;
  platformSlug: string;
  /** Candidate libretro core names from the frontend's platform/core map. */
  cores: string[];
  /** Display name, used for window titles and logs. */
  name?: string;
  /** The ROM's path relative to the server's library root, as RomM reports it
   *  in full_path. Only ever joined onto the user's own libraryPath, never
   *  treated as a path in its own right. */
  serverPath?: string;
  /** Size in bytes as the server reports it. Checked against a local file
   *  before it stands in for a download. */
  fileSize?: number;
}

export type LaunchStatus = "downloading" | "running" | "exited" | "failed";

export interface LaunchState {
  romId: number;
  status: LaunchStatus;
  /** What is being fetched while status is "downloading". Absent means the ROM,
   *  so a frontend that predates core installation reads a core download as an
   *  ordinary one rather than as an unknown status it has to handle.
   *  "emulator" covers both fetching a standalone emulator and the wait while
   *  the user installs what was fetched, which has no progress to report. */
  stage?: "rom" | "core" | "emulator";
  /** The core being installed, while stage is "core". */
  core?: string;
  /** The emulator being set up, while stage is "emulator". Present for both
   *  halves of that stage, so a frontend can name what it is waiting for. */
  emulator?: string;
  /** 0..1 while downloading, absent otherwise. */
  progress?: number;
  /** Bytes transferred so far, while downloading. */
  received?: number;
  /** Total bytes, when the server declared a length. */
  total?: number;
  /** Smoothed transfer rate, once there are two samples to compare. */
  bytesPerSecond?: number;
  /** Set when status is "failed". */
  error?: { code: LaunchErrorCode; message: string };
  /** Process exit code, set when status is "exited". */
  exitCode?: number | null;
}

export interface LaunchResult {
  romId: number;
  /** The emulator that was started, for display in the renderer. */
  emulator: string;
}

/** Asks whether a platform can be launched, given the cores it supports. */
export interface PlatformSupportQuery {
  platformSlug: string;
  cores: string[];
}

/** Whether a given platform can be launched natively, and by what. */
export interface PlatformSupport {
  supported: boolean;
  /** Human-readable emulator name when supported. */
  emulator?: string;
  /** Set when unsupported, so the renderer can explain why. */
  reason?: Extract<
    LaunchErrorCode,
    "unsupported-platform" | "no-emulator-configured" | "emulator-not-found"
  >;
  /** The resolver's own message for the unsupported case. A bare reason code
   *  cannot tell a missing emulator from an uninstalled core, and the paths
   *  involved are the whole diagnosis. */
  detail?: string;
}

/**
 * One row of the user's emulator table. `platformSlug` of "*" is the fallback
 * used for any platform without its own row.
 */
export interface EmulatorMapping {
  platformSlug: string;
  /** Path to the emulator executable. Relative paths resolve against
   *  `emulatorsBasePath`, so a frontend that keeps its emulators in one tree
   *  only needs naming once. */
  command: string;
  /** Argument template: "{rom}" becomes the cached ROM path, "{core}" the
   *  resolved core path, "{saves}" / "{states}" this game's save data
   *  directories, and "{savefile}" / "{statefile}" the files inside them, for
   *  an emulator that wants one. Substituted per argv entry, so no shell is
   *  involved. */
  args: string[];
  /** Display name for the emulator, shown in the renderer. */
  label?: string;
}

export interface DesktopConfig {
  /** Origin of the RomM server this shell is bound to, e.g. https://romm.lan. */
  serverUrl: string | null;
  /** Absolute path to the RetroArch executable, when the user has one. */
  retroarchPath: string | null;
  /** Directory holding RetroArch's libretro cores. */
  retroarchCoresPath: string | null;
  /** Download a missing libretro core from the libretro buildbot rather than
   *  failing the launch. Only ever fetches a core named for the platform being
   *  launched -- by the frontend, or by `preferredCores` below -- and only into
   *  `retroarchCoresPath`. */
  autoInstallCores: boolean;
  /** Offer, on startup, to fetch RetroArch's own installer when this machine
   *  has no emulator at all. Nothing is ever installed without the user saying
   *  so, and the offer stops once they have an emulator or decline for good. */
  offerRetroArchInstall: boolean;
  /** Use a standalone emulator found in its usual install location when no
   *  `emulators` row covers the platform. Only PS2 and GameCube/Wii have one
   *  today, because RetroAchievements recognises no libretro core for either.
   *  Nothing is downloaded and no config is written; an explicit row always
   *  wins, so this only ever fills a gap. */
  useDetectedEmulators: boolean;
  /** When a game needs a standalone emulator that is not installed, offer to
   *  fetch it from the project rather than failing the launch. Asked at most
   *  once per emulator per run, and declining simply lets the launch proceed as
   *  it would have. */
  offerStandaloneInstall: boolean;
  /** Cores to try first for a platform, ahead of the ones the frontend named.
   *  RomM's map picks a sensible core for playing; it does not know which cores
   *  RetroAchievements recognises, or which one you happen to prefer. Keyed by
   *  platform slug, matched case-insensitively. A name the frontend never
   *  offered is still honoured, so this can reach a core RomM does not list. */
  preferredCores: Record<string, string[]>;
  /** Directory the frontends install emulators under, so an emulators entry can
   *  name a relative path instead of repeating an absolute one. Null means every
   *  command must be absolute. */
  emulatorsBasePath: string | null;
  /** Per-platform overrides, consulted before the RetroArch default. */
  emulators: EmulatorMapping[];
  /** Where downloaded ROMs are cached. Defaults to userData/rom-cache. */
  cachePath: string | null;
  /** Root for the per-game directories an emulator is pointed at for save data.
   *  Keeping saves out of the cache protects them from its eviction, and out of
   *  the library from being scanned. Defaults to userData/save-data. */
  saveDataPath: string | null;
  /** Root of the RomM library as this machine sees it. When the server runs
   *  here, a ROM found under this path is launched in place rather than
   *  downloaded back to the same disk. Null disables the lookup. */
  libraryPath: string | null;
  /** Upper bound on the ROM cache before least-recently-used eviction. */
  cacheLimitBytes: number;
  /** Open the main window fullscreen. Intended for a TV or cabinet, where
   *  there is no reason to see a title bar. */
  fullscreen: boolean;
  /** Trusted certificate fingerprints for self-signed servers. */
  trustedCertificates: string[];
}

export const DEFAULT_CACHE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;

/** The API the preload bridge exposes to the renderer as window.rommNative. */
export interface RommNativeBridge {
  readonly shellVersion: string;
  readonly os: "darwin" | "win32" | "linux";
  launch(request: LaunchRequest): Promise<LaunchResult>;
  cancel(romId: number): Promise<void>;
  getPlatformSupport(query: PlatformSupportQuery): Promise<PlatformSupport>;
  /** Subscribe to launch progress. Returns an unsubscribe function. */
  onLaunchState(listener: (state: LaunchState) => void): () => void;
  openSettings(): Promise<void>;
}
