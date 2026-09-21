// A repeating look that never overlaps itself.
//
// The save watcher runs on a timer whose interval says how often to look at a
// file, not how much work the shell is willing to have outstanding. A look that
// uploads is a request over the network, and a request can outlast the interval
// that started it: on a slow link, one upload covers several beats. Firing
// regardless would leave a queue of looks nothing is draining, and the moment
// the slow one finished the queue would run end to end -- hashing a save as
// fast as the disk allows, at whatever moment the network happened to recover,
// which is the opposite of the cadence it was given.
//
// So a beat that arrives while a look is still going is dropped. Nothing is
// lost by dropping it: the next beat reads the same file, and the file is only
// ever more current by then.

/** A timer that has been started, and can be stopped. */
export interface Beat {
  /** Stop beating, and wait for a look already underway to finish. */
  stop(): Promise<void>;
}

/**
 * Run `work` every `intervalMs`, one at a time.
 *
 * `work` says whether to carry on: false stops the timer, which is how work
 * that has said everything it has to say ends its own beat without the caller
 * holding a handle to it. Work that throws is neither fatal nor a reason to
 * stop, since the next look is another chance at whatever failed.
 *
 * Unreferenced, because a beat is not a reason to keep the process alive: what
 * is being watched here outlives any single look, and the shell quits when the
 * rest of it is done rather than when the looking is.
 */
export function onBeat(intervalMs: number, work: () => Promise<boolean>): Beat {
  let running: Promise<void> | null = null;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || running !== null) return;
    running = work()
      .then((again) => {
        if (again) return;
        stopped = true;
        clearInterval(timer);
      })
      .catch(() => undefined)
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
