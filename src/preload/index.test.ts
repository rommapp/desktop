import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/** The preload's own source, read as text: it cannot be imported here, since
 *  loading it needs electron. Resolved from the package root, which is where
 *  npm runs the test script from. */
function preloadSource(): string {
  return readFileSync(join(process.cwd(), "src/preload/index.ts"), "utf8");
}

const IMPORT = /^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm;

test("the preload imports nothing but types, which is what sandbox allows", () => {
  // A sandboxed preload's require() serves the electron module and a handful of
  // Node builtins. A relative path throws "module not found" and takes the
  // whole bridge with it, before window.rommNative is ever exposed -- and
  // nothing else catches it: the typecheck, the tests and the build are all
  // happy with a value import that cannot be resolved at runtime.
  const source = preloadSource();
  const imports = [...source.matchAll(IMPORT)];
  // A file whose imports stopped matching would pass vacuously.
  assert.ok(imports.length >= 2);
  for (const match of imports) {
    const clause = match[1] ?? "";
    const specifier = match[2];
    if (specifier === "electron") continue;
    const typeOnly =
      clause.startsWith("type ") ||
      clause
        .replace(/[{}]/g, "")
        .split(",")
        .every(
          (binding) =>
            binding.trim() === "" || binding.trim().startsWith("type "),
        );
    assert.ok(
      typeOnly,
      `import from "${specifier}" has to be type-only: ${clause.trim()}`,
    );
  }
});

test("the capability list is the preload's own, not imported", () => {
  // The values ship from here because a value import is what the test above
  // forbids, so the list has to be visible in this file.
  const source = preloadSource();
  assert.match(source, /satisfies Record<ShellCapability, true>/);
  assert.match(source, /"multi-disc": true/);
});
