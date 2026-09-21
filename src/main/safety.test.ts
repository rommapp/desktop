import assert from "node:assert/strict";
import { mkdirSync as makeDir, symlinkSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_PLATFORM_QUERIES } from "../shared/types.ts";
import { testConfig } from "../test/config.ts";
import {
  assertSeparateRoots,
  isAllowedDownloadOrigin,
  isPlainFileName,
  resolveDownloadUrl,
  resolveLibraryRom,
  safeFileName,
  validateLaunchRequest,
  validatePlatformQueries,
  validatePlatformQuery,
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

test("safeFileName collapses separators into one component", () => {
  assert.equal(safeFileName("a/b\\c.zip"), "a_b_c.zip");
});

test("safeFileName defuses traversal sequences", () => {
  const name = safeFileName("../../etc/passwd");
  assert.ok(!name.includes("/"), "no path separator survives");
  assert.ok(!name.includes("\\"), "no windows separator survives");
  assert.equal(join("/cache", name), `/cache/${name}`);
});

test("safeFileName always yields a non-empty name", () => {
  assert.equal(safeFileName(""), "rom");
  assert.equal(safeFileName("..."), "rom");
});

test("safeFileName keeps the name the server gave, extension and all", () => {
  // The cache used to prefix the ROM id, which is what kept it clear of the
  // device names below. The directory carries the id now, so this does.
  assert.equal(safeFileName("Chrono Trigger.sfc"), "Chrono Trigger.sfc");
  assert.equal(safeFileName("CON.zip"), "_CON.zip");
  assert.equal(safeFileName("lpt1.n64"), "_lpt1.n64");
  assert.equal(safeFileName("Contra.nes"), "Contra.nes");
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

test("validateLaunchRequest carries the display choice, and only as a boolean", () => {
  const base = {
    romId: 7,
    downloadPath: "/api/roms/7/content/game.gba",
    fileName: "game.gba",
    platformSlug: "gba",
    cores: ["mgba"],
  };
  assert.equal(
    validateLaunchRequest({ ...base, fullscreen: true }).fullscreen,
    true,
  );
  // Absent, not false: a launch that says nothing leaves the user's own
  // RetroArch setting to decide.
  assert.equal(validateLaunchRequest(base).fullscreen, undefined);
  assert.throws(() => validateLaunchRequest({ ...base, fullscreen: "yes" }), {
    code: "invalid-request",
  });
});

test("safeFileName never returns a component that addresses a directory", () => {
  // Leading whitespace used to survive the dot-stripping, so " .." came back
  // as ".." and named the parent of the ROM directory it was joined onto.
  for (const name of [" ..", " .", "  ...  ", ".."]) {
    assert.equal(safeFileName(name), "rom", `${JSON.stringify(name)} is inert`);
  }
});

test("safeFileName drops trailing dots and spaces Windows ignores", () => {
  // Otherwise "game." and "game" name one file while looking like two.
  assert.equal(safeFileName("game."), "game");
  assert.equal(safeFileName("game. "), "game");
  assert.equal(safeFileName("game.sfc"), "game.sfc");
});

test("safeFileName reads a device name up to the first dot", () => {
  assert.equal(safeFileName("CON.foo.zip"), "_CON.foo.zip");
  assert.equal(safeFileName("nul.tar.gz"), "_nul.tar.gz");
});

/** A config differing only in the paths this guard looks at. */
function roots(
  cachePath: string | null,
  saveDataPath: string | null,
  biosPath: string | null = null,
) {
  return testConfig({ cachePath, saveDataPath, biosPath });
}

test("assertSeparateRoots accepts directories that do not contain each other", () => {
  assertSeparateRoots(roots("/data/rom-cache", "/data/save-data"));
  assertSeparateRoots(roots(null, "/data/save-data"));
});

test("assertSeparateRoots rejects a save tree the cache would evict", () => {
  // Eviction removes a ROM directory whole, so saves underneath it go too.
  const collisions: [string, string][] = [
    ["/data/cache", "/data/cache"],
    ["/data/cache", "/data/cache/saves"],
    ["/data/cache/roms", "/data/cache"],
    ["/data/cache", "/data/cache/../cache/inner"],
  ];
  for (const [cache, saves] of collisions) {
    assert.throws(
      () => assertSeparateRoots(roots(cache, saves)),
      { code: "invalid-request" },
      `${cache} and ${saves} must be refused`,
    );
  }
});

test("assertSeparateRoots sees through a filesystem root", () => {
  // A prefix comparison misses this: resolve("/") already ends in a separator.
  assert.throws(() => assertSeparateRoots(roots("/", "/save-data")), {
    code: "invalid-request",
  });
});

test("assertSeparateRoots follows a symlinked save tree", () => {
  // Lexically distinct, physically the same directory, so eviction would take
  // the save data with the ROM.
  const base = mkdtempSync(join(tmpdir(), "romm-roots-"));
  const cache = join(base, "rom-cache");
  const link = join(base, "save-data");
  makeDir(cache, { recursive: true });
  symlinkSync(cache, link, "dir");

  assert.throws(() => assertSeparateRoots(roots(cache, link)), {
    code: "invalid-request",
  });
});

test("assertSeparateRoots allows a save tree that does not exist yet", () => {
  const base = mkdtempSync(join(tmpdir(), "romm-roots-"));
  assertSeparateRoots(
    roots(join(base, "rom-cache"), join(base, "not-created-yet")),
  );
});

test("a download origin is allowed only when it matches exactly", () => {
  const policy = { origins: ["https://dl.dolphin-emu.org"] };
  assert.ok(
    isAllowedDownloadOrigin(
      "https://dl.dolphin-emu.org/releases/a.dmg",
      policy,
    ),
  );
  assert.equal(
    isAllowedDownloadOrigin("https://dolphin-emu.org/releases/a.dmg", policy),
    false,
  );
  assert.equal(
    isAllowedDownloadOrigin("https://evil.example.com/a.dmg", policy),
    false,
  );
});

test("a host suffix matches only on a dot boundary", () => {
  // GitHub release assets answer from release-assets.githubusercontent.com, and
  // that name has changed before, so the suffix is what is pinned. It must not
  // let a lookalike through.
  const policy = {
    origins: ["https://github.com"],
    hostSuffixes: ["githubusercontent.com"],
  };
  assert.ok(isAllowedDownloadOrigin("https://github.com/a/b/c.exe", policy));
  assert.ok(
    isAllowedDownloadOrigin(
      "https://release-assets.githubusercontent.com/x?sig=y",
      policy,
    ),
  );
  assert.ok(isAllowedDownloadOrigin("https://githubusercontent.com/x", policy));
  assert.equal(
    isAllowedDownloadOrigin("https://evil-githubusercontent.com/x", policy),
    false,
  );
  assert.equal(
    isAllowedDownloadOrigin(
      "https://githubusercontent.com.evil.test/x",
      policy,
    ),
    false,
  );
});

test("plain http never qualifies, whatever the host", () => {
  const policy = {
    origins: ["https://dl.dolphin-emu.org", "http://dl.dolphin-emu.org"],
    hostSuffixes: ["githubusercontent.com"],
  };
  assert.equal(
    isAllowedDownloadOrigin("http://dl.dolphin-emu.org/a.dmg", policy),
    false,
  );
  assert.equal(
    isAllowedDownloadOrigin("http://x.githubusercontent.com/a", policy),
    false,
  );
});

test("an unparseable or empty policy allows nothing", () => {
  assert.equal(
    isAllowedDownloadOrigin("not a url", { origins: ["https://x"] }),
    false,
  );
  assert.equal(isAllowedDownloadOrigin("https://x/", {}), false);
});

test("an installer filename that is not one plain name is refused", () => {
  // These names come out of a release index and are joined to a directory the
  // shell owns, then handed to the OS to open. Sanitising and running it anyway
  // would be the wrong answer, so the download refuses instead.
  for (const name of [
    "",
    ".",
    "..",
    "../evil.exe",
    "sub/dir.exe",
    "sub\\dir.exe",
    "evil\u0000.exe",
    " leading-space.exe",
    "trailing-dot.exe.",
    "CON.exe",
  ]) {
    assert.equal(isPlainFileName(name), false, JSON.stringify(name));
  }
});

test("the names these projects actually publish are accepted", () => {
  for (const name of [
    "RetroArch-Win64-setup.exe",
    "RetroArch_Metal.dmg",
    "pcsx2-v2.8.2-macos-Qt.tar.xz",
    "dolphin-2506a-x64.7z",
    "net.pcsx2.PCSX2.flatpak",
  ]) {
    assert.ok(isPlainFileName(name), name);
  }
});

test("assertSeparateRoots rejects a firmware mirror that overlaps either root", () => {
  // The mirror deletes whatever the server no longer lists, so a cache or a
  // save tree underneath it would be deleted for not being firmware -- and a
  // mirror under the cache would be evicted along with the game beside it.
  const collisions: [string, string, string][] = [
    ["/data/cache", "/data/saves", "/data/cache"],
    ["/data/cache", "/data/saves", "/data/cache/bios"],
    ["/data/cache", "/data/saves", "/data/saves/bios"],
    ["/data/cache", "/data/saves/inner", "/data/saves"],
    ["/data/bios/cache", "/data/saves", "/data/bios"],
  ];
  for (const [cache, saves, bios] of collisions) {
    assert.throws(
      () => assertSeparateRoots(roots(cache, saves, bios)),
      { code: "invalid-request" },
      `${bios} must not overlap ${cache} or ${saves}`,
    );
  }

  // And three separate directories are fine, as is a mirror that is not set.
  assertSeparateRoots(roots("/data/cache", "/data/saves", "/data/bios"));
  assertSeparateRoots(roots("/data/cache", "/data/saves", null));
});

test("assertSeparateRoots names both of the directories that collided", () => {
  // The message is the whole diagnosis: three roots means "they overlap" on
  // its own does not say which two.
  assert.throws(
    () =>
      assertSeparateRoots(
        roots("/data/cache", "/data/saves", "/data/cache/bios"),
      ),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /biosPath/);
      assert.match(message, /cachePath/);
      assert.doesNotMatch(message, /saveDataPath/);
      return true;
    },
  );
});

test("validatePlatformQuery accepts a platform and its cores", () => {
  assert.deepEqual(
    validatePlatformQuery({ platformSlug: "snes", cores: ["snes9x"] }),
    { platformSlug: "snes", cores: ["snes9x"] },
  );
});

test("validatePlatformQuery rejects a malformed query", () => {
  for (const query of [
    null,
    "snes",
    { cores: [] },
    { platformSlug: "", cores: [] },
    { platformSlug: "snes" },
    { platformSlug: "snes", cores: "snes9x" },
    { platformSlug: "snes", cores: [7] },
  ]) {
    assert.throws(() => validatePlatformQuery(query), {
      code: "invalid-request",
    });
  }
});

test("validatePlatformQueries validates every entry", () => {
  const queries = [
    { platformSlug: "snes", cores: ["snes9x"] },
    { platformSlug: "ps2", cores: [] },
  ];
  assert.deepEqual(validatePlatformQueries(queries), queries);
  assert.deepEqual(validatePlatformQueries([]), []);
});

test("validatePlatformQueries rejects a batch with one bad entry", () => {
  assert.throws(
    () =>
      validatePlatformQueries([
        { platformSlug: "snes", cores: ["snes9x"] },
        { platformSlug: 7, cores: [] },
      ]),
    { code: "invalid-request" },
  );
});

test("validatePlatformQueries rejects a batch with a hole in it", () => {
  // Array.prototype.map skips holes, so a sparse array once passed validation
  // and reached the launcher with an unvalidated undefined in it.
  const sparse = new Array(1);
  assert.throws(() => validatePlatformQueries(sparse), {
    code: "invalid-request",
  });
  const mixed = [{ platformSlug: "snes", cores: [] }];
  mixed.length = 2;
  assert.throws(() => validatePlatformQueries(mixed), {
    code: "invalid-request",
  });
});

test("validatePlatformQueries rejects a non-array and an oversized batch", () => {
  assert.throws(() => validatePlatformQueries({ platformSlug: "snes" }), {
    code: "invalid-request",
  });
  const tooMany = Array.from({ length: MAX_PLATFORM_QUERIES + 1 }, (_, i) => ({
    platformSlug: `p${i}`,
    cores: [],
  }));
  assert.throws(() => validatePlatformQueries(tooMany), {
    code: "invalid-request",
  });
});
