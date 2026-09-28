import assert from "node:assert/strict";
import { test } from "node:test";
import { emuAtlasCandidates } from "./cli.ts";

test("a configured executable is the only one tried", () => {
  assert.deepEqual(
    emuAtlasCandidates("/opt/emu-atlas/emu-atlas", "linux", "/home/deck", {
      PATH: "/usr/bin",
    }),
    ["/opt/emu-atlas/emu-atlas"],
  );
});

test("PATH is searched, then pipx's own directory", () => {
  assert.deepEqual(
    emuAtlasCandidates(null, "linux", "/home/deck", {
      PATH: "/usr/local/bin:/usr/bin::relative/bin:/home/deck/.local/bin",
    }),
    [
      "/usr/local/bin/emu-atlas",
      "/usr/bin/emu-atlas",
      // Listed once although PATH named it too; a relative entry is skipped,
      // since it would resolve against wherever the shell was started.
      "/home/deck/.local/bin/emu-atlas",
    ],
  );
});

test("a session with no PATH still finds a pipx install", () => {
  assert.deepEqual(emuAtlasCandidates(null, "linux", "/home/deck", {}), [
    "/home/deck/.local/bin/emu-atlas",
  ]);
});

test("Windows looks for the .exe along its own PATH", () => {
  assert.deepEqual(
    emuAtlasCandidates(null, "win32", "C:\\Users\\sam", {
      Path: "C:\\Python\\Scripts;C:\\Windows",
    }),
    [
      "C:\\Python\\Scripts\\emu-atlas.exe",
      "C:\\Windows\\emu-atlas.exe",
      "C:\\Users\\sam\\.local\\bin\\emu-atlas.exe",
    ],
  );
});
