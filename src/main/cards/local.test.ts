import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIGURED_GCI_LAYOUT } from "../standalone/moved.ts";
import { localCardFor, readLocalCard, writeToLocalCard, type LocalCard } from "./local.ts";
import { pcsx2UnitOf, splitCard, type CardFile } from "./merge.ts";
import { cardStatePath, readCardBase, writeCardBase } from "./state.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "romm-card-local-"));
}

function file(name: string, text: string): CardFile {
  return { name, contents: Buffer.from(text), modifiedAt: 0 };
}

function pcsx2Card(root: string, exists = true): LocalCard {
  return { emulator: "pcsx2", root, exists, unitOf: pcsx2UnitOf, restFrom: "local", layout: null };
}

test("finds the card each emulator's own settings name", async () => {
  const folder = scratch();
  const memcards = join(folder, "memcards");
  mkdirSync(join(memcards, "Shared.ps2"), { recursive: true });
  writeFileSync(join(memcards, "Shared.ps2", "_pcsx2_superblock"), "sb");
  const options = {
    folder,
    saveRoot: memcards,
    layout: null,
    platform: process.platform,
  };
  const card = await localCardFor({
    ...options,
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    read: () => "[MemoryCards]\nSlot1_Filename = Shared.ps2\n",
  });
  assert.ok(card && !("skip" in card));
  assert.equal(card.root, join(memcards, "Shared.ps2"));
  assert.equal(card.exists, true);

  // PCSX2's default name, which is not there yet: created from the server's.
  const fresh = await localCardFor({ ...options, emulatorId: "pcsx2", platformSlug: "ps2", read: () => null });
  assert.ok(fresh && !("skip" in fresh) && fresh.exists === false);

  writeFileSync(join(memcards, "Mcd001.ps2"), "an 8 MB image");
  const fileCard = await localCardFor({ ...options, emulatorId: "pcsx2", platformSlug: "ps2", read: () => null });
  assert.ok(fileCard && "skip" in fileCard && /file card/.test(fileCard.skip));

  const raw = await localCardFor({
    ...options,
    emulatorId: "dolphin",
    platformSlug: "ngc",
    read: () => "[Core]\nSlotA = 1\n",
  });
  assert.ok(raw && "skip" in raw);
  // The card library holds nothing for Wii, PS3 or Wii U.
  for (const [emulatorId, platformSlug] of [["dolphin", "wii"], ["rpcs3", "ps3"], ["cemu", "wiiu"]] as const) {
    assert.equal(await localCardFor({ ...options, emulatorId, platformSlug, read: () => null }), null);
  }
});

test("a card's name from PCSX2.ini cannot reach outside its folder", async () => {
  const card = await localCardFor({
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    folder: "/p",
    saveRoot: "/p/memcards",
    layout: null,
    platform: "linux",
    read: () => "[MemoryCards]\nSlot1_Filename = ../../elsewhere\n",
  });
  assert.ok(card && "skip" in card);
});

test("a PCSX2 card round-trips, and a save is replaced whole", async () => {
  const root = join(scratch(), "Mcd001.ps2");
  const card = pcsx2Card(root, false);
  const server = splitCard(
    [file("_pcsx2_superblock", "sb"), file("BASLUS-20312AC04/save.dat", "v2")],
    pcsx2UnitOf,
  );
  // A card created from the server's carries its superblock.
  mkdirSync(join(root, "BASLUS-20312AC04"), { recursive: true });
  writeFileSync(join(root, "BASLUS-20312AC04", "stale.dat"), "old");
  await writeToLocalCard(card, [...server.units.values()], server.rest);
  assert.equal(readFileSync(join(root, "_pcsx2_superblock"), "utf8"), "sb");
  assert.equal(readFileSync(join(root, "BASLUS-20312AC04", "save.dat"), "utf8"), "v2");
  // Gone with the rest of the save it no longer belongs to.
  assert.equal(existsSync(join(root, "BASLUS-20312AC04", "stale.dat")), false);

  const read = await readLocalCard({ ...card, exists: true });
  assert.deepEqual([...read!.units.keys()], ["BASLUS-20312AC04"]);
  assert.equal(read!.units.get("BASLUS-20312AC04")!.hash, server.units.get("BASLUS-20312AC04")!.hash);
});

test("a configured Dolphin GCI folder is read and written under the library's names", async () => {
  const root = scratch();
  mkdirSync(join(root, "USA"));
  writeFileSync(join(root, "USA", "01-GALE-SSBM.gci"), "mine");
  writeFileSync(join(root, "SRAM.USA.raw"), "not a save");
  const card: LocalCard = {
    emulator: "dolphin",
    root,
    exists: true,
    unitOf: (name) => (/^USA\/Card A\/[^/]+\.gci$/.test(name) ? name : null),
    restFrom: "server",
    layout: CONFIGURED_GCI_LAYOUT,
  };
  const read = await readLocalCard(card);
  assert.deepEqual([...read!.units.keys()], ["USA/Card A/01-GALE-SSBM.gci"]);
  assert.deepEqual(read!.rest, []);

  await writeToLocalCard(card, [{ key: "USA/Card A/01-GALE-KART.gci", files: [file("USA/Card A/01-GALE-KART.gci", "k")], hash: "h", modifiedAt: 0 }], []);
  assert.equal(readFileSync(join(root, "USA", "01-GALE-KART.gci"), "utf8"), "k");
});

test("refuses to write through a link or outside the card", async () => {
  const base = scratch();
  const root = join(base, "Mcd001.ps2");
  mkdirSync(root);
  mkdirSync(join(base, "elsewhere"));
  symlinkSync(join(base, "elsewhere"), join(root, "BASLUS-20312AC04"));
  const card = pcsx2Card(root);
  const unit = { key: "BASLUS-20312AC04", files: [file("BASLUS-20312AC04/save.dat", "x")], hash: "h", modifiedAt: 0 };
  await assert.rejects(writeToLocalCard(card, [unit], []), /link/);
  await assert.rejects(writeToLocalCard(card, [], [file("../escape", "x")]), /safe/);
  assert.equal(existsSync(join(base, "elsewhere", "save.dat")), false);
});

test("a card with a link in it is not read as whole", async () => {
  const base = scratch();
  const root = join(base, "Mcd001.ps2");
  mkdirSync(root);
  symlinkSync(base, join(root, "BASLUS-20312AC04"));
  assert.equal(await readLocalCard(pcsx2Card(root)), null);
});

test("the agreement is kept per card, and another card's reads as none", async () => {
  const path = cardStatePath(scratch(), "https://romm.example.com/", "pcsx2");
  assert.deepEqual(await readCardBase(path, 7), {});
  await writeCardBase(path, 7, { "BASLUS-20312AC04": "abc" });
  assert.deepEqual(await readCardBase(path, 7), { "BASLUS-20312AC04": "abc" });
  assert.deepEqual(await readCardBase(path, 8), {});
  // Nothing about the server is in the file name.
  assert.doesNotMatch(path, /romm\.example/);
});
