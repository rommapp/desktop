import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_CACHE_LIMIT_BYTES,
  type DesktopConfig,
} from "../shared/types.ts";

const CONFIG_FILE = "desktop-config.json";

function emptyConfig(): DesktopConfig {
  return {
    serverUrl: null,
    retroarchPath: null,
    retroarchCoresPath: null,
    autoInstallCores: true,
    offerRetroArchInstall: true,
    emulatorsBasePath: null,
    emulators: [],
    cachePath: null,
    saveDataPath: null,
    libraryPath: null,
    cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
    fullscreen: false,
    trustedCertificates: [],
  };
}

/** Common install locations, most specific first. */
function retroarchCandidates(): string[] {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/RetroArch.app/Contents/MacOS/RetroArch",
        join(home, "Applications/RetroArch.app/Contents/MacOS/RetroArch"),
      ];
    case "win32": {
      // RetroArch ships portable about as often as it is installed, and
      // frontends bundle their own copy, so cover the usual roots. An install
      // on another drive still needs retroarchPath set by hand.
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
      const programFilesX86 =
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      const localAppData =
        process.env.LOCALAPPDATA ?? join(home, "AppData\\Local");
      return [
        "C:\\RetroArch-Win64\\retroarch.exe",
        join(programFiles, "RetroArch\\retroarch.exe"),
        join(programFilesX86, "RetroArch\\retroarch.exe"),
        join(localAppData, "Programs\\RetroArch\\retroarch.exe"),
        join(home, "scoop\\apps\\retroarch\\current\\retroarch.exe"),
        join(
          programFilesX86,
          "Steam\\steamapps\\common\\RetroArch\\retroarch.exe",
        ),
        join(
          programFiles,
          "Steam\\steamapps\\common\\RetroArch\\retroarch.exe",
        ),
        "C:\\RetroBat\\emulators\\retroarch\\retroarch.exe",
      ];
    }
    default:
      return [
        "/usr/bin/retroarch",
        "/usr/local/bin/retroarch",
        join(home, ".local/bin/retroarch"),
      ];
  }
}

function coresCandidates(retroarchPath: string | null): string[] {
  const home = homedir();
  const candidates: string[] = [];
  switch (process.platform) {
    case "darwin":
      candidates.push(
        join(home, "Library/Application Support/RetroArch/cores"),
      );
      break;
    case "win32": {
      // A portable install keeps cores beside the binary; an installed one puts
      // them under the user profile. Probe both, so the cores directory can
      // still be found when the binary was set by hand or not found at all.
      const appData = process.env.APPDATA ?? join(home, "AppData\\Roaming");
      const localAppData =
        process.env.LOCALAPPDATA ?? join(home, "AppData\\Local");
      if (retroarchPath) candidates.push(join(dirname(retroarchPath), "cores"));
      candidates.push(
        join(appData, "RetroArch\\cores"),
        join(localAppData, "RetroArch\\cores"),
      );
      break;
    }
    default:
      candidates.push(
        join(home, ".config/retroarch/cores"),
        join(home, ".var/app/org.libretro.RetroArch/config/retroarch/cores"),
        "/usr/lib/libretro",
        "/usr/lib/x86_64-linux-gnu/libretro",
      );
  }
  return candidates;
}

function firstExisting(paths: string[]): string | null {
  return paths.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Fill in anything the user has not configured by probing the filesystem, so a
 * standard RetroArch install works with no setup.
 */
export function withDetectedDefaults(config: DesktopConfig): DesktopConfig {
  const retroarchPath =
    config.retroarchPath ?? firstExisting(retroarchCandidates());
  return {
    ...config,
    retroarchPath,
    retroarchCoresPath:
      config.retroarchCoresPath ??
      firstExisting(coresCandidates(retroarchPath)),
    cachePath: config.cachePath ?? join(app.getPath("userData"), "rom-cache"),
    saveDataPath:
      config.saveDataPath ?? join(app.getPath("userData"), "save-data"),
  };
}

export function configPath(): string {
  return join(app.getPath("userData"), CONFIG_FILE);
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
  if (cached && stamp === cachedStamp) return cached;

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
