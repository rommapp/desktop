import assert from "node:assert/strict";
import { test } from "node:test";

import {
  archiveName,
  AUTOSAVE_SLOT,
  buildNegotiatePayload,
  MAX_SAVE_BYTES,
  planPull,
  planPush,
  selectOperation,
  storedSave,
  type Allowance,
  type SaveStamp,
  type SyncOperation,
} from "./plan.ts";

function op(patch: Partial<SyncOperation> = {}): SyncOperation {
  return {
    action: "no_op",
    rom_id: 7,
    save_id: null,
    file_name: "Game.srm",
    slot: null,
    server_content_hash: null,
    ...patch,
  };
}

function stamp(patch: Partial<SaveStamp> = {}): SaveStamp {
  return { hash: "aaaa", size: 32, ...patch };
}

test("the negotiate body describes one save, in the shared slot", () => {
  const body = buildNegotiatePayload(7, {
    fileName: "Game.srm",
    contentHash: "aaaa",
    updatedAt: new Date("2026-09-18T12:00:00.000Z"),
    sizeBytes: 32,
  });

  assert.deepEqual(body, {
    saves: [
      {
        rom_id: 7,
        file_name: "Game.srm",
        slot: AUTOSAVE_SLOT,
        content_hash: "aaaa",
        updated_at: "2026-09-18T12:00:00.000Z",
        file_size_bytes: 32,
      },
    ],
    rom_ids: [7],
  });
});

test("the negotiate body names no emulator", () => {
  // Assets are filed per emulator on the server, so naming one would put a
  // native launch's saves where the browser client does not look.
  const [save] = buildNegotiatePayload(1, {
    fileName: "Game.srm",
    contentHash: null,
    updatedAt: new Date(0),
    sizeBytes: 0,
  }).saves;
  assert.ok(save);
  assert.equal("emulator" in save, false);
});

test("a launch with nothing on disk offers the server nothing", () => {
  // An empty list rather than an entry with a zero size: the difference is
  // between "I have no save" and "I have an empty one".
  assert.deepEqual(buildNegotiatePayload(7, null), {
    saves: [],
    rom_ids: [7],
  });
});

test("the save ceiling matches the server's upload limit", () => {
  assert.equal(MAX_SAVE_BYTES, 512 * 1024 * 1024);
});

test("the operation taken is this ROM's, in the shared slot", () => {
  const chosen = selectOperation(
    [
      op({ rom_id: 9, slot: AUTOSAVE_SLOT, save_id: 1 }),
      op({ rom_id: 7, slot: "manual", save_id: 2 }),
      op({ rom_id: 7, slot: AUTOSAVE_SLOT, save_id: 3 }),
    ],
    7,
  );
  assert.equal(chosen?.save_id, 3);
});

test("a save in another slot is never taken for this launch", () => {
  // With no local save to compare against the server describes every slot the
  // ROM has. Downloading a manual slot into the autosave file would boot a save
  // the player did not ask for.
  const chosen = selectOperation(
    [op({ rom_id: 7, slot: "manual", action: "download", save_id: 2 })],
    7,
  );
  assert.equal(chosen, null);
});

test("an operation naming no slot is still this launch's", () => {
  // The server talking about the ROM rather than about one of its slots.
  const chosen = selectOperation([op({ rom_id: 7, slot: null, save_id: 4 })], 7);
  assert.equal(chosen?.save_id, 4);
});

test("the shared slot is preferred over an unattributed operation", () => {
  const chosen = selectOperation(
    [
      op({ rom_id: 7, slot: null, save_id: 4 }),
      op({ rom_id: 7, slot: AUTOSAVE_SLOT, save_id: 5 }),
    ],
    7,
  );
  assert.equal(chosen?.save_id, 5);
});

test("an answer about other ROMs alone yields nothing", () => {
  assert.equal(selectOperation([op({ rom_id: 9 })], 7), null);
  assert.equal(selectOperation([], 7), null);
});

test("entries that are not operations are passed over", () => {
  assert.equal(selectOperation([null, 3, "op", []], 7), null);
});

test("an answer with nothing in it still permits the push", () => {
  // The first launch of a game neither side has a save for. The server was
  // asked and had nothing to say, which is not the same as not being able to
  // ask: the save the emulator is about to make is the shell's to offer.
  assert.deepEqual(planPull(null, stamp()), {
    pull: false,
    archiveFirst: false,
    allowance: "push",
  });
});

test("a download is taken, and the server's own bytes are not archived", () => {
  // The local file already holds exactly what the server holds, so writing it
  // back over is not a loss.
  const plan = planPull(
    op({ action: "download", save_id: 3, server_content_hash: "aaaa" }),
    stamp({ hash: "aaaa" }),
  );
  assert.deepEqual(plan, { pull: true, archiveFirst: false, allowance: "push" });
});

test("a download over diverging local bytes archives them first", () => {
  const plan = planPull(
    op({ action: "download", save_id: 3, server_content_hash: "bbbb" }),
    stamp({ hash: "aaaa" }),
  );
  assert.equal(plan.pull, true);
  assert.equal(plan.archiveFirst, true);
});

test("a download onto nothing needs no archive first", () => {
  const download = op({
    action: "download",
    save_id: 3,
    server_content_hash: "bbbb",
  });
  assert.deepEqual(planPull(download, null), {
    pull: true,
    archiveFirst: false,
    allowance: "push",
  });
});

test("a download over a local save the shell cannot read is refused", () => {
  // A null hash is a file that exists and could not be read. Pulling would
  // rename the server's copy over bytes nothing has been shown to hold, so the
  // launch keeps what is on disk instead.
  const plan = planPull(
    op({ action: "download", save_id: 3, server_content_hash: "bbbb" }),
    stamp({ hash: null }),
  );
  assert.equal(plan.pull, false);
  assert.equal(plan.archiveFirst, false);
  assert.equal(plan.allowance, "push");
});

test("a download the server cannot describe is refused", () => {
  // Without a hash there is nothing to check the transfer against before the
  // rename, and a truncated body would replace a working save with half of one.
  const plan = planPull(
    op({ action: "download", save_id: 3, server_content_hash: null }),
    stamp(),
  );
  assert.equal(plan.pull, false);
  assert.equal(plan.archiveFirst, false);
});

test("a download with no server save id pulls nothing", () => {
  const plan = planPull(op({ action: "download", save_id: null }), stamp());
  assert.equal(plan.pull, false);
  assert.equal(plan.archiveFirst, false);
});

test("a no-op pulls nothing and leaves the push allowed", () => {
  assert.deepEqual(planPull(op({ action: "no_op" }), stamp()), {
    pull: false,
    archiveFirst: false,
    allowance: "push",
  });
});

test("an upload is the server asking for the save, not permitting it", () => {
  assert.deepEqual(planPull(op({ action: "upload" }), stamp()), {
    pull: false,
    archiveFirst: false,
    allowance: "requested",
  });
});

test("a conflict pulls nothing and marks the push as archival", () => {
  const plan = planPull(op({ action: "conflict", save_id: 3 }), stamp());
  assert.equal(plan.pull, false);
  assert.equal(plan.archiveFirst, false);
  assert.equal(plan.allowance, "conflict");
});

test("an unreachable server is never offered anything", () => {
  assert.equal(planPush(stamp(), stamp({ hash: "bbbb" }), "unreachable"), "none");
});

test("a conflicted save is archived, never written over", () => {
  const allowance: Allowance = "conflict";
  assert.equal(planPush(stamp(), stamp({ hash: "bbbb" }), allowance), "archive");
});

test("a conflict with nothing on disk does nothing", () => {
  assert.equal(planPush(stamp(), null, "conflict"), "none");
});

test("a conflicted save the emulator did not touch is not archived again", () => {
  // Otherwise every launch of a conflicted game files another copy, and an
  // archival save has no slot to rotate and nothing to reap it.
  assert.equal(planPush(stamp(), stamp(), "conflict"), "none");
});

test("a conflicted save is archived when the shell cannot tell", () => {
  // An archive replaces nothing, so an unnecessary one costs a duplicate where
  // an unnecessary push would mint a version other devices sync from.
  assert.equal(planPush(stamp({ hash: null }), stamp(), "conflict"), "archive");
  assert.equal(planPush(null, stamp(), "conflict"), "archive");
});

test("a save the server asked for is sent whether or not it changed", () => {
  // The server has nothing paired with this slot. Someone adopting sync with a
  // shelf of existing saves would otherwise never get them to RomM: each one
  // waits for a session that happens to change it.
  assert.equal(planPush(stamp(), stamp(), "requested"), "push");
  assert.equal(planPush(stamp(), stamp({ hash: "bbbb" }), "requested"), "push");
  assert.equal(planPush(null, stamp(), "requested"), "push");
  assert.equal(planPush(stamp({ hash: null }), stamp(), "requested"), "push");
});

test("a save the emulator removed is not sent even when asked for", () => {
  // Nothing on disk is nothing to send, and a deletion is still not something
  // this shell propagates.
  assert.equal(planPush(stamp(), null, "requested"), "none");
});

test("only a changed save is sent", () => {
  const cases: {
    name: string;
    before: SaveStamp | null;
    after: SaveStamp | null;
    want: "none" | "push";
  }[] = [
    { name: "identical bytes", before: stamp(), after: stamp(), want: "none" },
    {
      name: "different bytes",
      before: stamp(),
      after: stamp({ hash: "bbbb" }),
      want: "push",
    },
    { name: "a save the emulator just made", before: null, after: stamp(), want: "push" },
    { name: "a save the emulator removed", before: stamp(), after: null, want: "none" },
    {
      name: "a save that was unreadable before",
      before: stamp({ hash: null }),
      after: stamp({ hash: "bbbb" }),
      want: "none",
    },
    {
      name: "a save that is unreadable now",
      before: stamp(),
      after: stamp({ hash: null }),
      want: "none",
    },
    {
      // Size alone is not a change: hashing is what the server compares.
      name: "a same-hash file that grew",
      before: stamp({ size: 32 }),
      after: stamp({ size: 64 }),
      want: "none",
    },
  ];

  for (const { name, before, after, want } of cases) {
    assert.equal(planPush(before, after, "push"), want, name);
  }
});

test("an archive is named the way the browser client names states", () => {
  // The value sessionStateName produces, with the extension a save carries.
  assert.equal(
    archiveName("Game.srm", new Date("2026-09-18T12:00:00.000Z")),
    "Game [2026-09-18 12-00-00-000].srm",
  );
});

test("an archive of a nameless save still gets an extension", () => {
  assert.equal(
    archiveName("Game", new Date("2026-01-02T03:04:05.006Z")),
    "Game [2026-01-02 03-04-05-006].srm",
  );
});

test("an accepted upload is the save the server stored", () => {
  assert.ok(storedSave({ id: 12, rom_id: 7, file_name: "Game.srm" }));
});

test("a 2xx that is not a save is not an accepted upload", () => {
  // What a sign-in page, a proxy, or a body that would not parse looks like by
  // the time it reaches here. Each one would otherwise green-light the pull
  // that writes over the bytes this upload was meant to be preserving.
  for (const body of [null, undefined, "", "<html>", 12, [], {}, { id: "12" }]) {
    assert.equal(storedSave(body), false, JSON.stringify(body) ?? "undefined");
  }
});
