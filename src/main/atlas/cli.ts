// Asking emu-atlas one question.
//
// The command line is the route emu-atlas offers a client in any language: one
// question per invocation, its contract JSON on stdout, exit 0 for an answer
// and 2 for a question that could not be put. A refusal is still exit 0, so
// the exit code only ever says whether there is JSON to read, and answers.ts
// decides what it means.
//
// It is an optional tool the user installs (pipx, the release wheel, or the
// self-contained bundle), so where it lives is looked up rather than assumed,
// and a machine without it is the ordinary case: every question then answers
// null without a process being started.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Longer than the fifteen seconds emu-atlas waits out a core that hangs while
 *  it is asked for its library name, so a slow core reads as an answer that
 *  says so rather than as a timeout here. */
const QUESTION_TIMEOUT_MS = 20_000;

/** A generous bound on one answer. The largest contract answers are a few
 *  hundred kilobytes; anything bigger is not something to parse. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/**
 * Where to look for the executable, most specific first.
 *
 * A configured path is used on its own. Otherwise every PATH entry is tried,
 * and then `~/.local/bin`, which is where pipx puts it and which a desktop
 * session started from a launcher often leaves off PATH. Platform, home and
 * environment are parameters so every branch can be checked from one machine.
 */
export function emuAtlasCandidates(
  configured: string | null,
  platform: NodeJS.Platform = process.platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (configured) return [configured];
  const p = platform === "win32" ? win32 : posix;
  const name = platform === "win32" ? "emu-atlas.exe" : "emu-atlas";
  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar
    .split(platform === "win32" ? ";" : ":")
    .filter((dir) => dir !== "" && p.isAbsolute(dir));
  const candidates = [...dirs, p.join(home, ".local", "bin")].map((dir) =>
    p.join(dir, name),
  );
  return [...new Set(candidates)];
}

export function findEmuAtlas(
  configured: string | null,
  home: string,
): string | null {
  return (
    emuAtlasCandidates(configured, undefined, home).find((candidate) =>
      existsSync(candidate),
    ) ?? null
  );
}

/** Ask one question. Implemented by `runEmuAtlas`, and by a fixture in tests. */
export type AskAtlas = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<unknown>;

/**
 * An AskAtlas bound to one executable.
 *
 * Resolves to the parsed JSON, or to null for everything that is not an
 * answer: a non-zero exit, a timeout, output that is not JSON. No shell is
 * involved, so an argument is one argv entry whatever it contains. A cancel
 * kills the process and resolves null too; the caller checks its own signal,
 * which is what makes a cancel read as a cancel.
 */
export function runEmuAtlas(binary: string): AskAtlas {
  return (args, signal) =>
    new Promise((resolve) => {
      execFile(
        binary,
        [...args],
        {
          encoding: "utf8",
          timeout: QUESTION_TIMEOUT_MS,
          maxBuffer: MAX_ANSWER_BYTES,
          signal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            // Said once per question rather than per launch, because which
            // question failed is the part worth knowing.
            if (!signal.aborted) {
              const detail = stderr.trim().split("\n")[0] || error.message;
              console.warn(`[atlas] ${args[0]} gave no answer: ${detail}`);
            }
            return resolve(null);
          }
          try {
            resolve(JSON.parse(stdout) as unknown);
          } catch {
            console.warn(
              `[atlas] ${args[0]} printed something that is not JSON`,
            );
            resolve(null);
          }
        },
      );
    });
}
