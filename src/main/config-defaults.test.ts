import assert from "node:assert/strict";
import { test } from "node:test";
import { withDetectedDefaults } from "./config-defaults.ts";
import { testConfig } from "../test/config.ts";

const LINUX = {
  home: "/home/sam",
  userData: "/home/sam/.config/romm-desktop",
  platform: "linux" as const,
  env: {},
};

test("fills unset paths from detection and userData", () => {
  const onDisk = new Set(["/usr/bin/retroarch", "/home/sam/.config/retroarch/cores"]);
  const view = withDetectedDefaults(testConfig(), {
    ...LINUX,
    exists: (path) => onDisk.has(path),
  });
  assert.equal(view.retroarchPath, "/usr/bin/retroarch");
  assert.equal(view.retroarchCoresPath, "/home/sam/.config/retroarch/cores");
  assert.equal(view.cachePath, "/home/sam/.config/romm-desktop/rom-cache");
  assert.equal(view.biosPath, "/home/sam/.config/romm-desktop/bios");
  assert.equal(view.saveDataPath, "/home/sam/.config/romm-desktop/save-data");
});

test("a value the user set is never replaced by detection", () => {
  const view = withDetectedDefaults(
    testConfig({ retroarchPath: "/opt/ra/retroarch", cachePath: "/srv/cache" }),
    { ...LINUX, exists: () => true },
  );
  assert.equal(view.retroarchPath, "/opt/ra/retroarch");
  assert.equal(view.cachePath, "/srv/cache");
});

test("does not change the config it was handed", () => {
  // config.ts writes the user's own values back, never this view, so the
  // input has to come out exactly as it went in.
  const user = testConfig();
  const before = structuredClone(user);
  withDetectedDefaults(user, { ...LINUX, exists: () => true });
  assert.deepEqual(user, before);
});
