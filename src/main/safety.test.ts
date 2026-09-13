import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolveDownloadUrl,
  resolveLibraryRom,
  safeCacheFileName,
  validateLaunchRequest,
} from "./safety.ts";

const SERVER = "https://romm.example.com";

test("resolveDownloadUrl accepts an API path on the bound origin", () => {
  const url = resolveDownloadUrl(SERVER, "/api/roms/7/content/game.zip");
  assert.equal(url.href, `${SERVER}/api/roms/7/content/game.zip`);
});

test("resolveDownloadUrl preserves query parameters", () => {
  const url = resolveDownloadUrl(
    SERVER,
    "/api/roms/7/content/g.zip?file_ids=1,2",
  );
  assert.equal(url.searchParams.get("file_ids"), "1,2");
});

test("resolveDownloadUrl encodes the unescaped names getDownloadPath emits", () => {
  const url = resolveDownloadUrl(
    SERVER,
    "/api/roms/42/content/Chrono Trigger (USA).sfc",
  );
  assert.equal(
    url.href,
    `${SERVER}/api/roms/42/content/Chrono%20Trigger%20(USA).sfc`,
  );
});

test("resolveDownloadUrl rejects protocol-relative hosts", () => {
  assert.throws(() => resolveDownloadUrl(SERVER, "//evil.example/api/x"), {
    code: "invalid-request",
  });
});

test("resolveDownloadUrl rejects absolute off-origin URLs", () => {
  assert.throws(
    () => resolveDownloadUrl(SERVER, "https://evil.example/api/roms/1"),
    { code: "invalid-request" },
  );
});

test("resolveDownloadUrl rejects traversal that escapes the API root", () => {
  assert.throws(() => resolveDownloadUrl(SERVER, "/api/../../etc/passwd"), {
    code: "invalid-request",
  });
});

test("resolveDownloadUrl rejects non-API routes", () => {
  assert.throws(() => resolveDownloadUrl(SERVER, "/login"), {
    code: "invalid-request",
  });
});

test("safeCacheFileName collapses separators into one component", () => {
  assert.equal(safeCacheFileName("a/b\\c.zip", 1), "1-a_b_c.zip");
});

test("safeCacheFileName defuses traversal sequences", () => {
  const name = safeCacheFileName("../../etc/passwd", 3);
  assert.ok(name.startsWith("3-"));
  assert.ok(!name.includes("/"), "no path separator survives");
  assert.ok(!name.includes("\\"), "no windows separator survives");
  assert.equal(join("/cache", name), `/cache/${name}`);
});

test("safeCacheFileName always yields a non-empty name", () => {
  assert.equal(safeCacheFileName("", 9), "9-rom");
  assert.equal(safeCacheFileName("...", 9), "9-rom");
});

/** A stand-in library tree with one real ROM in it. */
function fakeLibrary() {
  const root = mkdtempSync(join(tmpdir(), "romm-library-"));
  mkdirSync(join(root, "roms", "ps2"), { recursive: true });
  const rom = join(root, "roms", "ps2", "game.chd");
  writeFileSync(rom, "0123456789");
  return { root, rom, size: 10 };
}

test("resolveLibraryRom finds a ROM under the configured root", () => {
  const { root, rom } = fakeLibrary();
  assert.equal(resolveLibraryRom(root, "roms/ps2/game.chd"), rom);
});

test("resolveLibraryRom is off unless both halves are present", () => {
  const { root } = fakeLibrary();
  assert.equal(resolveLibraryRom(null, "roms/ps2/game.chd"), null);
  assert.equal(resolveLibraryRom(root, undefined), null);
  assert.equal(resolveLibraryRom(root, ""), null);
});

test("resolveLibraryRom refuses to escape the configured root", () => {
  const { root } = fakeLibrary();
  const outside = join(tmpdir(), "romm-library-escape-target");
  writeFileSync(outside, "secret");

  for (const evil of [
    "../romm-library-escape-target",
    "roms/../../romm-library-escape-target",
    "roms/ps2/../../../romm-library-escape-target",
    outside,
  ]) {
    assert.equal(
      resolveLibraryRom(root, evil),
      null,
      `${evil} must not resolve`,
    );
  }
});

test("resolveLibraryRom rejects a path that is not a file", () => {
  const { root } = fakeLibrary();
  assert.equal(resolveLibraryRom(root, "roms/ps2"), null);
  assert.equal(resolveLibraryRom(root, "roms/ps2/missing.chd"), null);
});

test("resolveLibraryRom falls back when the size does not match", () => {
  const { root, rom, size } = fakeLibrary();
  assert.equal(resolveLibraryRom(root, "roms/ps2/game.chd", size), rom);
  // A different size means a different file, so download instead.
  assert.equal(resolveLibraryRom(root, "roms/ps2/game.chd", size + 1), null);
});

test("validateLaunchRequest accepts and passes through the library fields", () => {
  const request = validateLaunchRequest({
    romId: 7,
    downloadPath: "/api/roms/7/content/game.chd",
    fileName: "game.chd",
    platformSlug: "ps2",
    cores: [],
    serverPath: "roms/ps2/game.chd",
    fileSize: 4_000_000_000,
  });
  assert.equal(request.serverPath, "roms/ps2/game.chd");
  assert.equal(request.fileSize, 4_000_000_000);
});

test("validateLaunchRequest rejects malformed library fields", () => {
  const base = {
    romId: 7,
    downloadPath: "/api/roms/7/content/game.chd",
    fileName: "game.chd",
    platformSlug: "ps2",
    cores: [],
  };
  assert.throws(() => validateLaunchRequest({ ...base, serverPath: 42 }), {
    code: "invalid-request",
  });
  assert.throws(() => validateLaunchRequest({ ...base, fileSize: -1 }), {
    code: "invalid-request",
  });
  assert.throws(() => validateLaunchRequest({ ...base, fileSize: 1.5 }), {
    code: "invalid-request",
  });
});
