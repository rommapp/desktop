// This file cannot be split, and imports nothing but types. A sandboxed
// preload's require() serves the electron module and a handful of Node
// builtins; a relative path throws "module not found" and takes the whole
// bridge with it. So the few lines that read a reply live here, and only the
// shape they read comes from shared/ipc.ts.

import { contextBridge, ipcRenderer } from "electron";
import type { IpcReply } from "../shared/ipc.ts";
import {
  type LaunchRequest,
  type LaunchResult,
  type LaunchState,
  type PlatformSupport,
  type PlatformSupportQuery,
  type RommNativeBridge,
  SHELL_CAPABILITIES,
} from "../shared/types.ts";

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
  capabilities: SHELL_CAPABILITIES,

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

contextBridge.exposeInMainWorld("rommNative", bridge);
