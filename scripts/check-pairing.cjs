// Run after build with Electron, optionally --ozone-platform=headless.
// Local HTTP fixtures verify both native transports with synthetic credentials.
const { app, session, net, BrowserWindow, dialog } = require('electron');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createPairedSession } = require('../dist/main/auth/paired-session.js');
(async () => {
  const root = await mkdtemp(join(tmpdir(), 'romm-pairing-smoke-'));
  app.setPath('userData', root);
  await app.whenReady();
  const deadline = setTimeout(() => { console.error('Pairing runtime check timed out'); app.exit(1); }, 30_000);
  deadline.unref();
  app.setName('RomM pairing runtime check');
  app.on('window-all-closed', () => {});
  let foreignHits = 0;
  const foreign = http.createServer((_req, res) => { foreignHits++; res.end('bad'); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  let loginHits = 0;
  let inspectDone = Promise.resolve();
  let inspected = false;
  let tokenRevoked = false;
  let browserAccount = 7;
  const ingested = [];
  let reportStall;
  const stallArrived = new Promise(resolve => { reportStall = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/stall') { reportStall(); return; }
    if (tokenRevoked && req.headers.authorization) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'revoked' })); return;
    }
    if (req.url === '/api/play-sessions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      ingested.push({ userId: req.headers.authorization ? 7 : browserAccount, body: JSON.parse(body) });
      res.writeHead(201, { 'content-type': 'application/json' }); res.end('{}'); return;
    }
    if (req.url === '/api/auth/device/init') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ device_code: 'a'.repeat(64), user_code: 'ABCDEFGH', expires_in: 60, interval: 1 }));
      return;
    }
    if (req.url === '/api/auth/device/token') {
      await inspectDone;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 2, device_id: 'device', access_token: 'rmm_smoke_fixture', expires_at: null }));
      return;
    }
    if (req.url === '/api/users/me') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: req.headers.authorization ? 7 : browserAccount })); return;
    }
    if (req.url === '/api/devices/device') { res.end('{}'); return; }
    if (req.url === '/api/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${foreign.address().port}/api/echo` }); res.end(); }
    else if (req.url === '/api/login-redirect') { res.writeHead(302, { Location: '/login' }); res.end(); }
    else if (req.url === '/login') { loginHits++; res.end('login'); }
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.headers)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const record = { server: origin, userId: 7, tokenId: 2, token: 'rmm_smoke_fixture', deviceId: 'device', expiresAt: null };
  const target = createPairedSession(record);
  await target.cookies.set({ url: origin, name: 'romm_session', value: 'wrong-account' });
  const headers = await (await target.fetch(origin + '/api/echo', { credentials: 'include' })).json();
  assert.equal(headers.authorization, 'Bearer rmm_smoke_fixture');
  assert.equal(headers.cookie, undefined);
  await session.defaultSession.cookies.set({ url: origin, name: 'romm_session', value: 'browser-account' });
  const browser = await (await session.defaultSession.fetch(origin + '/api/echo', { credentials: 'include' })).json();
  assert.equal(browser.authorization, undefined);
  assert.equal(browser.cookie, 'romm_session=browser-account');
  await assert.rejects(target.fetch(origin + '/api/redirect'));
  await assert.rejects(target.fetch(origin + '/api/login-redirect'));
  assert.equal(foreignHits, 0);
  assert.equal(loginHits, 0);
  await new Promise((resolve, reject) => {
    const request = net.request({ url: origin + '/api/echo', session: target, useSessionCookies: true });
    request.on('error', reject);
    request.on('response', response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { const h = JSON.parse(body); assert.equal(h.authorization, 'Bearer rmm_smoke_fixture'); assert.equal(h.cookie, undefined); resolve(); }
        catch(error) { reject(error); }
      });
    });
    request.end();
  });
  console.log('PASS: session.fetch and net.request bearer isolation, cookie stripping, browser separation, redirect confinement');
  // Exercise the actual local pairing window and protocol against fixtures.
  // Only the OS encryption boundary is substituted, using authenticated AES.
  const paired = require('../dist/main/auth/paired-session.js');
  const store = require('../dist/main/auth/pairing-store.js');
  const key = randomBytes(32);
  const codec = {
    encrypt(value) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decrypt(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  paired.secretCodec = () => codec;
  const messages = [];
  dialog.showMessageBox = async (_parent, options) => { messages.push(options.message); return { response: 0 }; };
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-finish-load', () => {
      if (!contents.getURL().startsWith('data:text/html')) return;
      inspectDone = (async () => {
        const text = await contents.executeJavaScript('document.body.innerText');
        assert.ok(text.includes('ABCDEFGH'));
        assert.equal(text.includes('rmm_smoke_fixture'), false);
        assert.equal(text.includes('a'.repeat(64)), false);
        inspected = true;
      })();
      inspectDone.catch(error => { console.error(error); app.exit(1); });
    });
  });
  const parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await parent.loadURL(origin);
  // A's revoked token must not reload B's still-valid browsing session or
  // allow B's next flush to adopt A's waiting activity.
  const { loadConfig, playQueuePath } = require('../dist/main/config.js');
  const queue = require('../dist/main/play/queue.js');
  const { reportPlaySessions } = require('../dist/main/play/report.js');
  const config = { ...await loadConfig(), serverUrl: origin, deviceId: 'cookie-device', trackPlaySessions: true,
    useRommFirmware: true, biosPath: join(root, 'bios') };
  const now = Date.now();
  const playRecord = (romId, userId) => ({ romId, userId, serverUrl: origin, saveSlot: null,
    startTime: new Date(now - 60_000).toISOString(), endTime: new Date(now).toISOString(), durationMs: 60_000 });
  await queue.enqueue(playQueuePath(), playRecord(1, 7));
  tokenRevoked = true;
  browserAccount = 8;
  await reportPlaySessions({ config, session: target, signal: new AbortController().signal });
  assert.equal(ingested.length, 0);
  await queue.enqueue(playQueuePath(), playRecord(2, 8));
  await reportPlaySessions({ config, session: session.defaultSession, signal: new AbortController().signal });
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].userId, 8);
  assert.equal(ingested[0].body.sessions[0].rom_id, 2);
  assert.equal((await queue.readQueue(playQueuePath()))[0].userId, 7);
  const navigations = [];
  parent.webContents.on('did-start-navigation', (_event, url) => navigations.push(url));
  const { syncDiscSet } = require('../dist/main/discs/sync.js');
  const { syncPlatformFirmware } = require('../dist/main/firmware/sync.js');
  const signal = new AbortController().signal;
  await syncDiscSet({ config, session: target, romId: 1, signal, playlist: true, platformSlug: 'psx' });
  await syncPlatformFirmware({ config, session: target, platformSlug: 'psx', signal });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(navigations, []);
  tokenRevoked = false;
  await reportPlaySessions({ config, session: target, signal });
  assert.equal(ingested[1].userId, 7);
  assert.equal(ingested[1].body.sessions[0].rom_id, 1);
  assert.deepEqual(await queue.readQueue(playQueuePath()), []);
  browserAccount = 7;
  console.log('PASS: revoked-token metadata requests do not reload browser; play records remain bound to their owners');
  const { pairDesktop } = require('../dist/main/auth/pair-window.js');
  await pairDesktop(parent, origin);
  await inspectDone;
  assert.ok(inspected);
  assert.ok(messages.includes('Desktop paired.'));
  const saved = await store.readPairing(paired.pairingRoot(), origin, codec);
  assert.equal(saved.userId, 7);
  assert.equal(saved.deviceId, 'device');
  assert.equal((await readFile(store.pairingFile(paired.pairingRoot(), origin))).includes('rmm_smoke_fixture'), false);
  // Local removal must complete while the remote navigation is still stalled.
  void parent.loadURL(origin + '/stall').catch(() => {});
  await stallArrived;
  await pairDesktop(parent, origin, true);
  assert.equal(await store.readPairing(paired.pairingRoot(), origin, codec), null);
  assert.ok(messages.includes('Local pairing removed.'));
  console.log('PASS: local unpairing completes independently of a stalled remote page');
  parent.destroy();
  await rm(root, { recursive: true, force: true });
  console.log('PASS: local pairing window, public-code-only renderer, approval exchange, account lookup, encrypted persistence (fixture codec)');
  server.close(); foreign.close(); app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
