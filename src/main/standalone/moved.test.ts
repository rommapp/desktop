import assert from "node:assert/strict";
import { test } from "node:test";
import { iniValue, movedFolders, vfsDirectory, xmlElement } from "./moved.ts";
import { standaloneData } from "./data.ts";

/** Stand in for the filesystem: a map of file to text. */
function files(entries: Record<string, string>) {
  return (path: string) => entries[path] ?? null;
}

// What RetroBat's emulatorLauncher writes before it starts each emulator.
const RB = "D:\\RetroBat";
const RB_EMU = `${RB}\\emulators`;

test("follows PCSX2's memory card and savestate folders as RetroBat writes them", () => {
  const folder = `${RB_EMU}\\pcsx2`;
  const moved = movedFolders({
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    folder,
    platform: "win32",
    read: files({
      [`${folder}\\inis\\PCSX2.ini`]: [
        "[UI]",
        "MemoryCards = not this one",
        "[Folders]",
        `Bios = ${RB}\\bios`,
        `MemoryCards = ${RB}\\saves\\ps2\\pcsx2\\memcards`,
        `SaveStates = ${RB}\\saves\\ps2\\pcsx2\\sstates`,
      ].join("\r\n"),
    }),
  });
  assert.deepEqual(moved, {
    saveDir: `${RB}\\saves\\ps2\\pcsx2\\memcards`,
    stateDir: `${RB}\\saves\\ps2\\pcsx2\\sstates`,
  });
});

test("a relative PCSX2 folder resolves against PCSX2's own, as PCSX2 does", () => {
  const folder = `${RB_EMU}\\pcsx2`;
  const moved = movedFolders({
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    folder,
    platform: "win32",
    read: files({ [`${folder}\\inis\\PCSX2.ini`]: "[Folders]\nSaveStates = sstates\n" }),
  });
  assert.deepEqual(moved, { stateDir: `${folder}\\sstates` });
});

test("follows Dolphin's GCI folder up to the GC root, with or without the region", () => {
  const folder = `${RB_EMU}\\dolphin-emu\\User`;
  const gcRoot = `${RB}\\saves\\gamecube\\dolphin-emu\\User\\GC`;
  for (const gci of [`${gcRoot}\\USA`, `${gcRoot}\\EUR\\Card A`, gcRoot]) {
    const moved = movedFolders({
      emulatorId: "dolphin",
      platformSlug: "ngc",
      folder,
      platform: "win32",
      read: files({ [`${folder}\\Config\\Dolphin.ini`]: `[Core]\nGCIFolderAPath = ${gci}\n` }),
    });
    assert.deepEqual(moved, { saveDir: gcRoot }, gci);
  }
});

test("follows Dolphin's NAND root for a Wii game", () => {
  const folder = `${RB_EMU}\\dolphin-emu\\User`;
  const nand = `${RB}\\saves\\wii\\dolphin-emu\\User\\Wii`;
  const moved = movedFolders({
    emulatorId: "dolphin",
    platformSlug: "wii",
    folder,
    platform: "win32",
    read: files({
      [`${folder}\\Config\\Dolphin.ini`]: `[General]\nNANDRootPath = ${nand}\n[Core]\nGCIFolderAPath = D:\\elsewhere\n`,
    }),
  });
  assert.deepEqual(moved, { saveDir: `${nand}\\title` });
});

test("follows Cemu's mlc_path", () => {
  const folder = `${RB_EMU}\\cemu\\portable`;
  const moved = movedFolders({
    emulatorId: "cemu",
    platformSlug: "wiiu",
    folder,
    platform: "win32",
    read: files({
      [`${folder}\\settings.xml`]: `<?xml version="1.0"?>\n<content>\n  <mlc_path>D:/RetroBat/saves/wiiu/cemu/mlc01</mlc_path>\n</content>`,
    }),
  });
  assert.deepEqual(moved, { saveDir: "D:\\RetroBat\\saves\\wiiu\\cemu\\mlc01\\usr\\save" });
});

test("follows RPCS3's dev_hdd0, as RetroBat and EmuDeck both move it", () => {
  const moved = movedFolders({
    emulatorId: "rpcs3",
    platformSlug: "ps3",
    folder: "/home/deck/.config/rpcs3",
    platform: "linux",
    read: files({
      "/home/deck/.config/rpcs3/vfs.yml":
        "$(EmulatorDir): \"\"\n/dev_hdd0/: /run/media/mmcblk0p1/Emulation/storage/rpcs3/dev_hdd0/\n",
    }),
  });
  assert.deepEqual(moved, {
    saveDir: "/run/media/mmcblk0p1/Emulation/storage/rpcs3/dev_hdd0/home/00000001/savedata",
  });
});

test("nothing is moved when the settings are missing, empty or unreadable", () => {
  const base = { platformSlug: "ps2", folder: "C:\\pcsx2", platform: "win32" as const };
  assert.deepEqual(movedFolders({ ...base, emulatorId: "pcsx2", read: files({}) }), {});
  assert.deepEqual(
    movedFolders({
      ...base,
      emulatorId: "pcsx2",
      read: files({ "C:\\pcsx2\\inis\\PCSX2.ini": "[Folders]\nMemoryCards =\n" }),
    }),
    {},
  );
  // A relative Cemu path would resolve against Cemu's working directory, which
  // is not something the shell can know, so it is not followed.
  assert.deepEqual(
    movedFolders({
      ...base,
      emulatorId: "cemu",
      platformSlug: "wiiu",
      read: files({ "C:\\pcsx2\\settings.xml": "<mlc_path>mlc01</mlc_path>" }),
    }),
    {},
  );
  assert.deepEqual(
    movedFolders({ ...base, emulatorId: "retroarch", read: () => "anything" }),
    {},
  );
});

test("standaloneData hands the moved folders on, and says so", () => {
  const folder = "/home/sam/.config/PCSX2";
  const data = standaloneData({
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    command: "/usr/bin/pcsx2-qt",
    platform: "linux",
    home: "/home/sam",
    env: {},
    exists: (path) => path === folder,
    read: files({ [`${folder}/inis/PCSX2.ini`]: "[Folders]\nMemoryCards = /games/ps2/cards\n" }),
  });
  assert.equal(data?.saveRoot, "/games/ps2/cards");
  // States were not moved, so they keep the default.
  assert.equal(data?.stateRoot, "sstates");
  assert.equal(data?.moved, true);
});

test("an emulator with no states gets none, whatever its settings say", () => {
  const data = standaloneData({
    emulatorId: "cemu",
    platformSlug: "wiiu",
    command: "/usr/bin/Cemu",
    platform: "linux",
    home: "/home/sam",
    env: {},
    exists: () => true,
    read: () => "<mlc_path>/games/mlc01</mlc_path>",
  });
  assert.equal(data?.saveRoot, "/games/mlc01/usr/save");
  assert.equal(data?.stateRoot, null);
});

test("the parsers read what the emulators write", () => {
  assert.equal(iniValue("[folders]\nmemorycards = \"C:/cards\"", "Folders", "MemoryCards"), "C:/cards");
  assert.equal(iniValue("[Folders]\n; MemoryCards = no", "Folders", "MemoryCards"), null);
  assert.equal(xmlElement("<mlc_path></mlc_path>", "mlc_path"), null);
  assert.equal(vfsDirectory("/c", null, "/dev_hdd0/"), "/c/dev_hdd0/");
});
