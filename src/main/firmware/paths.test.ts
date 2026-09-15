import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { resolveBiosPaths, retroarchSystemConfig } from "./paths.ts";

test("firmware lands in a directory per platform, named for the slug", () => {
  // Per platform rather than per game: the emulator is what has to find these,
  // and a core looking for scph5501.bin will not take <romId>/scph5501.bin.
  const paths = resolveBiosPaths("/data/bios", "psx");
  assert.equal(paths?.directory, join("/data/bios", "psx"));
});

test("the slug is matched without regard to case", () => {
  assert.equal(
    resolveBiosPaths("/data/bios", "PSX")?.directory,
    resolveBiosPaths("/data/bios", "psx")?.directory,
  );
});

test("a slug cannot become a path of its own", () => {
  // It arrives from the renderer and becomes a directory name, so traversal
  // has to be reduced to one component rather than normalised.
  for (const slug of ["../../etc", "..", "a/b", "c:\\windows", "\u0000x"]) {
    const paths = resolveBiosPaths("/data/bios", slug);
    assert.ok(paths);
    const relative = paths.directory.slice("/data/bios/".length);
    assert.doesNotMatch(relative, /[/\\]/, slug);
    assert.notEqual(relative, "..", slug);
  }
});

test("a generated config can never collide with a platform's directory", () => {
  // The configs live under a leading-dot directory, and safeFileName strips
  // leading dots from a slug, so no platform can be named into that path.
  const generated = resolveBiosPaths("/data/bios", "psx")!.appendConfig;
  assert.ok(generated.includes(".retroarch"));
  for (const slug of [".retroarch", "..retroarch", ".RetroArch"]) {
    const paths = resolveBiosPaths("/data/bios", slug)!;
    assert.notEqual(paths.directory, join("/data/bios", ".retroarch"), slug);
  }
});

test("the mirror is off when no bios root is set", () => {
  assert.equal(resolveBiosPaths(null, "psx"), null);
});

test("the generated config names the system directory RetroArch will read", () => {
  const written = retroarchSystemConfig("/data/bios/psx");
  assert.match(written ?? "", /^system_directory = "\/data\/bios\/psx"$/m);
});

test("a directory RetroArch's format cannot express is declined, not mangled", () => {
  // Its values are double-quoted with no escape for an inner quote, so a path
  // containing one would end the value early and leave the rest of the line to
  // be read as something else. "{bios}" still has the directory either way.
  assert.equal(retroarchSystemConfig('/data/bi"os'), null);
  assert.equal(
    retroarchSystemConfig("/data/bios\nsystem_directory = /evil"),
    null,
  );
  assert.equal(retroarchSystemConfig("/data/bios\r/psx"), null);
  assert.ok(retroarchSystemConfig("/data/bios/psx with spaces"));
});

test("a platform with no firmware still gets a config, setting nothing", () => {
  // This is what makes "{biosconfig}" safe to name on every platform: a row
  // that always passes --appendconfig passes a file that overrides nothing
  // where there is no firmware, rather than one that points RetroArch at an
  // empty directory and takes away the system_directory the user had set.
  const written = retroarchSystemConfig(null);
  assert.ok(written);
  assert.doesNotMatch(written, /^system_directory/m);
  for (const line of written.trimEnd().split("\n")) {
    assert.match(line, /^#/, line);
  }
});

test("the generated config says not to edit it", () => {
  // It is rewritten on every launch that syncs, so an edit would vanish.
  assert.match(retroarchSystemConfig("/data/bios/psx") ?? "", /^#/);
});
