import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DesktopConfig } from "../../shared/types.ts";
import { mergeCemuKeys, parseCemuKeys, supplyCemuFirmware } from "./cemu.ts";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
// What Cemu writes the first time it finds no keys.txt.
const TEMPLATE =
  "# this file contains keys needed for decryption of disc file system data (WUD/WUX)\r\n" +
  "# 1 key per line, any text after a '#' character is considered a comment\r\n" +
  "# the emulator will automatically pick the right key\r\n" +
  "541b9889519b27d363cd21604b97c67a # example key (can be deleted)\r\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "romm-cemu-keys-"));
  const user = join(root, "Cemu");
  const mirrorDir = join(root, "mirror");
  mkdirSync(user);
  mkdirSync(mirrorDir);
  const config = {
    useRommFirmware: true,
    standaloneDataPaths: { cemu: user },
  } as unknown as DesktopConfig;
  const mirror = { directory: mirrorDir, count: 1 };
  const supply = () =>
    supplyCemuFirmware({ config, mirror, command: "/usr/bin/Cemu", args: [] });
  return { root, user, mirrorDir, config, supply };
}

test("keys are read the way Cemu reads them", () => {
  assert.deepEqual(
    parseCemuKeys(
      `${TEMPLATE}0123-4567-89AB-CDEF_0123 4567 89ab cdef ; note\nnot a key\nabcd\n`,
    ),
    ["541b9889519b27d363cd21604b97c67a", KEY_A],
  );
});

test("only missing keys are appended, in the file's own line endings", () => {
  const merged = mergeCemuKeys(TEMPLATE, `${KEY_A}\n${KEY_B.toUpperCase()}\n${KEY_A}\n`);
  assert.equal(
    merged,
    `${TEMPLATE}# Added by RomM Desktop from the keys.txt in RomM\r\n${KEY_A}\r\n${KEY_B}\r\n`,
  );
  assert.equal(mergeCemuKeys(merged, KEY_A), null);
});

test("a file without a trailing newline gets one before the appended keys", () => {
  assert.equal(
    mergeCemuKeys(KEY_A, KEY_B),
    `${KEY_A}\n# Added by RomM Desktop from the keys.txt in RomM\n${KEY_B}\n`,
  );
});

test("adds RomM's keys to Cemu's template keys.txt", async () => {
  const f = fixture();
  writeFileSync(join(f.user, "keys.txt"), TEMPLATE);
  writeFileSync(join(f.mirrorDir, "Keys.TXT"), `${KEY_A}\n`);
  assert.equal(await f.supply(), 1);
  const text = readFileSync(join(f.user, "keys.txt"), "utf8");
  assert.ok(text.startsWith(TEMPLATE));
  assert.ok(text.includes(KEY_A));
  assert.equal(await f.supply(), 0, "a second launch adds nothing");
});

test("creates keys.txt when Cemu has not written one yet", async () => {
  const f = fixture();
  writeFileSync(join(f.mirrorDir, "keys.txt"), `${KEY_A}\n`);
  assert.equal(await f.supply(), 1);
  assert.deepEqual(parseCemuKeys(readFileSync(join(f.user, "keys.txt"), "utf8")), [KEY_A]);
});

test("copies console files of the right size, and never over the user's", async () => {
  const f = fixture();
  writeFileSync(join(f.mirrorDir, "otp.bin"), Buffer.alloc(1024, 1));
  writeFileSync(join(f.mirrorDir, "SEEPROM.bin"), Buffer.alloc(100));
  assert.equal(await f.supply(), 1);
  assert.equal(readFileSync(join(f.user, "otp.bin")).length, 1024);
  assert.equal(existsSync(join(f.user, "seeprom.bin")), false);

  writeFileSync(join(f.user, "otp.bin"), Buffer.alloc(1024, 2));
  assert.equal(await f.supply(), 0);
  assert.equal(readFileSync(join(f.user, "otp.bin"))[0], 2);
});

test("does nothing with mirroring off or before Cemu has run", async () => {
  const f = fixture();
  writeFileSync(join(f.mirrorDir, "keys.txt"), `${KEY_A}\n`);
  f.config.useRommFirmware = false;
  assert.equal(await f.supply(), 0);
  f.config.useRommFirmware = true;
  const missing = join(f.root, "not-initialized");
  f.config.standaloneDataPaths.cemu = missing;
  assert.equal(await f.supply(), 0);
  assert.equal(existsSync(missing), false);
});
