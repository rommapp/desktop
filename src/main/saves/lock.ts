// One turn at a time with a save file.
//
// The shell touches a game's save at two moments -- once before the emulator
// starts and once after it exits -- and the emulator itself is between them,
// not inside either. That is fine until the two moments belong to different
// launches: the push after a game exits is deliberately detached, so pressing
// Play again straight away can have the next launch negotiating and renaming
// the server's copy over the file while the previous launch is still reading
// it to upload. The bytes that reach the server are then the ones the player
// has not finished making yet, or half of each.
//
// Not `oneAtATime` from the firmware queue, which exists to give a second
// caller the first's answer. Two launches asking for the same firmware mirror
// want one shared result; a pull and a push are different work with different
// results, and sharing one for the other is not a saving, it is a bug.

/** The turn in progress for each save file, settled either way. */
const turns = new Map<string, Promise<void>>();

/**
 * Run `work` once whatever else is holding this save file has finished.
 *
 * The wait is not abortable, unlike the firmware queue's. What is being queued
 * behind is one small request about one save, so a launch that waits for it
 * waits briefly; releasing the file early to a launch that asked to stop would
 * hand the next one a save mid-write, which is the whole thing this prevents.
 *
 * A turn that throws still ends: the next caller inherits the file, not the
 * failure.
 */
export function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const ahead = turns.get(key) ?? Promise.resolve();

  // Chained and registered synchronously, before any await can yield, so two
  // callers in the same tick queue behind each other rather than both deciding
  // they are first.
  const mine = ahead.then(work);
  const turn = mine.then(
    () => undefined,
    () => undefined,
  );
  turns.set(key, turn);
  // Cleared only if this is still the newest, so a caller waiting on a later
  // turn keeps waiting on the right one.
  void turn.then(() => {
    if (turns.get(key) === turn) turns.delete(key);
  });

  return mine;
}
