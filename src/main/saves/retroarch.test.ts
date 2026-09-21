import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  autosaveSeconds,
  DEFAULT_RETROARCH_AUTOSAVE_SECONDS,
  launchConfigPath,
  MAX_RETROARCH_AUTOSAVE_SECONDS,
  MIN_RETROARCH_AUTOSAVE_SECONDS,
  retroarchLaunchConfig,
  writeLaunchConfig,
} from "./retroarch.ts";

test("the config asks RetroArch for the interval, in its own format", () => {
  const written = retroarchLaunchConfig({ autosaveSeconds: 10 }) ?? "";
  assert.match(written, /^autosave_interval = "10"$/m);
});

test("a launch with nothing to ask for names no config", () => {
  // Not a file that sets zero: that would override a user who chose their own
  // interval, which is the opposite of leaving their settings alone.
  assert.equal(retroarchLaunchConfig({ autosaveSeconds: 0 }), null);
});

test("an interval that is not a whole number of seconds is left out", () => {
  for (const seconds of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(retroarchLaunchConfig({ autosaveSeconds: seconds }), null);
  }
});

test("both display answers are written, since only one has a flag", () => {
  // RetroArch has -f for fullscreen and nothing for the opposite, so a switch
  // the page turned off has only the setting to say it with -- and it has to
  // say it, on a machine whose own config turns fullscreen on.
  assert.match(
    retroarchLaunchConfig({ autosaveSeconds: 0, fullscreen: false }) ?? "",
    /^video_fullscreen = "false"$/m,
  );
  assert.match(
    retroarchLaunchConfig({ autosaveSeconds: 0, fullscreen: true }) ?? "",
    /^video_fullscreen = "true"$/m,
  );
});

test("a launch that says nothing about the display leaves it alone", () => {
  const written = retroarchLaunchConfig({ autosaveSeconds: 10 }) ?? "";
  assert.doesNotMatch(written, /video_fullscreen/);
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

test("an interval faster than the watcher can catch is raised to one it can", () => {
  // RetroArch takes any whole number of seconds, but a cadence the watcher
  // cannot see at rest is a cadence nothing is ever sent from: it has to read
  // the same bytes twice, so looks further apart than the writes never agree.
  for (const asked of [1, 2, 5]) {
    assert.equal(autosaveSeconds(asked), MIN_RETROARCH_AUTOSAVE_SECONDS);
  }
  assert.equal(autosaveSeconds(MIN_RETROARCH_AUTOSAVE_SECONDS + 1), 7);
});

test("an absurd interval is capped rather than passed on", () => {
  // The watcher looks at a fraction of this, so a number nobody meant here
  // becomes a timer nobody meant there.
  assert.equal(
    autosaveSeconds(Number.MAX_SAFE_INTEGER),
    MAX_RETROARCH_AUTOSAVE_SECONDS,
  );
});

test("each launch gets its own config, named for the game", () => {
  // Per ROM because the contents differ per launch: two games running at once
  // would otherwise overwrite each other's display answer. The leading dot is
  // what keeps the directory clear of a game's own, which is named by ROM id.
  const path = launchConfigPath("/data/save-data", 7);
  assert.equal(path, join("/data/save-data", ".retroarch", "launch-7.cfg"));
  assert.notEqual(path, launchConfigPath("/data/save-data", 8));
});

test("writing returns the path the launch can name", async () => {
  const root = mkdtempSync(join(tmpdir(), "romm-save-data-"));
  const target = await writeLaunchConfig(root, 7, { autosaveSeconds: 10 });
  assert.equal(target, launchConfigPath(root, 7));
  assert.match(readFileSync(target ?? "", "utf8"), /autosave_interval = "10"/);
});

test("nothing is written when there is nothing to ask for", async () => {
  const root = mkdtempSync(join(tmpdir(), "romm-save-data-"));
  assert.equal(await writeLaunchConfig(root, 7, { autosaveSeconds: 0 }), null);
});

test("a path an --appendconfig list cannot express is declined", async () => {
  // The list is delimited by "|", with no escape for one inside a path. The
  // firmware config is appended beside this one, so mangling the list would
  // cost that too.
  const root = mkdtempSync(join(tmpdir(), "romm-save-data-"));
  assert.equal(
    await writeLaunchConfig(join(root, "a|b"), 7, { autosaveSeconds: 10 }),
    null,
  );
});

test("a launch pins the directories its saves and states belong in", () => {
  // The deprecated flags name the files but lose to a savefile_directory, a
  // sorting option or "save files in content directory" in the user's own
  // config, which redirects the write while the read still comes from the named
  // file. A config appended for the run is what outranks those.
  const written =
    retroarchLaunchConfig({
      autosaveSeconds: 0,
      saveDir: "/data/4755/saves",
      stateDir: "/data/4755/states",
    }) ?? "";

  assert.match(written, /^savefile_directory = "\/data\/4755\/saves"$/m);
  assert.match(written, /^savestate_directory = "\/data\/4755\/states"$/m);
  for (const key of [
    "sort_savefiles_enable",
    "sort_savefiles_by_content_enable",
    "savefiles_in_content_dir",
    "sort_savestates_enable",
    "sort_savestates_by_content_enable",
    "savestates_in_content_dir",
  ]) {
    assert.match(written, new RegExp(`^${key} = "false"$`, "m"));
  }
});

test("a directory a config cannot quote is left unsaid", () => {
  // A retroarch.cfg value is a quoted string with no escape for a quote inside
  // it, so the alternative to saying nothing is a config that does not parse.
  assert.equal(
    retroarchLaunchConfig({ autosaveSeconds: 0, saveDir: '/data/a"b/saves' }),
    null,
  );
  const written =
    retroarchLaunchConfig({
      autosaveSeconds: 10,
      saveDir: '/data/a"b/saves',
      stateDir: "/data/4755/states",
    }) ?? "";
  assert.doesNotMatch(written, /savefile_directory/);
  assert.match(written, /^savestate_directory = "\/data\/4755\/states"$/m);
});
