// How an answer from the main process crosses the preload bridge.
//
// Rejecting out of an ipcMain handler is the obvious way to report a failure,
// and it is the wrong one: Electron stringifies whatever was thrown into the
// renderer's rejection, so a sentence written for the user arrives as
//
//   Error invoking remote method 'romm:launch': LaunchError: Point at RPCS3...
//
// with the channel name in front of it and the error's code gone, leaving a
// frontend nothing to branch on and no way to print the message without the
// plumbing around it. So a failure is returned as data instead, in the shape
// the launch-state channel already reports one in, and the preload throws it
// on the other side.
//
// The failure is built here rather than in the preload so that what the page
// catches is decided in one tested place, and so the preload -- which cannot
// import this file, being sandboxed -- has nothing left to get wrong.

import { LaunchError, type LaunchFailure } from "./types.ts";

/** Every ipcMain handler answers with one of these. */
export type IpcReply<T> =
  | { ok: true; value: T }
  | { ok: false; error: LaunchFailure };

/** Coerce anything thrown into the error the contract names. */
export function toLaunchError(error: unknown): LaunchError {
  if (error instanceof LaunchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LaunchError("launch-failed", message);
}

/**
 * Run a handler's work and answer with it, however it ends.
 *
 * Never rejects: a rejection here is the one thing the envelope exists to
 * avoid.
 */
export async function replyWith<T>(
  work: () => T | Promise<T>,
): Promise<IpcReply<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const failure = toLaunchError(error);
    return {
      ok: false,
      error: {
        name: "LaunchError",
        code: failure.code,
        message: failure.message,
      },
    };
  }
}
