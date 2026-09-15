import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type RemoteFirmware,
  platformIdFor,
  planFirmwareSync,
  readFirmwareList,
} from "./plan.ts";

/** A firmware row shaped as RomM's /api/firmware returns one. */
function row(patch: Record<string, unknown> = {}) {
  return {
    id: 7,
    platform_id: 3,
    file_name: "scph5501.bin",
    file_name_no_tags: "scph5501",
    file_name_no_ext: "scph5501",
    file_extension: "bin",
    file_path: "bios/psx",
    file_size_bytes: 524288,
    full_path: "/romm/bios/psx/scph5501.bin",
    is_verified: true,
    crc_hash: "",
    md5_hash: "",
    sha1_hash: "",
    missing_from_fs: false,
    ...patch,
  };
}

test("a slug is resolved to the platform id RomM gave it", () => {
  const platforms = [
    { id: 1, slug: "snes", fs_slug: "snes" },
    { id: 3, slug: "psx", fs_slug: "playstation" },
  ];
  assert.equal(platformIdFor(platforms, "psx"), 3);
  // Matched on slug, not on the filesystem name: a library whose directory is
  // called something else still reports the frontend's slug here.
  assert.equal(platformIdFor(platforms, "playstation"), null);
  assert.equal(platformIdFor(platforms, "PSX"), 3);
  assert.equal(platformIdFor(platforms, "wiiu"), null);
});

test("an id that could not be part of a URL path is refused", () => {
  // It goes straight into /api/firmware?platform_id=, so anything but a
  // positive integer is not something to ask for.
  for (const id of ["3", 3.5, -1, 0, null, undefined]) {
    assert.equal(platformIdFor([{ id, slug: "psx" }], "psx"), null, `${id}`);
  }
});

test("a platform list that cannot be read yields nothing, not a throw", () => {
  for (const junk of [null, undefined, "", 42, {}, [null, 7, { slug: 1 }]]) {
    assert.equal(platformIdFor(junk, "psx"), null, `${junk}`);
  }
});

test("a firmware row is read down to what a download needs", () => {
  assert.deepEqual(readFirmwareList([row()]), [
    { id: 7, fileName: "scph5501.bin", size: 524288 },
  ]);
});

test("a file the server has lost is not asked for", () => {
  // The row outlives the file when a scan finds it gone, and the content
  // endpoint answers 404 rather than bytes.
  assert.deepEqual(readFirmwareList([row({ missing_from_fs: true })]), []);
});

test("a firmware name that is not a plain filename is refused outright", () => {
  // These names are used verbatim, because an emulator looks for scph5501.bin
  // and not for whatever a sanitiser would have renamed it to. So a name that
  // would need rewriting cannot be made safe without breaking the only thing
  // it is for.
  for (const fileName of [
    "../../../etc/passwd",
    "psx/scph5501.bin",
    "..\\evil.bin",
    "",
    "CON.bin",
    "bios.bin ",
  ]) {
    assert.deepEqual(
      readFirmwareList([row({ file_name: fileName })]),
      [],
      fileName,
    );
  }
});

test("two rows naming one file do not fight over it", () => {
  // They would land on the same path, and the mirror would flip between them
  // on alternate launches.
  const listed = readFirmwareList([
    row({ id: 7, file_size_bytes: 1 }),
    row({ id: 8, file_size_bytes: 2 }),
    row({ id: 9, file_name: "SCPH5501.BIN", file_size_bytes: 3 }),
  ]);
  assert.deepEqual(listed, [{ id: 7, fileName: "scph5501.bin", size: 1 }]);
});

test("a firmware list that cannot be read yields nothing, not a throw", () => {
  for (const junk of [
    null,
    undefined,
    "",
    42,
    {},
    [null, 7, { id: "x" }],
    [row({ id: 0 })],
    [row({ file_size_bytes: "524288" })],
    [row({ file_size_bytes: -1 })],
  ]) {
    assert.deepEqual(readFirmwareList(junk), [], `${JSON.stringify(junk)}`);
  }
});

const BIOS: RemoteFirmware = {
  id: 7,
  fileName: "scph5501.bin",
  size: 524288,
};

test("what is already on disk at the right size is not fetched again", () => {
  const plan = planFirmwareSync(
    [BIOS],
    [{ fileName: "scph5501.bin", size: 524288 }],
  );
  assert.deepEqual(plan.fetch, []);
  assert.deepEqual(plan.remove, []);
  // Still counted: the server lists one file for this platform, whether or not
  // this particular run had to fetch it.
  assert.equal(plan.total, 1);
});

test("a file of the right name and the wrong size is fetched again", () => {
  // A transfer that died mid-write, or a better dump uploaded to RomM under
  // the same name. The name alone is not evidence of the contents, which is
  // the same test the local-library ROM lookup applies.
  for (const size of [1, 524287, 524289]) {
    const plan = planFirmwareSync([BIOS], [{ fileName: "scph5501.bin", size }]);
    assert.deepEqual(plan.fetch, [BIOS], `${size}`);
    assert.deepEqual(plan.remove, [], `${size}`);
  }
});

test("a file the server no longer lists is removed", () => {
  // This is a mirror, not an accumulation: deleting firmware in RomM should
  // take it off this machine, or an emulator scanning its system directory
  // keeps finding what nobody meant to keep.
  const plan = planFirmwareSync(
    [BIOS],
    [
      { fileName: "scph5501.bin", size: 524288 },
      { fileName: "scph1001.bin", size: 524288 },
    ],
  );
  assert.deepEqual(plan.fetch, []);
  assert.deepEqual(plan.remove, ["scph1001.bin"]);
});

test("a case-different name is the same file, not one to delete", () => {
  // Windows and macOS would treat these as one path, so removing "the one the
  // server does not list" would delete the one it does.
  const plan = planFirmwareSync(
    [BIOS],
    [{ fileName: "SCPH5501.BIN", size: 524288 }],
  );
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.fetch, []);
});

test("an empty server list empties the mirror", () => {
  const plan = planFirmwareSync([], [{ fileName: "scph5501.bin", size: 1 }]);
  assert.deepEqual(plan.remove, ["scph5501.bin"]);
  assert.equal(plan.total, 0);
});

test("a platform with no firmware asks for nothing and removes nothing", () => {
  // The usual case by a wide margin: most platforms need no BIOS at all.
  assert.deepEqual(planFirmwareSync([], []), {
    fetch: [],
    remove: [],
    total: 0,
  });
});
