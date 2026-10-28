'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-srv-'));
process.env.VREKI_DATA_DIR = tmp;
const P = require('../app/paths');
const { start } = require('../app/server');

let base, srv;
test.before(async () => { srv = await start(0); base = `http://127.0.0.1:${srv.port}`; });
test.after(() => srv.close());

const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('status names the app', async () => {
  const r = await get('/api/status');
  assert.strictEqual(r.body.app, 'vreki-werewolf');
  assert.ok(r.body.version);
});

test('the Gemini key is saved to its file and never sent back', async () => {
  const KEY = 'test-key-' + 'abc123';
  const s = await post('/api/settings', { geminiKey: KEY, voice: 'gemini' });
  assert.strictEqual(s.body.geminiKeySet, true);
  assert.strictEqual(fs.readFileSync(P.GEMINI_KEY_FILE, 'utf8').trim(), KEY);
  const setup = await fetch(base + '/api/setup?refresh=1').then((r) => r.text());
  assert.ok(!setup.includes(KEY));
  assert.ok(!fs.readFileSync(P.SETTINGS_FILE, 'utf8').includes(KEY));
  const del = await post('/api/settings', { geminiKey: null });
  assert.strictEqual(del.body.geminiKeySet, false);
  assert.ok(!fs.existsSync(P.GEMINI_KEY_FILE));
});

test('a real game with no company picked is refused in Thai', async () => {
  await post('/api/settings', { providers: [] });
  const r = await post('/api/new', { providers: [] });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /เลือก/);
});

test('a mock game splits the seats between the picked companies', async () => {
  const r = await post('/api/new', { mock: true, force: true, providers: ['claude', 'codex'], showCompanies: true, mockDelay: 5 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.seats, { claude: 3, codex: 3 });
  await post('/api/abort', {});
});

test('Gemini voice without a key falls back to another voice mode', async () => {
  const r = await post('/api/new', { mock: true, mockVoice: true, force: true, providers: ['gemini'], voice: 'gemini', mockDelay: 5 });
  assert.strictEqual(r.status, 200);
  assert.notStrictEqual(r.body.voiceUsed, 'gemini');
  await post('/api/abort', {});
});

test('launch --selftest plays a whole test-mode game and exits 0', async () => {
  const env = { ...process.env, VREKI_PORT: String(srv.port + 20), VREKI_NO_BROWSER: '1', VREKI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ww-self-')) };
  const out = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'launch.js'), '--selftest'], { env });
    let s = '';
    ch.stdout.on('data', (d) => (s += d));
    const t = setTimeout(() => { ch.kill(); resolve({ code: 'timeout', s }); }, 150000);
    ch.on('exit', (code) => { clearTimeout(t); resolve({ code, s }); });
  });
  assert.strictEqual(out.code, 0, out.s);
  assert.match(out.s, /เช็คผ่าน/);
});

test('a second launch finds the running game instead of starting another server', async () => {
  const env = { ...process.env, VREKI_PORT: String(srv.port), VREKI_NO_BROWSER: '1' };
  const out = await new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'launch.js')], { env });
    let s = '';
    ch.stdout.on('data', (d) => (s += d));
    const t = setTimeout(() => { ch.kill(); resolve({ code: 'timeout', s }); }, 8000);
    ch.on('exit', (code) => { clearTimeout(t); resolve({ code, s }); });
  });
  assert.strictEqual(out.code, 0, out.s);
  assert.match(out.s, new RegExp(`localhost:${srv.port}`));
});
