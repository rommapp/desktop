// Run after build with Electron. Synthetic HTTP fixtures exercise the actual
// paired transport, worker, cancellation polling, pins and launcher staging.
const { app } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, rm, readdir, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createPairedSession } = require('../dist/main/auth/paired-session.js');
const { runInstallCycle } = require('../dist/main/installs/service.js');
const { installedRoot, installedLaunch, readInstallation } = require('../dist/main/installs/store.js');
const { ensureRom } = require('../dist/main/rom-cache.js');
const { syncDiscSet } = require('../dist/main/discs/sync.js');
const { evictToLimit } = require('../dist/main/cache/evict.js');
(async () => {
  const root = await mkdtemp(join(tmpdir(), 'romm-installs-smoke-'));
  app.setPath('userData', root);
  await app.whenReady();
  setTimeout(() => { console.error('Install check timed out'); app.exit(1); }, 30_000).unref();
  const { loadConfig } = require('../dist/main/config.js');
  let jobs = [];
  let mode = 'normal';
  let claimCount = 0;
  let downloadCount = 0;
  let capability;
  let slowStarted;
  let acknowledge = true;
  const outcomes = [];
  const small = { id: 1, platform_slug: 'nes', files: [{ id: 10, file_name: 'game.nes', full_path: 'nes/game.nes', file_size_bytes: 4 }] };
  const large = { id: 2, platform_slug: 'nes', files: [{ id: 20, file_name: 'large.nes', full_path: 'nes/large.nes', file_size_bytes: 1_000_000 }] };
  const folder = { id: 3, platform_slug: 'ps3', files: [
    { id: 30, file_name: 'EBOOT.BIN', full_path: 'ps3/game/PS3_GAME/USRDIR/EBOOT.BIN', file_size_bytes: 4 },
    { id: 31, file_name: 'data.bin', full_path: 'ps3/game/PS3_GAME/USRDIR/sub/data.bin', file_size_bytes: 4 },
  ] };
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer rmm_install_fixture');
    assert.equal(req.headers.cookie, undefined);
    const body = async () => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : null; };
    const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/api/devices/device' && req.method === 'PUT') { capability = (await body()).capabilities.remote_install; json({}); return; }
    if (req.url === '/api/devices/device/installs/claim') { claimCount++; json(jobs); return; }
    if (req.url === '/api/devices/device/installs') {
      if (mode === 'offline') { json({}, 503); return; }
      json(jobs); return;
    }
    if (req.url.startsWith('/api/devices/device/installs/') && req.method === 'PUT') {
      const report = await body();
      if (!acknowledge) { res.destroy(); return; }
      outcomes.push(report.status);
      jobs = jobs.filter(job => !req.url.endsWith('/' + job.id));
      json({}); return;
    }
    if (req.url === '/api/roms/1') { json(small); return; }
    if (req.url === '/api/roms/2') { json(large); return; }
    if (req.url === '/api/roms/3') { json(folder); return; }
    if (req.url.includes('/content/')) {
      downloadCount++;
      if (req.url.includes('/roms/2/') && mode !== 'normal') {
        res.writeHead(200, { 'content-length': '1000000' }); res.write('data');
        slowStarted?.();
        const timer = setInterval(() => res.write(Buffer.alloc(4096)), 100);
        res.once('close', () => clearInterval(timer));
      } else {
        const data = req.url.includes('/roms/2/') ? Buffer.alloc(1_000_000) : Buffer.from('data');
        res.writeHead(200, { 'content-length': String(data.length) }); res.end(data);
      }
      return;
    }
    json({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = createPairedSession({ server: origin, userId: 7, tokenId: 1, token: 'rmm_install_fixture', deviceId: 'device', expiresAt: null });
  const config = { ...await loadConfig(), serverUrl: origin, cachePath: join(root, 'cache'), acceptRemoteInstalls: true };
  const installRoot = installedRoot(config, 7);
  const job = (id, rom = 1, fileIds = [10]) => ({ id, user_id: 7, device_id: 'device', rom_id: rom, file_ids: fileIds, status: 'taken' });
  const cycle = (signal = new AbortController().signal, stillCurrent) => runInstallCycle({ config, session, signal, stillCurrent });
  jobs = [job('first')];
  await cycle();
  assert.equal(capability, true);
  assert.deepEqual(outcomes, ['done']);
  assert.equal(downloadCount, 1);
  const ready = await installedLaunch(config, 7, 1, async () => small);
  assert.ok(ready);
  const cached = await ensureRom({ config: { ...config, cachePath: ready.cachePath }, session, romId: 1,
    fileName: 'game.nes', downloadPath: '/api/roms/1/content/game.nes', signal: new AbortController().signal, onProgress() {} });
  assert.equal(cached.fromCache, true);
  assert.equal(downloadCount, 1);
  jobs = [job('again')];
  await cycle();
  assert.equal(outcomes.at(-1), 'already_installed');
  assert.equal(downloadCount, 1);
  await evictToLimit(installRoot, 0, join(installRoot, 'other'));
  assert.ok(await readInstallation(join(installRoot, '1')));
  console.log('PASS: claim, authenticated download, completion, duplicate detection, launch cache hit and eviction pin');

  mode = 'slow'; jobs = [job('cancelled', 2, [20])];
  let started = new Promise(resolve => { slowStarted = resolve; });
  let running = cycle();
  await started; jobs = [];
  await running;
  assert.equal(await readInstallation(join(installRoot, '2')), null);
  assert.ok(!(await readdir(installRoot)).some(name => name.startsWith('.install-stage-')));
  assert.equal(outcomes.length, 2);
  console.log('PASS: remote cancellation aborts an active transfer and removes its staging tree');

  jobs = [job('interrupted', 2, [20])]; mode = 'slow';
  started = new Promise(resolve => { slowStarted = resolve; }); running = cycle();
  await started; mode = 'offline';
  await running;
  assert.equal(jobs.length, 1);
  assert.equal(await readInstallation(join(installRoot, '2')), null);
  mode = 'normal'; await cycle();
  assert.equal(outcomes.at(-1), 'done');
  assert.ok(await readInstallation(join(installRoot, '2')));
  console.log('PASS: uncertain contact pauses without a false outcome; a later claim recovers the request');

  await rm(join(installRoot, '2'), { recursive: true, force: true });
  jobs = [job('shutdown', 2, [20])]; mode = 'slow';
  const shutdown = new AbortController();
  started = new Promise(resolve => { slowStarted = resolve; }); running = cycle(shutdown.signal);
  await started; shutdown.abort(); await running;
  assert.equal(jobs.length, 1);
  assert.equal(await readInstallation(join(installRoot, '2')), null);
  assert.ok(!(await readdir(installRoot)).some(name => name.startsWith('.install-stage-')));
  mode = 'normal'; await cycle();
  assert.ok(await readInstallation(join(installRoot, '2')));
  console.log('PASS: shutdown aborts the transfer, cleans staging and leaves a recoverable claim');

  jobs = [job('folder', 3, [30, 31])]; acknowledge = false;
  await cycle();
  const count = downloadCount;
  acknowledge = true; await cycle();
  assert.equal(downloadCount, count);
  assert.equal(outcomes.at(-1), 'already_installed');
  const installed = await installedLaunch(config, 7, 3, async () => folder);
  assert.ok(installed);
  const boot = await syncDiscSet({ config: { ...config, cachePath: installed.cachePath, libraryPath: null }, session,
    romId: 3, signal: new AbortController().signal, playlist: false, platformSlug: 'ps3', metadata: installed.metadata });
  assert.equal(await readFile(boot, 'utf8'), 'data');
  assert.equal(downloadCount, count);
  console.log('PASS: lost acknowledgement does not redownload; nested installed games reuse the launcher staging path');

  const claims = claimCount;
  await runInstallCycle({ config: { ...config, acceptRemoteInstalls: false }, session, signal: new AbortController().signal });
  assert.equal(capability, false);
  assert.equal(claimCount, claims);
  await rm(root, { recursive: true, force: true });
  server.closeAllConnections(); server.close();
  console.log('PASS: disabling remote installs clears the capability and stops claiming');
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
