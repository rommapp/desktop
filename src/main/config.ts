import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  coresCandidates,
  defaultCoresPath,
  retroarchCandidates,
} from "./emulator/locations.ts";
import {
  DEFAULT_CACHE_LIMIT_BYTES,
  type DesktopConfig,
} from "../shared/types.ts";
import { DEFAULT_MINIMUM_PLAY_SECONDS } from "./play/session.ts";
import { QUEUE_FILE } from "./play/queue.ts";
import { DEFAULT_RETROARCH_AUTOSAVE_SECONDS } from "./saves/retroarch.ts";

const CONFIG_FILE = "desktop-config.json";

function emptyConfig(): DesktopConfig {
  return {
    serverUrl: null,
    retroarchPath: null,
    retroarchCoresPath: null,
    autoInstallCores: true,
    offerRetroArchInstall: true,
    useDetectedEmulators: true,
    offerStandaloneInstall: true,
    preferredCores: {},
    emulatorsBasePath: null,
    emulators: [],
    cachePath: null,
    biosPath: null,
    useRommFirmware: true,
    saveDataPath: null,
    // On like the firmware mirror: both are the shell doing what the server
    // already knows how to do, and both fail quietly rather than failing a
    // launch, so the cost of the default being wrong is one setting away.
    syncSaves: true,
    // On for the same reason again, and safe to be: a state is only ever sent,
    // never fetched over a local one, and each slot keeps one row rather than
    // growing one per run.
    syncStates: true,
    retroarchAutosaveSeconds: DEFAULT_RETROARCH_AUTOSAVE_SECONDS,
    logEmulatorOutput: false,
    // On for the same reason: the server already keeps playtime, a native launch
    // is the one play it cannot see, and a failure costs a queued row rather
    // than a launch.
    trackPlaySessions: true,
    minPlaySessionSeconds: DEFAULT_MINIMUM_PLAY_SECONDS,
    deviceId: null,
    libraryPath: null,
    cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
    fullscreen: false,
    trustedCertificates: [],
  };
}

function firstExisting(paths: string[]): string | null {
  return paths.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Fill in anything the user has not configured by probing the filesystem, so a
 * standard RetroArch install works with no setup.
 */
export function withDetectedDefaults(config: DesktopConfig): DesktopConfig {
  const home = homedir();
  const retroarchPath =
    config.retroarchPath ?? firstExisting(retroarchCandidates(undefined, home));
  return {
    ...config,
    retroarchPath,
    // Falling back to where cores belong, not just where they already are: a
    // RetroArch that has never been run has no cores directory, and treating
    // that as "nowhere to put cores" would switch core downloading off for
    // exactly the fresh install the shell may have just offered to set up.
    retroarchCoresPath:
      config.retroarchCoresPath ??
      firstExisting(coresCandidates(retroarchPath, undefined, home)) ??
      defaultCoresPath(retroarchPath, undefined, home),
    cachePath: config.cachePath ?? join(app.getPath("userData"), "rom-cache"),
    biosPath: config.biosPath ?? join(app.getPath("userData"), "bios"),
    saveDataPath:
      config.saveDataPath ?? join(app.getPath("userData"), "save-data"),
  };
}

export function configPath(): string {
  return join(app.getPath("userData"), CONFIG_FILE);
}

/** Where play sessions wait for a server that will take them. Beside the config
 *  rather than under a configurable root: it is bookkeeping the shell owns, not
 *  content a user would want to place. */
export function playQueuePath(): string {
  return join(app.getPath("userData"), QUEUE_FILE);
}

let cached: DesktopConfig | null = null;
let cachedStamp: string | null = null;

/** Identify a particular version of the file on disk. Size is included because
 *  two edits can land within one millisecond on a coarse clock. */
async function fileStamp(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

export async function loadConfig(): Promise<DesktopConfig> {
  const target = configPath();
  const stamp = await fileStamp(target);
  // Re-read whenever the file has moved underneath us. Holding the first read
  // forever meant every settings change needed a restart, and made an edit made
  // while the app was running vanish on the next save.
  if (cached && stamp === cachedStamp) {
    // Detection is the one part of the config that goes stale without the file
    // changing: an emulator installed while the app is running would otherwise
    // not be found until a restart. That matters most right after the shell has
    // offered to install one, where the answer to "I just installed it" cannot
    // be "now quit and reopen". Only re-probed while something is still
    // missing, so the ordinary case stays a cache hit.
    if (!cached.retroarchPath || !cached.retroarchCoresPath) {
      cached = withDetectedDefaults(cached);
    }
    return cached;
  }

  try {
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopConfig>;
    cached = withDetectedDefaults({ ...emptyConfig(), ...parsed });
  } catch {
    // A missing or corrupt config is not fatal: fall back to detection and let
    // the next save rewrite the file.
    cached = withDetectedDefaults(emptyConfig());
  }
  cachedStamp = stamp;
  return cached;
}

export async function saveConfig(next: DesktopConfig): Promise<void> {
  cached = next;
  const target = configPath();
  await mkdir(dirname(target), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated config.
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2), "utf8");
  await rename(temp, target);
  // Record what we just wrote, so our own save does not read as someone else's
  // edit on the next load.
  cachedStamp = await fileStamp(target);
}

export async function updateConfig(
  patch: Partial<DesktopConfig>,
): Promise<DesktopConfig> {
  const next = { ...(await loadConfig()), ...patch };
  await saveConfig(next);
  return next;
}
