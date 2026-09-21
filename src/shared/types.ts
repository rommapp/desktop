// The contract between the renderer (RomM's web frontend), the preload bridge
// and the main process. Kept free of Electron and Node imports so the frontend
// can depend on these shapes without pulling the shell into its bundle.

/** Why a launch could not be started. The renderer maps these to messages. */
export type LaunchErrorCode =
  | "unsupported-platform"
  | "no-emulator-configured"
  | "emulator-not-found"
  | "download-failed"
  /** The server no longer recognises the session the window holds. Its own code
   *  because it is the one launch failure the user can fix, and the fix is not
   *  the one every other download failure asks for. */
  | "session-expired"
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

/**
 * What a bridge call rejects with, which is deliberately not an Error.
 *
 * Electron's context bridge copies a thrown Error into the page's world with
 * its message and stack and nothing else: "any custom properties on the Error
 * object will be lost". A LaunchError crossing it would arrive as its message
 * alone, and the code -- the whole reason LaunchErrorCode exists -- would be
 * dropped silently on the way.
 *
 * A plain object is copied whole, so this carries both. It is what the page
 * catches, and `name` is there so a caught failure still prints as something
 * recognisable.
 */
export interface LaunchFailure {
  name: "LaunchError";
  code: LaunchErrorCode;
  message: string;
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
  /** Start the emulator fullscreen, for a page whose own player offers the
   *  same choice. Only the built-in RetroArch path can honour it, since that
   *  is the only argument list the shell writes; a mapping decides it in its
   *  own arguments or its own config. */
  fullscreen?: boolean;
}

export type LaunchStatus =
  | "downloading"
  | "running"
  | "exited"
  | "failed"
  /** A save moved, after the emulator had already exited. Its own status rather
   *  than a stage, because it outlives the launch it belongs to: the exit is
   *  reported immediately and the upload settles afterwards, so a frontend that
   *  predates this sees an unknown status on an already-finished launch rather
   *  than a launch that never finishes. */
  | "sync";

/** What happened to a save around one launch. */
export type SaveSyncAction =
  /** The server's copy was written over the local one before the emulator ran. */
  | "downloaded"
  /** What the emulator wrote was sent to the save's slot. */
  | "uploaded"
  /** Nothing was replaced. The local bytes were kept as an archival save
   *  because the slot held progress this device had not seen. */
  | "archived"
  /** The slot it came from was emptied on the server, so the local copy went
   *  with it. Nothing was sent: the save is gone because its owner said so. */
  | "deleted"
  /** It was tried and did not work. The local file is untouched. */
  | "failed";

export interface SaveSyncOutcome {
  action: SaveSyncAction;
  /** The slot the save moved through, when it went through one. Absent for an
   *  archival save, which deliberately sits outside every slot. */
  slot?: string | null;
  /** Why, when the outcome was a failure. For logs, not for display: a renderer
   *  has its own message for the action. */
  detail?: string;
}

/** What was recorded for one finished play session. */
export interface PlaySessionSummary {
  /** ISO 8601 in UTC, as the server is told it. */
  startedAt: string;
  durationMs: number;
}

export interface LaunchState {
  romId: number;
  status: LaunchStatus;
  /** What is being fetched while status is "downloading". Absent means the ROM,
   *  so a frontend that predates core installation reads a core download as an
   *  ordinary one rather than as an unknown status it has to handle.
   *  "emulator" covers both fetching a standalone emulator and the wait while
   *  the user installs what was fetched, which has no progress to report.
   *  "firmware" is the RomM firmware mirror, which usually has nothing to do.
   *  "save" is the save pull, which happens after a ROM is ready and before the
   *  emulator starts. */
  stage?: "rom" | "core" | "emulator" | "firmware" | "save";
  /** The core being installed, while stage is "core". */
  core?: string;
  /** The firmware file being fetched, while stage is "firmware". Its own field
   *  rather than borrowing `core`, so a frontend reading one never has to
   *  guess which stage it is in. */
  firmware?: string;
  /** The file being fetched out of a multi-disc set, and its place in that
   *  set: a frontend can name it and count it rather than watching one
   *  transfer restart at 0% for every disc. Not every file is a disc of its
   *  own, since a sheet's tracks are fetched with it. */
  file?: string;
  fileIndex?: number;
  fileCount?: number;
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
  /** The play session this launch just finished, set when status is "exited"
   *  and the run was long enough to count as one. Absent means nothing was
   *  recorded: tracking off, or an emulator that exited too quickly. */
  play?: PlaySessionSummary;
  /** What happened to a save, set when status is "sync". */
  sync?: SaveSyncOutcome;
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

/** Upper bound on one bulk platform-support call, so a renderer cannot ask for
 *  an unbounded number of config loads in a single invoke. */
export const MAX_PLATFORM_QUERIES = 512;

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
   *  directories, "{savefile}" / "{statefile}" the files inside them for an
   *  emulator that wants one, "{bios}" the directory this platform's RomM
   *  firmware was mirrored into, and "{biosconfig}" a generated RetroArch
   *  config naming that directory as its system_directory, for a RetroArch
   *  mapping to pass to --appendconfig. Substituted per argv entry, so no shell
   *  is involved. */
  args: string[];
  /** Display name for the emulator, shown in the renderer. */
  label?: string;
  /** Whether this emulator boots an .m3u playlist, for a multi-disc game.
   *  Inferred from the arguments when unset: one naming "{core}" is RetroArch
   *  driving a libretro core, which reads one. */
  playlist?: boolean;
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
   *  `emulators` row covers the platform. PS2 and GameCube/Wii have one because
   *  RetroAchievements recognises no libretro core for either; PS3 and Wii U
   *  because libretro has no core for them at all. Nothing is downloaded and no
   *  config is written; an explicit row always wins, so this only ever fills a
   *  gap. */
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
  /** Root for the per-platform directories RomM's firmware is mirrored into,
   *  one per platform slug. Never evicted, unlike the ROM cache, because a
   *  launch depends on what is in it. Defaults to userData/bios. */
  biosPath: string | null;
  /** Mirror the firmware already uploaded to RomM, so an emulator finds the
   *  BIOS a platform needs without it being copied there by hand. Read-only as
   *  far as the server is concerned, and a failure never fails a launch: most
   *  platforms need no firmware at all. */
  useRommFirmware: boolean;
  /** Root for the per-game directories an emulator is pointed at for save data.
   *  Keeping saves out of the cache protects them from its eviction, and out of
   *  the library from being scanned. Defaults to userData/save-data. */
  saveDataPath: string | null;
  /** Move saves between the server and the emulator around a native launch.
   *  Reads as "the server is the source of truth, minus anything it has not
   *  seen": a save the server has and this device has not seen is pulled before
   *  the emulator starts, whatever the emulator writes is pushed after it exits,
   *  and a slot that moved on is archived rather than overwritten. Turning it
   *  off leaves the local files exactly where they are. */
  syncSaves: boolean;
  /** Mirror the savestates a native launch writes into RomM, after it exits.
   *  One way only: states go up, nothing comes down and nothing is deleted,
   *  because a state belongs to the core and build that wrote it and is not
   *  something to resume from on another machine. Each slot lands under a name
   *  of its own, so a run rewrites that slot rather than adding to a pile. */
  syncStates: boolean;
  /** How often the built-in RetroArch launch is asked to write the save to
   *  disk, in seconds. RetroArch otherwise writes it once, when the content
   *  closes, which is a single moment for a crash or a launcher that exits
   *  early to cost a whole session's progress. Asked for with --appendconfig,
   *  so the user's own retroarch.cfg is left alone, and only on the built-in
   *  path: a configured emulator sets its own. Zero leaves the setting
   *  untouched. */
  retroarchAutosaveSeconds: number;
  /** Repeat the emulator's own output in the shell's log, and ask the built-in
   *  RetroArch launch to be verbose. Off by default: an emulator is chatty, and
   *  this is for the launch nobody can explain, where RetroArch naming the save
   *  file it resolved and whether it wrote one is the answer the shell cannot
   *  work out by watching a file. */
  logEmulatorOutput: boolean;
  /** Report how long the emulator ran to RomM's play session list, so a native
   *  launch counts towards the playtime the server keeps for a game. The server
   *  can see a ROM being downloaded; it cannot see it being played, so without
   *  this a game played here reads as never played at all. A session that cannot
   *  be sent is queued and offered again later, so turning this off is the only
   *  thing that stops one being recorded. */
  trackPlaySessions: boolean;
  /** Shortest run that counts as having played something. A launch that fails
   *  after the emulator starts exits in seconds, and recording those would move
   *  the ROM's "last played", mark it as now playing, and rewind a finished
   *  status back to incomplete for a game nobody played. */
  minPlaySessionSeconds: number;
  /** This machine's id in the user's RomM device list, written by the shell the
   *  first time it syncs and never typed by hand. Clearing it makes the next
   *  launch register a new device, which starts with no sync history: nothing is
   *  lost, but the first negotiation after it falls back to comparing
   *  timestamps, so a save that exists on both sides in different versions is
   *  archived rather than merged. */
  deviceId: string | null;
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

/**
 * Behaviour a shell declares that the presence of a method cannot express: a
 * field of `LaunchRequest` it honours, a `LaunchState` field it populates, a
 * change to what an existing method does. A renderer reads this list; it never
 * parses `shellVersion`, which is for display and support only.
 */
export type ShellCapability =
  /** LaunchState carries `stage`, `core` and `emulator`, so a renderer can name
   *  what a wait is for rather than reporting every wait as a ROM download. */
  | "launch-stage"
  /** LaunchRequest's `serverPath` and `fileSize` are honoured, so a ROM already
   *  on this disk is launched in place rather than downloaded back to it. */
  | "library-passthrough"
  /** getPlatformSupportAll answers a whole library in one call. */
  | "platform-support-all"
  /** The RomM firmware library is mirrored beside the game, reported as the
   *  "firmware" launch stage with the file named in `firmware`. */
  | "firmware-mirror"
  /** A rom of two or more discs is fetched as those files and booted from a
   *  playlist or its first disc, with each transfer reported by `file`,
   *  `fileIndex` and `fileCount` rather than as one restarting download. */
  | "multi-disc"
  /** Saves are moved between the server and the emulator around a native
   *  launch: the save pull is reported as the "save" launch stage, and what
   *  happened to a save afterwards as a "sync" status carrying `sync`. A shell
   *  without this capability leaves both sides of it undone. Savestates are a
   *  separate setting and travel one way, so they report nothing here. */
  | "save-sync"
  /** How long the emulator ran is reported to RomM's play session list, and
   *  carried on the "exited" state as `play`. A shell without this leaves a
   *  native launch out of the server's playtime entirely. */
  | "play-sessions"
  /** `LaunchRequest.fullscreen` is honoured, so a page offering the choice for
   *  its own player can offer it for a native launch too. Only the built-in
   *  RetroArch path can act on it. */
  | "launch-fullscreen";

// The list itself lives in the preload, which is the only file that ships it:
// a sandboxed preload cannot import a value, so it cannot read one from here.

/** The API the preload bridge exposes to the renderer as window.rommNative. */
export interface RommNativeBridge {
  readonly shellVersion: string;
  readonly os: "darwin" | "win32" | "linux";
  /** Typed as plain strings, not ShellCapability: a renderer built against an
   *  older copy of this file must be able to read a newer shell's list without
   *  the unknown entries being a type error. */
  readonly capabilities: readonly string[];
  launch(request: LaunchRequest): Promise<LaunchResult>;
  cancel(romId: number): Promise<void>;
  getPlatformSupport(query: PlatformSupportQuery): Promise<PlatformSupport>;
  /** Answer for many platforms at once, keyed by platform slug. A renderer that
   *  marks every tile in a library needs one call, not one per platform. */
  getPlatformSupportAll(
    queries: PlatformSupportQuery[],
  ): Promise<Record<string, PlatformSupport>>;
  /** Subscribe to launch progress. Returns an unsubscribe function. */
  onLaunchState(listener: (state: LaunchState) => void): () => void;
  openSettings(): Promise<void>;
}
