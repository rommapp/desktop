import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseWithoutPulls,
  dolphinUnitOf,
  pcsx2UnitOf,
  planCardMerge,
  splitCard,
  type CardFile,
} from "./merge.ts";

function file(name: string, text: string, modifiedAt = 1000): CardFile {
  return { name, contents: Buffer.from(text), modifiedAt };
}

/** A PCSX2 folder card: its superblock and one folder per save. */
function pcsx2(...files: CardFile[]) {
  return splitCard([file("_pcsx2_superblock", "sb"), ...files], pcsx2UnitOf);
}

const SSX = "BASLUS-20312AC04";
const KH = "BASLUS-20370KH";

test("a PCSX2 card splits into its save folders and its superblock", () => {
  const card = pcsx2(file(`${SSX}/save.dat`, "a"), file(`${SSX}/icon.sys`, "i"));
  assert.deepEqual([...card.units.keys()], [SSX]);
  assert.deepEqual(card.rest.map((f) => f.name), ["_pcsx2_superblock"]);
});

test("a Dolphin GC folder's saves are the GCIs in each region's Card A", () => {
  assert.equal(dolphinUnitOf("USA/Card A/01-GALE-SSBM.gci"), "USA/Card A/01-GALE-SSBM.gci");
  assert.equal(dolphinUnitOf("JAP/card a/x.GCI"), "JAP/card a/x.GCI");
  for (const name of ["IPL.bin", "dsp_rom.bin", "MemoryCardA.USA.raw", "USA/IPL.bin", "USA/x.gci"]) {
    assert.equal(dolphinUnitOf(name), null, name);
  }
});

test("a save changed on one side only takes that side's", () => {
  const before = pcsx2(file(`${SSX}/save.dat`, "v1"), file(`${KH}/save.dat`, "k1"));
  const base = Object.fromEntries([...before.units].map(([k, u]) => [k, u.hash]));
  // This machine played SSX, another device played KH.
  const local = pcsx2(file(`${SSX}/save.dat`, "v2"), file(`${KH}/save.dat`, "k1"));
  const server = pcsx2(file(`${SSX}/save.dat`, "v1"), file(`${KH}/save.dat`, "k2"));
  const plan = planCardMerge({ base, local, server, restFrom: "local" });
  assert.deepEqual(plan.pull.map((u) => u.key), [KH]);
  assert.equal(plan.archiveFirst, null);
  assert.deepEqual(plan.conflicts, []);
  // The upload carries both changes.
  const uploaded = new Map(plan.upload!.map((f) => [f.name, f.contents.toString()]));
  assert.equal(uploaded.get(`${SSX}/save.dat`), "v2");
  assert.equal(uploaded.get(`${KH}/save.dat`), "k2");
  assert.equal(uploaded.get("_pcsx2_superblock"), "sb");
});

test("a save changed on both sides keeps the newer, and archives the local one it replaces", () => {
  const base = { [SSX]: pcsx2(file(`${SSX}/save.dat`, "v1")).units.get(SSX)!.hash };
  const local = pcsx2(file(`${SSX}/save.dat`, "mine", 1000));
  const newer = pcsx2(file(`${SSX}/save.dat`, "theirs", 5000));
  const plan = planCardMerge({ base, local, server: newer, restFrom: "local" });
  assert.deepEqual(plan.conflicts, [{ key: SSX, kept: "server" }]);
  assert.deepEqual(plan.pull.map((u) => u.key), [SSX]);
  // This machine's progress goes up as a version before it is replaced.
  assert.ok(plan.archiveFirst?.some((f) => f.contents.toString() === "mine"));
  // The server already holds the result, so nothing more goes up.
  assert.equal(plan.upload, null);

  const older = pcsx2(file(`${SSX}/save.dat`, "theirs", 1));
  const kept = planCardMerge({ base, local, server: older, restFrom: "local" });
  assert.deepEqual(kept.conflicts, [{ key: SSX, kept: "local" }]);
  assert.deepEqual(kept.pull, []);
  assert.equal(kept.archiveFirst, null);
  assert.ok(kept.upload?.some((f) => f.contents.toString() === "mine"));
});

test("with no agreement yet, a save on one side is copied to the other", () => {
  const local = pcsx2(file(`${SSX}/save.dat`, "a"));
  const server = pcsx2(file(`${KH}/save.dat`, "k"));
  const plan = planCardMerge({ base: {}, local, server, restFrom: "local" });
  assert.deepEqual(plan.pull.map((u) => u.key), [KH]);
  assert.deepEqual(
    plan.upload!.map((f) => f.name).sort(),
    ["BASLUS-20312AC04/save.dat", "BASLUS-20370KH/save.dat", "_pcsx2_superblock"],
  );
  assert.deepEqual(Object.keys(plan.base).sort(), [SSX, KH]);
});

test("a deletion is not propagated in either direction", () => {
  const ssx = pcsx2(file(`${SSX}/save.dat`, "a"));
  const base = { [SSX]: ssx.units.get(SSX)!.hash };
  // Gone here since the last agreement: not pulled back, and not removed from
  // the server's card.
  const goneHere = planCardMerge({ base, local: pcsx2(), server: ssx, restFrom: "local" });
  assert.deepEqual(goneHere.pull, []);
  assert.ok(goneHere.upload === null || goneHere.upload.some((f) => f.name === `${SSX}/save.dat`));
  // Gone from the server: this machine's copy goes back up.
  const goneThere = planCardMerge({ base, local: ssx, server: pcsx2(), restFrom: "local" });
  assert.ok(goneThere.upload?.some((f) => f.name === `${SSX}/save.dat`));
});

test("a card this machine does not have yet takes the server's whole", () => {
  const server = pcsx2(file(`${SSX}/save.dat`, "a"));
  const plan = planCardMerge({ base: {}, local: null, server, restFrom: "local" });
  assert.deepEqual(plan.pull.map((u) => u.key), [SSX]);
  // The superblock comes down too, or PCSX2 would not read the folder as a card.
  assert.deepEqual(plan.pullRest.map((f) => f.name), ["_pcsx2_superblock"]);
  assert.equal(plan.upload, null);
});

test("an empty card on both sides uploads nothing", () => {
  const plan = planCardMerge({ base: {}, local: pcsx2(), server: null, restFrom: "local" });
  assert.equal(plan.upload, null);
  assert.deepEqual(plan.pull, []);
});

test("Dolphin's other GC files are never uploaded from here, and the server's are kept", () => {
  const gci = "USA/Card A/01-GALE-SSBM.gci";
  const local = splitCard(
    [file(gci, "mine"), file("dsp_rom.bin", "firmware"), file("MemoryCardA.USA.raw", "raw")],
    dolphinUnitOf,
  );
  const server = splitCard([file("USA/IPL.bin", "theirs")], dolphinUnitOf);
  const plan = planCardMerge({ base: {}, local, server, restFrom: "server" });
  assert.deepEqual(plan.upload!.map((f) => f.name).sort(), [gci, "USA/IPL.bin"]);
});

test("a pull left for the next launch still comes down then", () => {
  // After exit nothing is written, so the agreement records this machine's
  // copy of what the server won, and the next merge pulls the server's.
  const base = { [SSX]: pcsx2(file(`${SSX}/save.dat`, "v1")).units.get(SSX)!.hash };
  const local = pcsx2(file(`${SSX}/save.dat`, "v1"));
  const server = pcsx2(file(`${SSX}/save.dat`, "v2"), file(`${KH}/save.dat`, "k"));
  const after = planCardMerge({ base, local, server, restFrom: "local" });
  const recorded = baseWithoutPulls(after, local);
  assert.equal(recorded[SSX], local.units.get(SSX)!.hash);
  assert.equal(recorded[KH], undefined);
  const next = planCardMerge({ base: recorded, local, server, restFrom: "local" });
  assert.deepEqual(next.pull.map((u) => u.key).sort(), [SSX, KH]);
  assert.equal(next.archiveFirst, null);
});
