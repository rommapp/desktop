import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { testConfig } from "../../test/config.ts";
import { MAX_SCREENSHOT_BYTES, MAX_SCREENSHOTS, prepareScreenshots, pushScreenshots } from "./capture.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "romm-screenshots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = testConfig({ syncScreenshots: true, saveDataPath: root });
  const directory = await prepareScreenshots(config, 7, true);
  assert.ok(directory);
  return { root, config, directory };
}

test("only built-in RetroArch launches with screenshot sync prepare a directory", async (t) => {
  const { config } = await fixture(t);
  assert.equal(await prepareScreenshots(config, 7, false), null);
  assert.equal(await prepareScreenshots({ ...config, syncScreenshots: false }, 7, true), null);
  assert.equal(await prepareScreenshots({ ...config, serverUrl: null }, 7, true), null);
  assert.equal(await prepareScreenshots({ ...config, saveDataPath: null }, 7, true), null);
  assert.equal(await prepareScreenshots(config, -1, true), null);
  for (const char of ['"', '\n', '\r', '|']) {
    assert.equal(await prepareScreenshots({ ...config, saveDataPath: `/bad${char}path` }, 7, true), null);
  }
});

test("captures from separate runs stay separate and receive distinct upload names", async (t) => {
  const { config, directory } = await fixture(t);
  const next = await prepareScreenshots(config, 7, true);
  assert.ok(next);
  assert.notEqual(directory, next);
  await writeFile(join(directory, "unexpected-name.PNG"), "first");
  await writeFile(join(next, "unexpected-name.PNG"), "second");
  const sent: string[] = [];
  for (const dir of [directory, next]) {
    const result = await pushScreenshots({ directory: dir, signal: new AbortController().signal,
      upload: async ({ fileName, bytes }) => {
        sent.push(fileName);
        assert.equal(Buffer.from(bytes).toString(), dir === directory ? "first" : "second");
        return true;
      },
    });
    assert.deepEqual(result, { uploaded: 1, failed: 0 });
  }
  assert.notEqual(sent[0], sent[1]);
  assert.equal(await readFile(join(directory, "unexpected-name.PNG"), "utf8"), "first");
});

test("unrelated files, folders, symlinks, oversized and empty captures are not sent", async (t) => {
  const { directory, root } = await fixture(t);
  const outside = join(root, "private.png");
  await writeFile(outside, "private");
  await symlink(outside, join(directory, "linked.png"));
  await mkdir(join(directory, "folder.png"));
  await writeFile(join(directory, "state.state"), "state");
  await writeFile(join(directory, "empty.png"), "");
  await writeFile(join(directory, "huge.png"), "");
  await truncate(join(directory, "huge.png"), MAX_SCREENSHOT_BYTES + 1);
  await writeFile(join(directory, 'capture".bmp'), "image");
  const result = await pushScreenshots({ directory, signal: new AbortController().signal,
    upload: async ({ fileName }) => {
      assert.ok(fileName.endsWith(".bmp"));
      assert.doesNotMatch(fileName, /["\r\n]/);
      return true;
    },
  });
  assert.deepEqual(result, { uploaded: 1, failed: 2 });
});

test("failed uploads retain local captures and do not stop other uploads", async (t) => {
  const { directory } = await fixture(t);
  for (const name of ["a.png", "b.png", "c.png"]) await writeFile(join(directory, name), "image");
  let calls = 0;
  const result = await pushScreenshots({ directory, signal: new AbortController().signal,
    upload: async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return calls > 2;
    },
  });
  assert.deepEqual(result, { uploaded: 1, failed: 2 });
  for (const name of ["a.png", "b.png", "c.png"]) assert.equal(await readFile(join(directory, name), "utf8"), "image");
});

test("cancellation stops further delivery and preserves captures", async (t) => {
  const { directory } = await fixture(t);
  for (const name of ["a.png", "b.png"]) await writeFile(join(directory, name), "image");
  const controller = new AbortController();
  const result = await pushScreenshots({ directory, signal: controller.signal,
    upload: async () => { controller.abort(); return true; },
  });
  assert.deepEqual(result, { uploaded: 1, failed: 0 });
});

test("the directory scan is bounded and an already cancelled run sends nothing", async (t) => {
  const { directory } = await fixture(t);
  for (let index = 0; index <= MAX_SCREENSHOTS; index++) {
    await writeFile(join(directory, `${index}.png`), "image");
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const upload = async () => { calls++; return true; };
  assert.deepEqual(await pushScreenshots({ directory, signal: controller.signal, upload }), {
    uploaded: 0, failed: 0,
  });
  assert.equal(calls, 0);
  assert.deepEqual(await pushScreenshots({ directory, signal: new AbortController().signal, upload }), {
    uploaded: MAX_SCREENSHOTS, failed: 0,
  });
  assert.equal(calls, MAX_SCREENSHOTS);
});

test("an unavailable capture root is nonfatal during preparation", async (t) => {
  const { root, config } = await fixture(t);
  const file = join(root, "file");
  await writeFile(file, "not a directory");
  assert.equal(await prepareScreenshots({ ...config, saveDataPath: file }, 7, true), null);
});

test("long capture names retain extensions and distinct names across repeated delivery", async (t) => {
  const { directory } = await fixture(t);
  const stem = "Long game title ".repeat(12);
  const names = [`${stem}20261112-150001.PNG`, `${stem}20261112-150002.PNG`, `${stem}20261112-150003.BMP`];
  for (const name of names) await writeFile(join(directory, name), name);
  const attempts: Map<string, string>[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = new Map<string, string>();
    const result = await pushScreenshots({
      directory,
      signal: new AbortController().signal,
      upload: async ({ fileName, bytes }) => {
        const original = Buffer.from(bytes).toString();
        assert.ok(fileName.length <= 120);
        assert.match(fileName, /^[a-f0-9-]+\.(png|bmp)$/);
        assert.ok(fileName.endsWith(original.endsWith(".BMP") ? ".bmp" : ".png"));
        sent.set(original, fileName);
        return true;
      },
    });
    assert.deepEqual(result, { uploaded: 3, failed: 0 });
    assert.equal(new Set(sent.values()).size, 3);
    attempts.push(sent);
  }
  assert.deepEqual(attempts[0], attempts[1]);
});
