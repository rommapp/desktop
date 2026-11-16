import { app } from "electron";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withDetectedDefaults } from "./config-defaults.ts";
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
    standaloneDataPaths: {},
    cachePath: null,
    biosPath: null,
    useRommFirmware: true,
    saveDataPath: null,
    // On like the firmware mirror: both are the shell doing what the server
    // already knows how to do, and both fail quietly rather than failing a
    // launch, so the cost of the default being wrong is one setting away.
    syncSaves: true,
    // On for the same reason again: a slot's own bytes go up before anything
    // replaces them, and a state this machine pushed is not fetched back.
    syncStates: true,
    syncMemoryCards: true,
    syncScreenshots: true,
    acceptRemoteInstalls: true,
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

/** The detected view of a config the user wrote. */
function detected(config: DesktopConfig): DesktopConfig {
  return withDetectedDefaults(config, {
    home: homedir(),
    userData: app.getPath("userData"),
  });
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

/** What the file says, with a default for every key it leaves out. This is the
 *  only thing ever written back; see config-defaults.ts for why. */
let userValues: DesktopConfig | null = null;
/** userValues with detection applied, which is what every caller is handed. */
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

async function readUserValues(): Promise<DesktopConfig> {
  const target = configPath();
  const stamp = await fileStamp(target);
  // Re-read whenever the file has moved underneath us. Holding the first read
  // forever meant every settings change needed a restart, and made an edit made
  // while the app was running vanish on the next save.
  if (userValues && stamp === cachedStamp) return userValues;
  try {
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopConfig>;
    userValues = { ...emptyConfig(), ...parsed };
  } catch {
    // A missing or corrupt config is not fatal: fall back to detection and let
    // the next save rewrite the file.
    userValues = emptyConfig();
  }
  cached = null;
  cachedStamp = stamp;
  return userValues;
}

export async function loadConfig(): Promise<DesktopConfig> {
  const values = await readUserValues();
  // Detection is the one part of the config that goes stale without the file
  // changing: an emulator installed while the app is running would otherwise
  // not be found until a restart. That matters most right after the shell has
  // offered to install one, where the answer to "I just installed it" cannot
  // be "now quit and reopen". Only re-probed while something is still
  // missing, so the ordinary case stays a cache hit.
  if (!cached || !cached.retroarchPath || !cached.retroarchCoresPath) {
    cached = detected(values);
  }
  return cached;
}

async function writeUserValues(next: DesktopConfig): Promise<void> {
  const target = configPath();
  await mkdir(dirname(target), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated config.
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2), "utf8");
  await rename(temp, target);
  userValues = next;
  cached = null;
  // Record what we just wrote, so our own save does not read as someone else's
  // edit on the next load.
  cachedStamp = await fileStamp(target);
}

/**
 * Write the config file out, so there is one to open.
 *
 * A config that has only ever been defaults was never written. Every key is
 * listed, with null for a path left to detection, so the file shows what can
 * be set; what detection found goes to the log instead.
 */
export async function ensureConfigFile(): Promise<string> {
  const values = await readUserValues();
  await writeUserValues(values);
  const view = await loadConfig();
  console.info(
    `[config] detected: retroarchPath ${view.retroarchPath ?? "none"}, retroarchCoresPath ${view.retroarchCoresPath ?? "none"}`,
  );
  return configPath();
}

/** Change the values the user owns, and hand back the detected view. */
export async function updateConfig(
  patch: Partial<DesktopConfig>,
): Promise<DesktopConfig> {
  await writeUserValues({ ...(await readUserValues()), ...patch });
  return loadConfig();
}
