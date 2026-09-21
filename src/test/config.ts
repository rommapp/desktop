import {
  DEFAULT_CACHE_LIMIT_BYTES,
  type DesktopConfig,
} from "../shared/types.ts";
import { DEFAULT_MINIMUM_PLAY_SECONDS } from "../main/play/session.ts";
import { DEFAULT_RETROARCH_AUTOSAVE_SECONDS } from "../main/saves/retroarch.ts";

/** A complete DesktopConfig for a test to spread its own fields over. Every
 *  field is listed so that adding one to DesktopConfig fails the typecheck
 *  here, in one place, rather than leaving fixtures quietly undefined where
 *  loadConfig would have supplied a null. */
export function testConfig(patch: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverUrl: "https://romm.example.com",
    retroarchPath: null,
    retroarchCoresPath: null,
    autoInstallCores: true,
    offerRetroArchInstall: true,
    preferredCores: {},
    // Both off by default: detection reads the real filesystem, so leaving them
    // on would make a host that happens to have Dolphin installed see different
    // results from one that does not.
    useDetectedEmulators: false,
    offerStandaloneInstall: false,
    emulatorsBasePath: null,
    emulators: [],
    cachePath: null,
    // Off and unset by default: the mirror reaches the network and the
    // filesystem, so a test that wants it says so.
    biosPath: null,
    useRommFirmware: false,
    saveDataPath: null,
    // Off and unset by default: save sync negotiates with the server, so a test
    // that wants it says so.
    syncSaves: false,
    syncStates: false,
    retroarchAutosaveSeconds: DEFAULT_RETROARCH_AUTOSAVE_SECONDS,
    logEmulatorOutput: false,
    // Off by default: reporting a play session reaches the network, so a test
    // that wants it says so.
    trackPlaySessions: false,
    minPlaySessionSeconds: DEFAULT_MINIMUM_PLAY_SECONDS,
    deviceId: null,
    libraryPath: null,
    cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
    fullscreen: false,
    trustedCertificates: [],
    ...patch,
  };
}
