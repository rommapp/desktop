import assert from "node:assert/strict";
import { test } from "node:test";

import {
  archiveName,
  AUTOSAVE_SLOT,
  buildNegotiatePayload,
  MAX_SAVE_BYTES,
  planPull,
  planPush,
  planTick,
  selectOperation,
  storedSave,
  watchIntervalFor,
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
  const chosen = selectOperation(
    [op({ rom_id: 7, slot: null, save_id: 4 })],
    7,
  );
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
  assert.deepEqual(plan, {
    pull: true,
    archiveFirst: false,
    allowance: "push",
  });
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
  assert.equal(
    planPush(stamp(), stamp({ hash: "bbbb" }), "unreachable"),
    "none",
  );
});

test("a conflicted save is archived, never written over", () => {
  const allowance: Allowance = "conflict";
  assert.equal(
    planPush(stamp(), stamp({ hash: "bbbb" }), allowance),
    "archive",
  );
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
    {
      name: "a save the emulator just made",
      before: null,
      after: stamp(),
      want: "push",
    },
    {
      name: "a save the emulator removed",
      before: stamp(),
      after: null,
      want: "none",
    },
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

test("a reading during a run is offered once two agree on it", () => {
  const cases: {
    name: string;
    previous: SaveStamp | null;
    current: SaveStamp | null;
    baseline: SaveStamp | null;
    want: boolean;
  }[] = [
    {
      // The emulator is mid-write as far as this can tell, so it waits.
      name: "a reading nothing agrees with yet",
      previous: stamp({ hash: "aaaa" }),
      current: stamp({ hash: "bbbb" }),
      baseline: stamp({ hash: "aaaa" }),
      want: false,
    },
    {
      name: "two readings agreeing on new bytes",
      previous: stamp({ hash: "bbbb" }),
      current: stamp({ hash: "bbbb" }),
      baseline: stamp({ hash: "aaaa" }),
      want: true,
    },
    {
      name: "bytes the server already holds",
      previous: stamp(),
      current: stamp(),
      baseline: stamp(),
      want: false,
    },
    {
      name: "the first save of a game the server has none for",
      previous: stamp({ hash: "bbbb" }),
      current: stamp({ hash: "bbbb" }),
      baseline: null,
      want: true,
    },
    {
      name: "nothing on disk yet",
      previous: null,
      current: null,
      baseline: null,
      want: false,
    },
    {
      // No hash is no opinion, here as everywhere else.
      name: "a save the shell cannot read",
      previous: stamp({ hash: null }),
      current: stamp({ hash: null }),
      baseline: null,
      want: false,
    },
  ];

  for (const { name, previous, current, baseline, want } of cases) {
    assert.equal(planTick(previous, current, baseline), want, name);
  }
});

test("the watch cadence is a fraction of the writing cadence, never equal to it", () => {
  // Equal cadences are how a game that writes on every flush is never offered
  // at all: each reading catches a different version and no two ever agree.
  for (const seconds of [10, 30, 6]) {
    const interval = watchIntervalFor(seconds);
    assert.ok(
      interval <= (seconds * 1000) / 3,
      `${seconds}s cadence looked every ${interval}ms`,
    );
  }
});

test("an unknown writing cadence still gets looked at", () => {
  // Zero is the user leaving RetroArch's own interval alone, which the shell
  // cannot read. Whatever the emulator does, looking costs a hash.
  assert.equal(watchIntervalFor(0), watchIntervalFor(10));
  for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
    assert.equal(watchIntervalFor(bad), watchIntervalFor(10), `${bad}`);
  }
});

test("an absurd writing cadence is capped, not turned into a hot loop", () => {
  // A setInterval delay past a signed 32-bit millisecond count does not wait
  // longer, it fires every millisecond, so the quietest possible setting would
  // become the busiest loop in the shell.
  const interval = watchIntervalFor(Number.MAX_SAFE_INTEGER);
  assert.ok(interval <= 5 * 60 * 1000, `capped at ${interval}ms`);
  assert.ok(interval > 0);
});

test("a very short writing cadence is floored, not chased", () => {
  // Hashing a memory card measured in megabytes is not free, and no emulator
  // writes a save every fraction of a second.
  assert.ok(watchIntervalFor(1) >= 2_000);
});

test("only the bytes whose digest settled are sent", () => {
  // The push reads the file itself, so the reading that settled has to be named
  // for the two to be the same bytes. A write that landed in between leaves a
  // file that no longer hashes to it, and that is not a save to put in the slot
  // every other device syncs from.
  assert.equal(
    planPush(stamp({ hash: "aaaa" }), stamp({ hash: "bbbb" }), "push", "bbbb"),
    "push",
  );
  assert.equal(
    planPush(stamp({ hash: "aaaa" }), stamp({ hash: "cccc" }), "push", "bbbb"),
    "none",
  );
  // A caller with no reading behind it -- the push after the exit -- is
  // unaffected by any of this.
  assert.equal(
    planPush(stamp({ hash: "aaaa" }), stamp({ hash: "cccc" }), "push"),
    "push",
  );
});

test("a settled digest is required even of a save the server asked for", () => {
  // "requested" sends whether or not the run changed anything, which is not a
  // licence to send half a file.
  assert.equal(
    planPush(null, stamp({ hash: "cccc" }), "requested", "bbbb"),
    "none",
  );
  assert.equal(
    planPush(null, stamp({ hash: "bbbb" }), "requested", "bbbb"),
    "push",
  );
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
  for (const body of [
    null,
    undefined,
    "",
    "<html>",
    12,
    [],
    {},
    { id: "12" },
  ]) {
    assert.equal(storedSave(body), false, JSON.stringify(body) ?? "undefined");
  }
});
