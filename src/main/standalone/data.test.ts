import assert from "node:assert/strict";
import { test } from "node:test";
import { STANDALONE_EMULATORS } from "../emulator/standalone.ts";
import {
  knownStandaloneId,
  standaloneData,
  STANDALONE_DATA_IDS,
} from "./data.ts";

const HOME = "/home/sam";
const WIN_HOME = "C:\\Users\\sam";
const WIN_ENV = {
  USERPROFILE: WIN_HOME,
  APPDATA: "C:\\Users\\sam\\AppData\\Roaming",
};

function present(...paths: string[]) {
  const set = new Set(paths);
  return (path: string) => set.has(path);
}

test("every detected emulator has somewhere its saves are known to live", () => {
  assert.deepEqual(
    STANDALONE_EMULATORS.map((entry) => entry.id).sort(),
    [...STANDALONE_DATA_IDS].sort(),
  );
});

test("Dolphin on Linux uses its XDG folder, and the platform picks the tree", () => {
  const options = {
    emulatorId: "dolphin",
    command: "/usr/bin/dolphin-emu",
    platform: "linux" as const,
    home: HOME,
    env: {},
    exists: present("/home/sam/.local/share/dolphin-emu"),
  };
  const wii = standaloneData({ ...options, platformSlug: "wii" });
  assert.deepEqual(wii, {
    emulatorId: "dolphin",
    folder: "/home/sam/.local/share/dolphin-emu",
    source: "default",
    exists: true,
    saveRoot: "Wii/title",
    stateRoot: "StateSaves",
  });
  assert.equal(
    standaloneData({ ...options, platformSlug: "ngc" })?.saveRoot,
    "GC",
  );
});

test("Dolphin keeps using a legacy folder for as long as it exists", () => {
  const data = standaloneData({
    emulatorId: "dolphin",
    platformSlug: "ngc",
    command: "/usr/bin/dolphin-emu",
    platform: "linux",
    home: HOME,
    env: { XDG_DATA_HOME: "/data" },
    exists: present("/home/sam/.dolphin-emu"),
  });
  assert.equal(data?.folder, "/home/sam/.dolphin-emu");
});

test("a Flatpak launch reads the sandbox's folder, not the native one", () => {
  const data = standaloneData({
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    command: "/var/lib/flatpak/exports/bin/net.pcsx2.PCSX2",
    platform: "linux",
    home: HOME,
    env: {},
    exists: present("/home/sam/.config/PCSX2"),
  });
  assert.equal(data?.folder, "/home/sam/.var/app/net.pcsx2.PCSX2/config/PCSX2");
  assert.equal(data?.source, "flatpak");
  assert.equal(data?.exists, false);
});

test("a portable marker beside the executable wins over the default", () => {
  const dolphin = standaloneData({
    emulatorId: "dolphin",
    platformSlug: "wii",
    command: "E:\\Emu\\Dolphin\\Dolphin.exe",
    platform: "win32",
    home: WIN_HOME,
    env: WIN_ENV,
    exists: present("E:\\Emu\\Dolphin\\portable.txt"),
  });
  assert.equal(dolphin?.folder, "E:\\Emu\\Dolphin\\User");
  assert.equal(dolphin?.source, "portable");

  const pcsx2 = standaloneData({
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    command: "C:\\RetroBat\\emulators\\pcsx2\\pcsx2-qt.exe",
    platform: "win32",
    home: WIN_HOME,
    env: WIN_ENV,
    exists: present("C:\\RetroBat\\emulators\\pcsx2\\portable.ini"),
  });
  assert.equal(pcsx2?.folder, "C:\\RetroBat\\emulators\\pcsx2");
});

test("Windows defaults: PCSX2 in Documents, Dolphin and Cemu in AppData", () => {
  const on = (emulatorId: string, platformSlug: string, command: string) =>
    standaloneData({
      emulatorId,
      platformSlug,
      command,
      platform: "win32",
      home: WIN_HOME,
      env: WIN_ENV,
      exists: present(),
    })?.folder;
  assert.equal(
    on("pcsx2", "ps2", "C:\\PCSX2\\pcsx2-qt.exe"),
    "C:\\Users\\sam\\Documents\\PCSX2",
  );
  assert.equal(
    on("dolphin", "ngc", "C:\\Dolphin\\Dolphin.exe"),
    "C:\\Users\\sam\\AppData\\Roaming\\Dolphin Emulator",
  );
  assert.equal(
    on("cemu", "wiiu", "C:\\Cemu\\Cemu.exe"),
    "C:\\Users\\sam\\AppData\\Roaming\\Cemu",
  );
  // RPCS3 on Windows always keeps its data beside the executable.
  assert.equal(on("rpcs3", "ps3", "D:\\RPCS3\\rpcs3.exe"), "D:\\RPCS3");
});

test("Dolphin on Windows stays in Documents while an older install left it there", () => {
  const data = standaloneData({
    emulatorId: "dolphin",
    platformSlug: "ngc",
    command: "C:\\Dolphin\\Dolphin.exe",
    platform: "win32",
    home: WIN_HOME,
    env: WIN_ENV,
    exists: present("C:\\Users\\sam\\Documents\\Dolphin Emulator"),
  });
  assert.equal(data?.folder, "C:\\Users\\sam\\Documents\\Dolphin Emulator");
});

test("macOS keeps each in Application Support", () => {
  const data = standaloneData({
    emulatorId: "rpcs3",
    platformSlug: "ps3",
    command: "/Applications/RPCS3.app/Contents/MacOS/rpcs3",
    platform: "darwin",
    home: "/Users/sam",
    exists: present(),
  });
  assert.equal(data?.folder, "/Users/sam/Library/Application Support/rpcs3");
  assert.equal(data?.saveRoot, "dev_hdd0/home/00000001/savedata");
});

test("a configured folder beats everything, and Cemu has no states", () => {
  const data = standaloneData({
    emulatorId: "cemu",
    platformSlug: "wiiu",
    command: "/usr/bin/Cemu",
    configured: { cemu: "/games/cemu-data" },
    platform: "linux",
    home: HOME,
    env: {},
    exists: present("/games/cemu-data"),
  });
  assert.equal(data?.folder, "/games/cemu-data");
  assert.equal(data?.source, "configured");
  assert.equal(data?.saveRoot, "mlc01/usr/save");
  assert.equal(data?.stateRoot, null);
});

test("an emulator this knows nothing about has no data", () => {
  assert.equal(
    standaloneData({
      emulatorId: "duckstation",
      platformSlug: "psx",
      command: "/usr/bin/duckstation",
      home: HOME,
    }),
    null,
  );
});

test("only a known id switches anything on", () => {
  assert.equal(knownStandaloneId("pcsx2"), "pcsx2");
  assert.equal(knownStandaloneId("PCSX2"), null);
  assert.equal(knownStandaloneId("toString"), null);
  assert.equal(knownStandaloneId(undefined), null);
});
