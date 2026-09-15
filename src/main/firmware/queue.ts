// One sync per platform at a time, and its result shared.
//
// Firmware belongs to a platform rather than to a game, so two launches can ask
// for the same mirror at once -- pressing Play on a second PS1 game while the
// first is still starting is an ordinary thing to do. Left to run side by side
// they would write the same temporary file, interleave their bytes, and each
// rename it out from under the other.
//
// Kept free of Electron imports, and generic over the work it runs, because
// this is the subtle part: what it does under a cancel and under someone else's
// failure is worth checking directly rather than reasoning about once.

import { LaunchError } from "../../shared/types.ts";

/** Work in flight, by the key that must not have two of them. */
const running = new Map<string, Promise<unknown>>();

/**
 * Run `work`, or take the result of the run already under way for this key.
 *
 * The second caller takes the first's result rather than repeating it. Running
 * the same requests again to be told the mirror is already correct is work
 * nobody asked for, and the answer it wants is precisely what the first call is
 * producing.
 *
 * What it does not do is inherit the first caller's fate:
 *
 * - Waiting is abortable, so a launch cancelled while queued behind a 200MB
 *   transfer stops there rather than after it. That is the one wait a user has
 *   already said they do not want.
 *
 * - A run that fails for its own reasons -- the first launch's cancel, most
 *   likely -- leaves this caller to try for itself, rather than reporting a
 *   failure that was never its own.
 *
 * One process is enough to reason about because the app holds a single-instance
 * lock.
 */
export async function oneAtATime<T>(
  key: string,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const inFlight = running.get(key) as Promise<T> | undefined;
  if (inFlight) {
    try {
      return await untilSettledOrCancelled(inFlight, signal);
    } catch (error) {
      // This caller's own cancel is the launch's, and has to reach it.
      if (signal.aborted) throw error;
      // Otherwise the failure belonged to the run that was already going, and
      // there is nothing in it about whether this one would succeed.
    }
  }

  // Registered synchronously, before the first await inside work can yield, so
  // two callers in the same tick cannot both decide they are the first.
  const started = work();
  running.set(key, started);
  try {
    return await started;
  } finally {
    // Cleared only if this is still the newest, so a caller waiting on a later
    // run keeps waiting on the right promise.
    if (running.get(key) === started) running.delete(key);
  }
}

/**
 * Wait for someone else's work, but only for as long as this launch lasts.
 *
 * Exported for its own tests: the abort listener is removed on either outcome,
 * which is the part that would otherwise accumulate one listener per launch on
 * a signal that outlives them.
 */
export function untilSettledOrCancelled<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    // Detached before this promise settles rather than after, so the listener
    // is already gone by the time the caller resumes. Chaining a .finally
    // instead leaves it attached for a microtask longer, which is the sort of
    // thing that is true for a while and then quietly is not.
    const detach = () => signal.removeEventListener("abort", onAbort);
    promise.then(
      (value) => {
        detach();
        resolve(value);
      },
      (error: unknown) => {
        detach();
        reject(error);
      },
    );
  });
}

/** The launch's own cancellation, so a cancel reads as one rather than as a
 *  firmware failure that happened to coincide with it. */
function cancelled(): LaunchError {
  return new LaunchError("download-failed", "Launch cancelled");
}
