import assert from "node:assert/strict";
import { test } from "node:test";
import { showTaskbarProgress, clearTaskbarProgress, setTransferProgress } from "./window-progress.ts";

test("foreground page progress wins, then background progress resumes until both finish", () => {
  const values: number[] = [];
  const window = { isDestroyed: () => false, setProgressBar: (value: number) => values.push(value) };
  setTransferProgress(window, "install", 0.1);
  setTransferProgress(window, "page", 0.5);
  setTransferProgress(window, "install", 0.2);
  setTransferProgress(window, "page", null);
  setTransferProgress(window, "install", null);
  assert.deepEqual(values, [0.1, 0.5, 0.5, 0.2, -1]);
});

test("finishing a background transfer does not clear an indeterminate page download", () => {
  const values: number[] = [];
  const window = { isDestroyed: () => false, setProgressBar: (value: number) => values.push(value) };
  setTransferProgress(window, "page", 2);
  setTransferProgress(window, "install", null);
  assert.deepEqual(values, [2, 2]);
});

test("emulator offers preserve the old helper API and restore background progress", () => {
  const values: number[] = [];
  const window = { isDestroyed: () => false, setProgressBar: (value: number) => values.push(value) };
  setTransferProgress(window, "install", 0.2);
  showTaskbarProgress(window, 0.8);
  clearTaskbarProgress(window);
  showTaskbarProgress(null, 0.5);
  showTaskbarProgress({ ...window, isDestroyed: () => true }, 0.5);
  assert.deepEqual(values, [0.2, 0.8, 0.2]);
});
