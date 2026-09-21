import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  autosaveConfigPath,
  autosaveSeconds,
  DEFAULT_RETROARCH_AUTOSAVE_SECONDS,
  retroarchAutosaveConfig,
  writeAutosaveConfig,
} from "./retroarch.ts";

test("the config asks RetroArch for the interval, in its own format", () => {
  const written = retroarchAutosaveConfig(10) ?? "";
  assert.match(written, /^autosave_interval = "10"$/m);
});

test("an interval of zero asks for nothing at all", () => {
  // Not a file that sets zero: that would override a user who chose their own
  // interval, which is the opposite of leaving their setting alone.
  assert.equal(retroarchAutosaveConfig(0), null);
});

test("an interval that is not a whole number of seconds is declined", () => {
  for (const seconds of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(retroarchAutosaveConfig(seconds), null, `${seconds}`);
  }
});

test("a hand-edited interval falls back to the default, but zero is honoured", () => {
  assert.equal(autosaveSeconds(30), 30);
  assert.equal(autosaveSeconds(0), 0);
  for (const bad of [null, undefined, -1, 2.5, Number.NaN]) {
    assert.equal(
      autosaveSeconds(bad),
      DEFAULT_RETROARCH_AUTOSAVE_SECONDS,
      `${bad}`,
    );
  }
});

test("the generated config cannot collide with a game's own directory", () => {
  // Those are named with the ROM id, and a leading dot is not one.
  const path = autosaveConfigPath("/data/save-data");
  assert.equal(path, join("/data/save-data", ".retroarch", "autosave.cfg"));
});

test("writing returns the path the launch can name", async () => {
  const root = mkdtempSync(join(tmpdir(), "romm-save-data-"));
  const target = await writeAutosaveConfig(root, 10);
  assert.equal(target, autosaveConfigPath(root));
  assert.match(readFileSync(target ?? "", "utf8"), /autosave_interval = "10"/);
});

test("nothing is written when the interval asks for nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "romm-save-data-"));
  assert.equal(await writeAutosaveConfig(root, 0), null);
});

test("a path an --appendconfig list cannot express is declined", async () => {
  // The list is delimited by "|", with no escape for one inside a path. The
  // firmware config is appended beside this one, so mangling the list would
  // cost that too.
  const root = mkdtempSync(join(tmpdir(), "romm-save-data-"));
  assert.equal(await writeAutosaveConfig(join(root, "a|b"), 10), null);
});
