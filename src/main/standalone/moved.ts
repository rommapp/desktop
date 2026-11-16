// Save folders that an emulator's own settings have moved.
//
// data.ts knows where each emulator keeps saves by default. A frontend does
// not leave them there: RetroBat rewrites PCSX2's memory card and savestate
// folders, Dolphin's GCI folder and NAND root, Cemu's mlc_path and RPCS3's
// dev_hdd0 into its own saves tree before every game it starts, and EmuDeck
// moves RPCS3's dev_hdd0 the same way. The settings stay written afterwards,
// so the emulator keeps using those folders when the shell starts it too. A
// launch that trusted the default would restore a save the emulator never
// reads and report every save after it as unchanged.
//
// So the emulator's own config is read, and it wins over the default. That is
// the same rule this repository holds for RetroArch: the emulator, not the
// shell, decides where its files go, so find them rather than assume them.
//
// A value this cannot read, or one that is relative where the emulator would
// resolve it against something other than its folder, is left alone and the
// default stands. Moving a launch's saves to a guess would be worse than
// leaving them where they were.
//
// Pure: the config text arrives through a reader, so every case is testable
// without a filesystem.

import { posix, win32 } from "node:path";

/** Reads a config file's text, or null when it is not there. */
export type ReadText = (path: string) => string | null;

export interface MovedFolders {
  /** This platform's saves, absolute, when the config moves them. */
  saveDir?: string;
  /** Its savestates, absolute, when the config moves them. */
  stateDir?: string;
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function isAbsoluteAnywhere(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

/** A value from an INI file, by section and key, matched without regard to
 *  case as the emulators that write these do. */
export function iniValue(
  ini: string,
  section: string,
  key: string,
): string | null {
  let current = "";
  for (const line of ini.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      current = (header[1] ?? "").trim().toLowerCase();
      continue;
    }
    if (current !== section.toLowerCase()) continue;
    const setting = /^([^=]+)=(.*)$/.exec(trimmed);
    if (!setting || (setting[1] ?? "").trim().toLowerCase() !== key.toLowerCase())
      continue;
    const value = (setting[2] ?? "").trim().replace(/^"(.+)"$/, "$1");
    return value || null;
  }
  return null;
}

/** The text of a simple XML element, or null when it is absent or empty. */
export function xmlElement(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * A scalar as YAML writes it: quoted, or plain with an optional trailing
 * comment. Undefined for a form this does not decode, so the caller can
 * decline rather than guess.
 */
export function yamlScalar(raw: string): string | undefined {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end < 0) return undefined;
    const value = text.slice(1, end);
    // Escapes and doubled quotes are not decoded.
    if (quote === '"' && value.includes("\\")) return undefined;
    if (text[end + 1] === quote) return undefined;
    const rest = text.slice(end + 1).trim();
    return rest === "" || rest.startsWith("#") ? value : undefined;
  }
  // A plain scalar's comment starts at a "#" after whitespace.
  return text.replace(/(^|\s)#.*$/, "").trim();
}

/** One value out of vfs.yml's flat `key: value` lines: null when the key is
 *  absent, undefined when its value cannot be decoded. */
function vfsValue(yml: string, key: string): string | null | undefined {
  for (const line of yml.split(/\r?\n/)) {
    const separator = line.indexOf(": ");
    if (separator < 0) continue;
    if (yamlScalar(line.slice(0, separator)) !== key) continue;
    return yamlScalar(line.slice(separator + 2));
  }
  return null;
}

/**
 * Where one of RPCS3's virtual devices is, given its folder and its vfs.yml,
 * or null when the configured path cannot be resolved to an absolute one.
 *
 * `$(EmulatorDir)` stands for RPCS3's folder unless vfs.yml sets it too.
 */
export function vfsDirectory(
  folder: string,
  vfsYml: string | null,
  device: "/dev_flash/" | "/dev_hdd0/",
): string | null {
  const emulatorDirValue = vfsYml ? vfsValue(vfsYml, "$(EmulatorDir)") : null;
  const deviceValue = vfsYml ? vfsValue(vfsYml, device) : null;
  if (emulatorDirValue === undefined || deviceValue === undefined) {
    return null;
  }
  const emulatorDir = emulatorDirValue || folder;
  const withSlash = /[/\\]$/.test(emulatorDir)
    ? emulatorDir
    : `${emulatorDir}/`;
  const configured = deviceValue || `$(EmulatorDir)${device.slice(1)}`;
  const path = configured.split("$(EmulatorDir)").join(withSlash);
  return isAbsoluteAnywhere(path) ? path : null;
}

/** RPCS3's vfs.yml: under config/ in newer builds, beside everything else in
 *  older ones. */
export function readVfsYml(
  folder: string,
  platform: NodeJS.Platform,
  read: ReadText,
): string | null {
  const path = pathFor(platform);
  return (
    read(path.join(folder, "config", "vfs.yml")) ??
    read(path.join(folder, "vfs.yml"))
  );
}

const GC_REGIONS = new Set(["usa", "eur", "jap", "jpn", "kor"]);

/**
 * The GameCube save root a configured GCI folder belongs to.
 *
 * Dolphin's own default is GC/<region>/Card A under its user folder, and the
 * save root data.ts uses is the GC folder above both. RetroBat writes the
 * override with the region on the end; a user may write it with or without
 * either part. Stepping up past whichever are there lands on the same root.
 */
function gcRoot(platform: NodeJS.Platform, gciFolder: string): string {
  const path = pathFor(platform);
  let root = gciFolder.replace(/[/\\]+$/, "");
  if (/^card [ab]$/i.test(path.basename(root))) root = path.dirname(root);
  if (GC_REGIONS.has(path.basename(root).toLowerCase())) {
    root = path.dirname(root);
  }
  return root;
}

/**
 * The save and state folders this emulator's config moves, for a launch of
 * this platform. Empty when it moves nothing, or when what it says cannot be
 * trusted; see the header.
 */
export function movedFolders(options: {
  emulatorId: string;
  platformSlug: string;
  /** The emulator's user folder, as data.ts located it. */
  folder: string;
  platform: NodeJS.Platform;
  read: ReadText;
}): MovedFolders {
  const { emulatorId, folder, platform, read } = options;
  const path = pathFor(platform);
  const platformSlug = options.platformSlug.toLowerCase();

  switch (emulatorId) {
    case "pcsx2": {
      const ini = read(path.join(folder, "inis", "PCSX2.ini"));
      if (!ini) return {};
      // PCSX2 resolves a relative folder against its own, so both forms are
      // safe to follow.
      const resolve = (value: string | null) =>
        value === null
          ? undefined
          : isAbsoluteAnywhere(value)
            ? value
            : path.join(folder, value);
      const saveDir = resolve(iniValue(ini, "Folders", "MemoryCards"));
      const stateDir = resolve(iniValue(ini, "Folders", "SaveStates"));
      return {
        ...(saveDir ? { saveDir } : {}),
        ...(stateDir ? { stateDir } : {}),
      };
    }
    case "dolphin": {
      const ini = read(path.join(folder, "Config", "Dolphin.ini"));
      if (!ini) return {};
      if (platformSlug === "wii") {
        const nand = iniValue(ini, "General", "NANDRootPath");
        return nand && isAbsoluteAnywhere(nand)
          ? { saveDir: path.join(nand, "title") }
          : {};
      }
      const gci = iniValue(ini, "Core", "GCIFolderAPath");
      return gci && isAbsoluteAnywhere(gci)
        ? { saveDir: gcRoot(platform, gci) }
        : {};
    }
    case "cemu": {
      const xml = read(path.join(folder, "settings.xml"));
      const mlc = xml ? xmlElement(xml, "mlc_path") : null;
      return mlc && isAbsoluteAnywhere(mlc)
        ? { saveDir: path.join(mlc, "usr", "save") }
        : {};
    }
    case "rpcs3": {
      const yml = readVfsYml(folder, platform, read);
      // No vfs.yml is RPCS3's default layout, which data.ts already has.
      if (!yml) return {};
      const hdd0 = vfsDirectory(folder, yml, "/dev_hdd0/");
      return hdd0
        ? { saveDir: path.join(hdd0, "home", "00000001", "savedata") }
        : {};
    }
    default:
      return {};
  }
}
