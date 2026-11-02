import assert from "node:assert/strict";
import { test } from "node:test";
import { zipContentHash } from "../saves/hash.ts";
import { readZipFiles, writeZip } from "../zip.ts";
import {
  assembleSet,
  planRestore,
  safeMemberName,
  saveTargetOf,
  selectSet,
  setFileName,
  staleAfterRestore,
  type SaveTarget,
  type SetMember,
} from "./set.ts";
import { type Tree } from "./tree.ts";

const RPCS3: SaveTarget = { target: "BLUS30001", layout: "folder-exact" };

function member(name: string, contents = "x"): SetMember {
  return { name, contents: Buffer.from(contents), modifiedAt: 0 };
}

test("a target is only usable with the layout that applies it", () => {
  assert.deepEqual(
    saveTargetOf({
      titleId: "BLUS30001",
      saveTarget: "BLUS30001",
      layout: "folder-exact",
    }),
    { target: "BLUS30001", layout: "folder-exact" },
  );
  assert.equal(
    saveTargetOf({ titleId: "BLUS30001", saveTarget: null, layout: null }),
    null,
  );
  assert.equal(saveTargetOf(null), null);
});

test("the set is the target's files under the root, in path order", () => {
  const files = [
    "BLUS30001/SDATA.DAT",
    "BLUS30001/PARAM.SFO",
    "BLES00002/PARAM.SFO",
  ];
  assert.deepEqual(selectSet(files, RPCS3), [
    "BLUS30001/PARAM.SFO",
    "BLUS30001/SDATA.DAT",
  ]);
});

test("a name that would leave the save root is refused", () => {
  assert.equal(safeMemberName("BLUS30001/PARAM.SFO"), true);
  assert.equal(safeMemberName("../../config.ini"), false);
  assert.equal(safeMemberName("BLUS30001/../../config.ini"), false);
  assert.equal(safeMemberName("/etc/passwd"), false);
  assert.equal(safeMemberName("C:/Windows/system.ini"), false);
  assert.equal(safeMemberName("BLUS30001\\PARAM.SFO"), false);
  assert.equal(safeMemberName("BLUS30001//PARAM.SFO"), false);
  assert.equal(safeMemberName("BLUS30001/."), false);
  assert.equal(safeMemberName(""), false);
});

test("a name Windows would read as another file is refused", () => {
  // Windows drops a trailing dot or space when it opens a path, so these name
  // the same file there and a different one here.
  assert.equal(safeMemberName("BLUS30001/data."), false);
  assert.equal(safeMemberName("BLUS30001/data "), false);
  assert.equal(safeMemberName("BLUS30001/da:ta"), false);
  assert.equal(safeMemberName("BLUS30001/da\u0000ta"), false);
});

test("a restore writes only what this game's target names", () => {
  const plan = planRestore(
    [
      member("BLUS30001/PARAM.SFO"),
      member("BLES00002/PARAM.SFO"),
      member("../../config.ini"),
    ],
    RPCS3,
  );
  assert.deepEqual(
    plan.write.map((entry) => entry.name),
    ["BLUS30001/PARAM.SFO"],
  );
  assert.deepEqual(plan.refused, [
    { name: "BLES00002/PARAM.SFO", why: "it is not this game's save" },
    { name: "../../config.ini", why: "the name is not a safe path" },
  ]);
});

test("one odd member does not cost the rest of the set", () => {
  const plan = planRestore(
    [
      member("BLUS30001/A.DAT"),
      member("BLUS30001/../../../evil"),
      member("BLUS30001/B.DAT"),
    ],
    RPCS3,
  );
  assert.deepEqual(
    plan.write.map((entry) => entry.name),
    ["BLUS30001/A.DAT", "BLUS30001/B.DAT"],
  );
  assert.equal(plan.refused.length, 1);
});

test("an archive past the file or byte budget stops short", () => {
  const many = planRestore(
    [member("BLUS30001/A"), member("BLUS30001/B"), member("BLUS30001/C")],
    RPCS3,
    { maxFiles: 2, maxBytes: 1024 },
  );
  assert.equal(many.write.length, 2);
  assert.deepEqual(many.refused, [
    { name: "BLUS30001/C", why: "the archive holds too many files" },
  ]);

  const large = planRestore(
    [member("BLUS30001/A", "aaaa"), member("BLUS30001/B", "bbbb")],
    RPCS3,
    { maxFiles: 10, maxBytes: 6 },
  );
  assert.deepEqual(
    large.write.map((entry) => entry.name),
    ["BLUS30001/A"],
  );
  assert.equal(large.bytes, 4);
  assert.deepEqual(large.refused, [
    { name: "BLUS30001/B", why: "the archive is too large" },
  ]);
});

test("a Dolphin GameCube card file is matched by its stem", () => {
  const dolphin: SaveTarget = { target: "GALE01", layout: "file-prefix" };
  const plan = planRestore(
    [member("EUR/Card A/GALE01.gci"), member("EUR/Card A/GAFE01.gci")],
    dolphin,
  );
  assert.deepEqual(
    plan.write.map((entry) => entry.name),
    ["EUR/Card A/GALE01.gci"],
  );
});

test("what the archive did not replace is what a restore removes", () => {
  // Left in place, the file keeps the two sides from ever agreeing again:
  // every negotiation after it reads as a change this device made.
  assert.deepEqual(
    staleAfterRestore(
      ["BLUS30001/A.DAT", "BLUS30001/B.DAT", "BLUS30001/C.DAT"],
      [member("BLUS30001/C.DAT"), member("BLUS30001/A.DAT")],
    ),
    ["BLUS30001/B.DAT"],
  );
});

test("nothing is stale when the archive holds the whole set", () => {
  assert.deepEqual(
    staleAfterRestore(["BLUS30001/A.DAT"], [member("BLUS30001/A.DAT")]),
    [],
  );
});

test("a set travels under the name RomM's own archives use", () => {
  assert.equal(setFileName("Demon's Souls"), "Demon's Souls.saves.zip");
});

function tree(
  files: Record<string, { modifiedAt?: number; size?: number }>,
  complete = true,
  skipped: string[] = [],
): Tree {
  return {
    complete,
    skipped,
    files: new Map(
      Object.entries(files).map(([path, entry]) => [
        path,
        {
          size: entry.size ?? 1,
          modifiedAt: entry.modifiedAt ?? 0,
          changedAt: 0,
          inode: 1,
        },
      ]),
    ),
  };
}

const reads =
  (contents: Record<string, string>) =>
  async (path: string): Promise<Buffer | null> => {
    const found = contents[path];
    return found === undefined ? null : Buffer.from(found);
  };

test("a set is the target's files, their digest and the newest of their times", async () => {
  const set = await assembleSet(
    tree({
      "BLUS30001/A.DAT": { modifiedAt: 1000 },
      "BLUS30001/B.DAT": { modifiedAt: 5000 },
      "BLES00002/A.DAT": { modifiedAt: 9000 },
    }),
    RPCS3,
    reads({
      "BLUS30001/A.DAT": "aa",
      "BLUS30001/B.DAT": "bbb",
      "BLES00002/A.DAT": "zzzz",
    }),
  );
  assert.ok(set);
  assert.deepEqual(set.paths, ["BLUS30001/A.DAT", "BLUS30001/B.DAT"]);
  assert.equal(set.stamp.size, 5);
  // Not the other game's file, however recently it was written.
  assert.equal(set.updatedAt.getTime(), 5000);
  assert.equal(
    set.stamp.hash,
    zipContentHash([
      { name: "BLUS30001/A.DAT", contents: Buffer.from("aa") },
      { name: "BLUS30001/B.DAT", contents: Buffer.from("bbb") },
    ]),
  );
});

test("a listing that was cut short is not a set", async () => {
  // Half a set offered to the slot is one another device would restore over a
  // whole one, which is the only way this path can lose a save outright.
  assert.equal(
    await assembleSet(
      tree({ "BLUS30001/A.DAT": {} }, false),
      RPCS3,
      reads({ "BLUS30001/A.DAT": "aa" }),
    ),
    null,
  );
});

test("a member that will not read is not an empty one", async () => {
  assert.equal(
    await assembleSet(
      tree({ "BLUS30001/A.DAT": {}, "BLUS30001/B.DAT": {} }),
      RPCS3,
      reads({ "BLUS30001/A.DAT": "aa" }),
    ),
    null,
  );
});

test("a target matching more than any save could be is not a set", async () => {
  const files = { "BLUS30001/A.DAT": {}, "BLUS30001/B.DAT": {} };
  assert.equal(
    await assembleSet(tree(files), RPCS3, reads({}), {
      maxFiles: 1,
      maxBytes: 1024,
    }),
    null,
  );
  assert.equal(
    await assembleSet(
      tree(files),
      RPCS3,
      reads({ "BLUS30001/A.DAT": "aaaa", "BLUS30001/B.DAT": "bbbb" }),
      { maxFiles: 10, maxBytes: 6 },
    ),
    null,
  );
});

test("a set survives the trip it actually makes, digest and all", () => {
  // The invariant the whole sync rests on: what is zipped here comes back as
  // the same files under the same names, and the digest the server will have
  // computed over the archive is the one this device computed before sending
  // it. A difference in either is a conflict on every launch afterwards.
  const members = [
    member("BLUS30001/PARAM.SFO", "sfo"),
    member("BLUS30001/data/SDATA.DAT", "\u0000\u0001binary"),
    member("BLUS30001/été.DAT", "accented"),
  ];
  const read = readZipFiles(writeZip(members), {
    maxEntries: 100,
    maxTotalBytes: 1024 * 1024,
  });

  const plan = planRestore(read, RPCS3);
  assert.deepEqual(plan.refused, []);
  assert.deepEqual(
    plan.write.map((entry) => entry.name),
    members.map((entry) => entry.name),
  );
  for (const [index, entry] of plan.write.entries()) {
    assert.deepEqual(entry.contents, members[index]?.contents);
  }
  assert.equal(zipContentHash(plan.write), zipContentHash(members));
});

test("a symlink where a member belongs is not a set", async () => {
  // listTree skips it without following it, so the set would otherwise go up
  // missing a file and another device would restore that over its own copy.
  assert.equal(
    await assembleSet(
      tree({ "BLUS30001/PARAM.SFO": {} }, true, ["BLUS30001/data"]),
      RPCS3,
      reads({ "BLUS30001/PARAM.SFO": "sfo" }),
    ),
    null,
  );
});

test("a symlink standing in for the whole save folder is not a set", async () => {
  assert.equal(
    await assembleSet(
      tree({}, true, ["BLUS30001"]),
      RPCS3,
      reads({}),
    ),
    null,
  );
});

test("a symlink outside the target is somebody else's problem", async () => {
  const set = await assembleSet(
    tree({ "BLUS30001/PARAM.SFO": {} }, true, ["BLES00002/data"]),
    RPCS3,
    reads({ "BLUS30001/PARAM.SFO": "sfo" }),
  );
  assert.ok(set);
  assert.deepEqual(set.paths, ["BLUS30001/PARAM.SFO"]);
});

test("a member past the budget is refused before it is read", async () => {
  // The reader hands back a whole buffer, so a budget applied to what it
  // returns is applied after the allocation it was meant to prevent.
  let read = false;
  const set = await assembleSet(
    tree({ "BLUS30001/HUGE.DAT": { size: 10_000 } }),
    RPCS3,
    async () => {
      read = true;
      return Buffer.alloc(10_000);
    },
    { maxFiles: 10, maxBytes: 1024 },
  );
  assert.equal(set, null);
  assert.equal(read, false);
});

test("a file that grew since it was listed is still refused", async () => {
  assert.equal(
    await assembleSet(
      tree({ "BLUS30001/A.DAT": { size: 1 } }),
      RPCS3,
      async () => Buffer.alloc(5_000),
      { maxFiles: 10, maxBytes: 1024 },
    ),
    null,
  );
});

test("one file under two spellings is not stale where the filesystem agrees", () => {
  // The restore has already written DATA.DAT by writing data.dat, so calling
  // the first stale would delete the save that just arrived.
  assert.deepEqual(
    staleAfterRestore(
      ["BLUS30001/DATA.DAT"],
      [member("BLUS30001/data.dat")],
      true,
    ),
    [],
  );
  assert.deepEqual(
    staleAfterRestore(
      ["BLUS30001/DATA.DAT"],
      [member("BLUS30001/data.dat")],
      false,
    ),
    ["BLUS30001/DATA.DAT"],
  );
});

test("a folder with none of this game's files is an empty set, not an absent one", async () => {
  // Somewhere for a download to land, which is the difference that decides
  // whether the server is asked for one at all.
  const set = await assembleSet(
    tree({ "BLES00002/A.DAT": {} }),
    RPCS3,
    reads({}),
  );
  assert.ok(set);
  assert.deepEqual(set.members, []);
  assert.equal(set.stamp.size, 0);
});
