import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DesktopConfig } from "../../shared/types.ts";
import {
  devFlashDirectory,
  pickPup,
  rpcs3Invocation,
  yamlScalar,
  type RunInstaller,
  supplyRpcs3Firmware,
} from "./rpcs3.ts";

const MARKER = ["sys", "external", "liblv2.sprx"];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "romm-rpcs3-fw-"));
  const user = join(root, "rpcs3");
  const mirrorDir = join(root, "mirror");
  mkdirSync(user);
  mkdirSync(mirrorDir);
  writeFileSync(join(mirrorDir, "PS3UPDAT.PUP"), "pup");
  const config = {
    useRommFirmware: true,
    standaloneDataPaths: { rpcs3: user },
  } as unknown as DesktopConfig;
  const mirror = { directory: mirrorDir, count: 1 };
  const calls: { command: string; args: string[] }[] = [];
  // Stands in for RPCS3: installing writes the file it checks for.
  const install: RunInstaller = async (command, args) => {
    calls.push({ command, args });
    const flash = join(user, "dev_flash", ...MARKER.slice(0, -1));
    mkdirSync(flash, { recursive: true });
    writeFileSync(join(flash, MARKER.at(-1)!), "");
  };
  const supply = (run: RunInstaller = install, command = "/usr/bin/rpcs3", args: string[] = []) =>
    supplyRpcs3Firmware({
      config,
      mirror,
      command,
      args,
      signal: new AbortController().signal,
      run,
    });
  return { root, user, mirrorDir, config, calls, supply };
}

test("dev_flash is in RPCS3's folder unless vfs.yml moves it", () => {
  assert.equal(devFlashDirectory("/home/u/.config/rpcs3", null), "/home/u/.config/rpcs3/dev_flash/");
  assert.equal(
    devFlashDirectory("/c", '$(EmulatorDir): ""\n/dev_flash/: $(EmulatorDir)dev_flash/\n'),
    "/c/dev_flash/",
  );
  assert.equal(devFlashDirectory("/c", "$(EmulatorDir): /games/ps3\n"), "/games/ps3/dev_flash/");
  assert.equal(devFlashDirectory("/c", '/dev_flash/: "D:/PS3/flash/"\n'), "D:/PS3/flash/");
  assert.equal(devFlashDirectory("/c", "/dev_flash/: relative/flash/\n"), null);
});

test("vfs.yml comments and quotes are decoded, and anything unclear declined", () => {
  assert.equal(
    devFlashDirectory("/c", "/dev_flash/: /games/flash/ # external drive\n"),
    "/games/flash/",
  );
  assert.equal(devFlashDirectory("/c", "/dev_flash/: '/games/it''s/'\n"), null);
  assert.equal(devFlashDirectory("/c", '/dev_flash/: "/games/flash/ # not a comment"\n'),
    "/games/flash/ # not a comment");
  assert.equal(devFlashDirectory("/c", '/dev_flash/: "/unterminated\n'), null);
  assert.equal(yamlScalar("/a#b"), "/a#b");
  assert.equal(yamlScalar('"C:\\\\x"'), undefined);
});

test("prefers PS3UPDAT.PUP over any other .pup", () => {
  assert.equal(pickPup(["a.PUP", "ps3updat.pup", "bios.bin"]), "ps3updat.pup");
  assert.equal(pickPup(["4.91.pup"]), "4.91.pup");
  assert.equal(pickPup(["bios.bin"]), null);
});

test("a flatpak run row keeps everything up to the app id", () => {
  assert.deepEqual(rpcs3Invocation("/usr/bin/rpcs3", ["--no-gui", "x"]), {
    command: "/usr/bin/rpcs3",
    args: [],
  });
  assert.deepEqual(
    rpcs3Invocation("flatpak", ["run", "--branch=stable", "net.rpcs3.RPCS3", "--no-gui", "x"]),
    { command: "flatpak", args: ["run", "--branch=stable", "net.rpcs3.RPCS3"] },
  );
  assert.deepEqual(
    rpcs3Invocation("flatpak", ["run", "--arch", "x86_64", "net.rpcs3.RPCS3", "--no-gui", "x"]),
    { command: "flatpak", args: ["run", "--arch", "x86_64", "net.rpcs3.RPCS3"] },
  );
  assert.equal(rpcs3Invocation("flatpak", ["run", "org.other.App", "x"]), null);
});

test("two launches at once run one installer", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let installs = 0;
  const slow: RunInstaller = async (...call) => {
    installs++;
    await gate;
    const flash = join(f.user, "dev_flash", ...MARKER.slice(0, -1));
    mkdirSync(flash, { recursive: true });
    writeFileSync(join(flash, MARKER.at(-1)!), "");
    void call;
  };
  const both = Promise.all([f.supply(slow), f.supply(slow)]);
  release();
  assert.deepEqual(await both, [true, true]);
  assert.equal(installs, 1);
});

test("installs the mirrored PUP headlessly when firmware is missing", async () => {
  const f = fixture();
  assert.equal(await f.supply(), true);
  assert.deepEqual(f.calls, [
    {
      command: "/usr/bin/rpcs3",
      args: ["--headless", "--installfw", join(f.mirrorDir, "PS3UPDAT.PUP")],
    },
  ]);
  assert.equal(await f.supply(), false, "installed firmware is left alone");
  assert.equal(f.calls.length, 1);
});

test("an install that leaves no firmware behind is an error", async () => {
  const f = fixture();
  await assert.rejects(f.supply(async () => {}), /without installing PS3UPDAT.PUP/);
});

test("runs nothing without a PUP, with mirroring off, or with an unclear dev_flash", async () => {
  const f = fixture();
  f.config.useRommFirmware = false;
  assert.equal(await f.supply(), false);
  f.config.useRommFirmware = true;

  mkdirSync(join(f.user, "config"));
  writeFileSync(join(f.user, "config", "vfs.yml"), "/dev_flash/: relative/\n");
  assert.equal(await f.supply(), false);

  const g = fixture();
  rmSync(join(g.mirrorDir, "PS3UPDAT.PUP"));
  writeFileSync(join(g.mirrorDir, "other.bin"), "");
  assert.equal(await g.supply(), false);
  assert.equal(f.calls.length + g.calls.length, 0);
});
