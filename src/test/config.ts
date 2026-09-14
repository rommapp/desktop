import {
  DEFAULT_CACHE_LIMIT_BYTES,
  type DesktopConfig,
} from "../shared/types.ts";

/** A complete DesktopConfig for a test to spread its own fields over. Every
 *  field is listed so that adding one to DesktopConfig fails the typecheck
 *  here, in one place, rather than leaving fixtures quietly undefined where
 *  loadConfig would have supplied a null. */
export function testConfig(patch: Partial<DesktopConfig> = {}): DesktopConfig {
  return {
    serverUrl: "https://romm.example.com",
    retroarchPath: null,
    retroarchCoresPath: null,
    emulatorsBasePath: null,
    emulators: [],
    cachePath: null,
    saveDataPath: null,
    libraryPath: null,
    cacheLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
    fullscreen: false,
    trustedCertificates: [],
    ...patch,
  };
}
