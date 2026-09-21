// The emulator's own account of a run.
//
// RetroArch says out loud what the shell can only infer: which configs it
// appended, which file it resolved SRAM to, and whether it wrote one when the
// content closed. None of that reaches here, because a launch is spawned with
// its output ignored, so a save that never arrives on the server leaves the one
// process that knows why unheard.
//
// Off unless asked for, and capped when it is. An emulator writes a line per
// frame drop, and a shell log nobody can find the launch in is no better than
// no log at all.

/** Lines kept from one launch, after which the capture goes quiet. */
export const MAX_CAPTURED_LINES = 400;

/** How many lines a launch has left, shared by the streams it captures. */
export interface LineBudget {
  /** What to report for this line, or null once the budget is spent. */
  next(line: string): string | null;
}

/**
 * One launch's allowance, spent by stdout and stderr together.
 *
 * Shared rather than one per stream, because the cap is a promise about the
 * launch: a budget each would let a chatty run write twice the limit, and the
 * whole point is a log a launch can still be found in.
 */
export function createLineBudget(
  limit: number = MAX_CAPTURED_LINES,
): LineBudget {
  let taken = 0;
  return {
    next(line: string): string | null {
      if (taken > limit) return null;
      taken += 1;
      return taken > limit ? `... capped at ${limit} lines` : line;
    },
  };
}

/**
 * Split a chunk into whole lines, keeping whatever came after the last newline.
 *
 * A stream hands over bytes, not lines: a line can arrive in two chunks and two
 * lines in one, so the tail of a chunk is held until the newline that ends it
 * turns up.
 */
export function splitLines(
  held: string,
  chunk: string,
): { lines: string[]; rest: string } {
  const parts = (held + chunk).split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.length > 0), rest };
}

export interface LineSink {
  write(chunk: string): void;
  /** Report the last line when the stream ends without a newline. */
  end(): void;
}

/**
 * Collect a child's output into whole lines, spending `budget` as it goes.
 *
 * The line that exhausts the budget says so, so a truncated log reads as
 * truncated rather than as an emulator that went quiet. The held tail is this
 * sink's own: a stream gets a sink of its own precisely so a half line from one
 * is never spliced onto a half line from the other.
 */
export function createLineSink(
  onLine: (line: string) => void,
  budget: LineBudget = createLineBudget(),
): LineSink {
  let held = "";

  const take = (line: string): void => {
    const reported = budget.next(line);
    if (reported !== null) onLine(reported);
  };

  return {
    write(chunk: string): void {
      const { lines, rest } = splitLines(held, chunk);
      held = rest;
      for (const line of lines) take(line);
    },
    end(): void {
      if (held.length > 0) take(held);
      held = "";
    },
  };
}
