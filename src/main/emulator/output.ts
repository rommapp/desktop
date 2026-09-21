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
 * Collect a child's output into whole lines, up to `limit` of them.
 *
 * The line that hits the limit says so, so a truncated log reads as truncated
 * rather than as an emulator that went quiet.
 */
export function createLineSink(
  onLine: (line: string) => void,
  limit: number = MAX_CAPTURED_LINES,
): LineSink {
  let held = "";
  let taken = 0;

  const take = (line: string): void => {
    if (taken > limit) return;
    taken += 1;
    onLine(taken > limit ? `... capped at ${limit} lines` : line);
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
