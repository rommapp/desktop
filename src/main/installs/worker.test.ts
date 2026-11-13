import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { testConfig } from "../../test/config.ts";
import { processInstall, type InstallTransport, type InstallOutcome, type Liveness } from "./worker.ts";
import { installedLaunch, installedCache, installedRoot, readInstallation, INSTALL_MANIFEST, sweepInstallStages } from "./store.ts";
import { installFiles, readClaims, type InstallRequest } from "./plan.ts";

const server = "https://romm.test";
const request: InstallRequest = { id: "job-1", user_id: 7, device_id: "device-7", rom_id: 1, file_ids: [10], status: "taken" };
const metadata = { id: 1, platform_slug: "nes", files: [
  { id: 10, file_name: "game.nes", full_path: "nes/game.nes", file_size_bytes: 4 },
] };
async function fixture(t: TestContext) {
  const cachePath = await mkdtemp(join(tmpdir(), "romm-install-test-"));
  t.after(() => rm(cachePath, { recursive: true, force: true }));
  const config = testConfig({ serverUrl: server, cachePath });
  const root = installedRoot(config, 7);
  const reports: { status: InstallOutcome; reason: string | null }[] = [];
  const downloads: string[] = [];
  const controller = new AbortController();
  let liveness: Liveness = "taken";
  const transport: InstallTransport = {
    metadata: async () => metadata,
    download: async (_rom, file, destination, signal, progress) => {
      signal.throwIfAborted();
      downloads.push(file.path);
      await writeFile(destination, "data");
      progress(4, 4);
    },
    live: async () => liveness,
    report: async (_request, status, reason) => { reports.push({ status, reason }); },
  };
  return { cachePath, config, root, reports, downloads, controller, transport,
    live: (next: Liveness) => { liveness = next; },
    run: () => processInstall({ request, root, server, signal: controller.signal, transport }),
  };
}

test("an install publishes complete files and a pin, then reuses them on retry", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(), "done");
  const directory = join(f.root, "1");
  assert.equal(await readFile(join(directory, "game.nes"), "utf8"), "data");
  assert.equal((await readInstallation(directory))?.requestId, request.id);
  assert.equal(await installedCache(f.config, 7, 1), f.root);
  assert.equal(await installedCache(f.config, 8, 1), null);
  assert.equal(await installedCache({ ...f.config, serverUrl: "https://other.test" }, 7, 1), null);
  assert.equal(await f.run(), "already_installed");
  assert.deepEqual(f.downloads, ["game.nes"]);
  assert.deepEqual(f.reports.map((row) => row.status), ["done", "already_installed"]);
});

test("a lost completion acknowledgement retries without downloading again", async (t) => {
  const f = await fixture(t);
  let offline = true;
  f.transport.report = async (_request, status) => {
    if (offline) throw new Error("offline");
    f.reports.push({ status, reason: null });
  };
  assert.equal(await f.run(), "deferred");
  offline = false;
  assert.equal(await f.run(), "already_installed");
  assert.equal(f.downloads.length, 1);
  assert.equal(f.reports[0]?.status, "already_installed");
});

test("short transfers never publish a partial game", async (t) => {
  const f = await fixture(t);
  f.transport.download = async (_rom, _file, destination) => { await writeFile(destination, "x"); };
  assert.equal(await f.run(), "failed");
  assert.match(f.reports[0]?.reason ?? "", /Incomplete download/);
  assert.equal(await readInstallation(join(f.root, "1")), null);
  assert.deepEqual(await readdir(f.root), []);
});

test("cancellation or uncertain contact leaves the claim recoverable with no partial pin", async (t) => {
  for (const status of ["cancelled", "unknown"] as const) {
    const f = await fixture(t);
    f.live(status);
    assert.equal(await f.run(), "deferred");
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.reports, []);
  }
  const f = await fixture(t);
  f.transport.download = async (_rom, _file, destination) => {
    await writeFile(destination, "data");
    f.controller.abort();
  };
  assert.equal(await f.run(), "deferred");
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(f.reports, []);
});

test("an existing different installation is preserved rather than overwritten", async (t) => {
  const f = await fixture(t);
  await f.run();
  f.transport.metadata = async () => ({ ...metadata, files: [{ ...metadata.files[0]!, file_name: "changed.nes" }] });
  assert.equal(await f.run(), "failed");
  assert.match(f.reports.at(-1)?.reason ?? "", /existing installation differs/);
  assert.equal(await readFile(join(f.root, "1", "game.nes"), "utf8"), "data");
});

test("changed files and untrusted claim identities are refused", () => {
  assert.deepEqual(readClaims([request], 7, "device-7"), [request]);
  for (const patch of [{ user_id: 8 }, { device_id: "other" }, { file_ids: [10, 10] }, { rom_id: -1 }, { id: "../escape" }]) {
    assert.throws(() => readClaims([{ ...request, ...patch }], 7, "device-7"));
  }
  assert.throws(() => installFiles(metadata, { ...request, file_ids: [20] }), /changed/);
  assert.throws(() => installFiles({ ...metadata, files: [{ ...metadata.files[0]!, file_name: "../escape.nes" }] }, request));
});

test("folder plans preserve nested paths and duplicate basenames", () => {
  const files = ["PS3_GAME/USRDIR/EBOOT.BIN", "PS3_GAME/USRDIR/a/data.bin", "PS3_GAME/USRDIR/b/data.bin"].map((path, index) => ({
    id: index + 1, file_name: path.split("/").at(-1), full_path: `ps3/game/${path}`, file_size_bytes: 4,
  }));
  const planned = installFiles({ id: 1, platform_slug: "ps3", files }, { ...request, file_ids: [1, 2, 3] });
  assert.deepEqual(planned.map((file) => file.path), ["PS3_GAME/USRDIR/EBOOT.BIN", "PS3_GAME/USRDIR/a/data.bin", "PS3_GAME/USRDIR/b/data.bin"]);
});

test("restart cleanup removes only reserved stage trees, and symlinked installations are rejected", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".install-stage-orphan"), { recursive: true });
  await mkdir(join(f.root, "user-files"));
  await sweepInstallStages(f.root);
  assert.deepEqual(await readdir(f.root), ["user-files"]);
  await f.run();
  await rm(join(f.root, "1", "game.nes"));
  await symlink(join(f.cachePath, "outside"), join(f.root, "1", "game.nes"));
  assert.equal(await readInstallation(join(f.root, "1")), null);
  assert.ok(await readFile(join(f.root, "1", INSTALL_MANIFEST)));
});

test("launches reuse the installed snapshot only while current metadata agrees", async (t) => {
  const f = await fixture(t);
  await f.run();
  const ready = await installedLaunch(f.config, 7, 1, async () => metadata);
  assert.equal(ready?.cachePath, f.root);
  const changed = { ...metadata, files: [{ ...metadata.files[0]!, file_size_bytes: 10 }] };
  assert.equal(await installedLaunch(f.config, 7, 1, async () => changed), null);
  assert.equal(await installedLaunch(f.config, 7, 1, async () => null), null);
  assert.equal(await readFile(join(f.root, "1", "game.nes"), "utf8"), "data");
});

test("same-size server revisions cannot be reported as already installed", async (t) => {
  const f = await fixture(t);
  await f.run();
  const revised = { ...metadata, files: [{ ...metadata.files[0]!, sha1_hash: "a".repeat(40) }] };
  assert.equal(await installedLaunch(f.config, 7, 1, async () => revised), null);
  f.transport.metadata = async () => revised;
  assert.equal(await f.run(), "failed");
  assert.match(f.reports.at(-1)?.reason ?? "", /existing installation differs/);
  assert.equal(await readFile(join(f.root, "1", "game.nes"), "utf8"), "data");
});
