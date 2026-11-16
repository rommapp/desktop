import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  memoryCardHint,
  pcsx2CardKind,
  pcsx2CardOf,
  pcsx2RestoreRefusal,
  PCSX2_SUPERBLOCK,
  type CardKind,
} from "./cards.ts";
import { selectSaveFiles } from "./identity.ts";

test("RomM's PS2 target selects one game's folders inside a folder card", () => {
  // RomM gives SLUS-20312 the target BASLUS-20312, applied as a folder
  // prefix, because PCSX2 suffixes each save's folder.
  const files = [
    "Mcd001.ps2/_pcsx2_superblock",
    "Mcd001.ps2/BASLUS-20312AC04/icon.sys",
    "Mcd001.ps2/BASLUS-20312AC04/save.dat",
    "Mcd001.ps2/BASLUS-20312SYS/_pcsx2_index",
    "Mcd001.ps2/BESLES-50001/save.dat",
    "Mcd002.ps2",
  ];
  assert.deepEqual(selectSaveFiles(files, "BASLUS-20312", "folder-prefix"), [
    "Mcd001.ps2/BASLUS-20312AC04/icon.sys",
    "Mcd001.ps2/BASLUS-20312AC04/save.dat",
    "Mcd001.ps2/BASLUS-20312SYS/_pcsx2_index",
  ]);
});

test("a member's card is its first segment, when that is one", () => {
  assert.equal(pcsx2CardOf("Mcd001.ps2/BASLUS-20312AC04/save.dat"), "Mcd001.ps2");
  assert.equal(pcsx2CardOf("MyCard.PS2/x"), "MyCard.PS2");
  assert.equal(pcsx2CardOf("BASLUS-20312/save.dat"), null);
});

test("tells a formatted folder card from everything that is not one", async () => {
  const root = mkdtempSync(join(tmpdir(), "romm-cards-"));
  const folder = join(root, "Mcd001.ps2");
  mkdirSync(folder);
  writeFileSync(join(folder, PCSX2_SUPERBLOCK), "");
  mkdirSync(join(root, "Blank.ps2"));
  writeFileSync(join(root, "Mcd002.ps2"), "");
  assert.equal(await pcsx2CardKind(folder), "folder");
  assert.equal(await pcsx2CardKind(join(root, "Blank.ps2")), "unformatted");
  assert.equal(await pcsx2CardKind(join(root, "Mcd002.ps2")), "file");
  assert.equal(await pcsx2CardKind(join(root, "Mcd003.ps2")), "missing");
});

test("a restore writes only into cards PCSX2 has formatted as folder cards", async () => {
  const kinds: Record<string, CardKind> = {
    [join("/m", "Mcd001.ps2")]: "folder",
    [join("/m", "Mcd002.ps2")]: "file",
  };
  const kindOf = async (card: string) => kinds[card] ?? "missing";
  const member = (card: string) => `${card}/BASLUS-20312AC04/save.dat`;

  assert.equal(await pcsx2RestoreRefusal("/m", [member("Mcd001.ps2")], kindOf), null);
  assert.match(
    (await pcsx2RestoreRefusal("/m", [member("Mcd001.ps2"), member("Mcd002.ps2")], kindOf)) ?? "",
    /Mcd002\.ps2 is a file memory card/,
  );
  // Never created from nothing: PCSX2 would not read it as a card.
  assert.match(
    (await pcsx2RestoreRefusal("/m", [member("Mcd009.ps2")], kindOf)) ?? "",
    /does not exist here/,
  );
});

test("says so when PCSX2's card or Dolphin's slot cannot sync per game", async () => {
  const pcsx2 = {
    emulatorId: "pcsx2",
    platformSlug: "ps2",
    folder: "/p",
    saveRoot: "/p/memcards",
    platform: "linux" as const,
  };
  // The card named in PCSX2.ini is the one asked about.
  const asked: string[] = [];
  const hint = await memoryCardHint({
    ...pcsx2,
    read: () => "[MemoryCards]\nSlot1_Filename = Shared.ps2\n",
    kindOf: async (card) => {
      asked.push(card);
      return "file";
    },
  });
  assert.deepEqual(asked, ["/p/memcards/Shared.ps2"]);
  assert.match(hint ?? "", /Shared\.ps2 is a file card/);
  assert.equal(
    await memoryCardHint({ ...pcsx2, read: () => null, kindOf: async () => "folder" }),
    null,
  );

  const dolphin = {
    emulatorId: "dolphin",
    folder: "/d",
    saveRoot: "/d/GC",
    platform: "linux" as const,
  };
  const raw = () => "[Core]\nSlotA = 1\n";
  assert.match(
    (await memoryCardHint({ ...dolphin, platformSlug: "ngc", read: raw })) ?? "",
    /raw memory card/,
  );
  // GCI folder is Dolphin's default, and Wii saves have no card at all.
  assert.equal(
    await memoryCardHint({ ...dolphin, platformSlug: "ngc", read: () => "[Core]\nSlotA = 8\n" }),
    null,
  );
  assert.equal(await memoryCardHint({ ...dolphin, platformSlug: "wii", read: raw }), null);
});
