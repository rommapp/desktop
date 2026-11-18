// This file cannot be split, and imports nothing but types. A sandboxed
// preload's require() serves the electron module and a handful of Node
// builtins; a relative path throws "module not found" and takes the whole
// bridge with it. So the few lines that read a reply live here, and only the
// shape they read comes from shared/ipc.ts.

import { contextBridge, ipcRenderer } from "electron";
import type { IpcReply } from "../shared/ipc.ts";
import type {
  LaunchRequest,
  LaunchResult,
  LaunchState,
  PlatformSupport,
  PlatformSupportQuery,
  RommNativeBridge,
  ShellCapability,
} from "../shared/types.ts";

/**
 * What this shell declares to the page, listed here because this is the only
 * file that ships them and a sandboxed preload cannot import a value.
 *
 * A record rather than an array so the compiler rejects a capability declared
 * in ShellCapability and forgotten here: an unlisted one is undetectable, and
 * a frontend cannot tell that from a shell too old to have it.
 */
const ALL_CAPABILITIES = {
  "launch-stage": true,
  "library-passthrough": true,
  "platform-support-all": true,
  "firmware-mirror": true,
  "multi-disc": true,
  "disc-choice": true,
  "save-sync": true,
  "state-restore": true,
  "play-sessions": true,
  "launch-fullscreen": true,
} satisfies Record<ShellCapability, true>;

// Object.keys loses the key type, and the satisfies above is what makes this
// narrowing sound: the record's keys are exactly ShellCapability.
const CAPABILITIES = Object.keys(ALL_CAPABILITIES) as ShellCapability[];

const VERSION_FLAG = "--romm-shell-version=";

function shellVersion(): string {
  const flag = process.argv.find((arg) => arg.startsWith(VERSION_FLAG));
  return flag ? flag.slice(VERSION_FLAG.length) : "0.0.0";
}

const LAUNCH_STATE_CHANNEL = "romm:launch-state";

/**
 * Invoke a channel and read its reply, so a failure rejects with the message
 * the launcher actually wrote and none of Electron's remote-method plumbing in
 * front of it. A page that prints what it caught gets the sentence the user is
 * meant to read; a page that wants to branch on the failure reads `code`.
 *
 * What is thrown is the main process's LaunchFailure as it arrived, and it is
 * a plain object rather than an Error on purpose: the context bridge copies an
 * Error's message and stack and drops everything else, so an Error built here
 * would reach the page with its code missing.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply: IpcReply<T> = await ipcRenderer.invoke(channel, ...args);
  if (reply.ok) return reply.value;
  throw reply.error;
}

const bridge: RommNativeBridge = {
  shellVersion: shellVersion(),
  os: process.platform as RommNativeBridge["os"],
  capabilities: CAPABILITIES,

  launch: (request: LaunchRequest): Promise<LaunchResult> =>
    invoke("romm:launch", request),

  cancel: (romId: number): Promise<void> => invoke("romm:cancel", romId),

  getPlatformSupport: (query: PlatformSupportQuery): Promise<PlatformSupport> =>
    invoke("romm:platform-support", query),

  getPlatformSupportAll: (
    queries: PlatformSupportQuery[],
  ): Promise<Record<string, PlatformSupport>> =>
    invoke("romm:platform-support-all", queries),

  onLaunchState: (listener: (state: LaunchState) => void): (() => void) => {
    // The Electron event object never reaches the renderer: only the payload
    // crosses the bridge, so the page cannot reach back through event.sender.
    const handler = (_event: unknown, state: LaunchState) => listener(state);
    ipcRenderer.on(LAUNCH_STATE_CHANNEL, handler);
    return () => ipcRenderer.off(LAUNCH_STATE_CHANNEL, handler);
  },

  openSettings: (): Promise<void> => invoke("romm:open-settings"),
};

/**
 * Runs in the page's own world, so it is serialized and may reference nothing
 * outside itself.
 *
 * The context bridge copies every argument the page passes, and it refuses a
 * Proxy outright, synchronously, with "An object could not be cloned". RomM's
 * frontend is a Vue app, so the core lists it sends are reactive proxies, and
 * exposing the bridge directly made every support probe throw: the frontend
 * caught it, kept an empty support table, and hid native play for every game.
 * Copying to plain data on the page's side of the bridge, before the crossing,
 * is the only place that can fix it, since the preload never sees the call.
 * JSON is enough for these arguments, and the main process validates them
 * whatever they contain.
 */
function installBridge(raw: RommNativeBridge): void {
  const plain = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  const api: RommNativeBridge = Object.freeze({
    shellVersion: raw.shellVersion,
    os: raw.os,
    capabilities: Object.freeze([...raw.capabilities]) as ShellCapability[],
    launch: (request: LaunchRequest) => raw.launch(plain(request)),
    cancel: (romId: number) => raw.cancel(plain(romId)),
    getPlatformSupport: (query: PlatformSupportQuery) =>
      raw.getPlatformSupport(plain(query)),
    getPlatformSupportAll: (queries: PlatformSupportQuery[]) =>
      raw.getPlatformSupportAll(plain(queries)),
    onLaunchState: (listener: (state: LaunchState) => void) =>
      raw.onLaunchState(listener),
    openSettings: () => raw.openSettings(),
  });
  // Read-only and fixed, as exposeInMainWorld would have left it.
  Object.defineProperty(window, "rommNative", { value: api, enumerable: true });
}

contextBridge.executeInMainWorld({ func: installBridge, args: [bridge] });
