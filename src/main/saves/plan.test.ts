import assert from "node:assert/strict";
import { test } from "node:test";

import {
  archiveName,
  AUTOSAVE_SLOT,
  buildNegotiatePayload,
  MAX_SAVE_BYTES,
  planPull,
  planPush,
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

test("an unasked question permits nothing", () => {
  assert.deepEqual(planPull(null, stamp()), {
    pull: false,
    archiveFirst: false,
    allowance: "unreachable",
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

test("an absent or unreadable local save has no bytes to archive", () => {
  const download = op({
    action: "download",
    save_id: 3,
    server_content_hash: "bbbb",
  });
  assert.equal(planPull(download, null).archiveFirst, false);
  // Null hash means the shell could not read it, which is not evidence that it
  // differs from the server's copy.
  assert.equal(planPull(download, stamp({ hash: null })).archiveFirst, false);
});

test("a download with no server save id pulls nothing", () => {
  const plan = planPull(op({ action: "download", save_id: null }), stamp());
  assert.equal(plan.pull, false);
  assert.equal(plan.archiveFirst, false);
});

test("an upload or a no-op pulls nothing and leaves the push allowed", () => {
  for (const action of ["upload", "no_op"] as const) {
    assert.deepEqual(planPull(op({ action }), stamp()), {
      pull: false,
      archiveFirst: false,
      allowance: "push",
    });
  }
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
