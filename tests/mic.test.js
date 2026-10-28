'use strict';
// Push-to-talk (speak instead of typing when you play) is optional: tested only with NVIDIA
// cards; any other card or no card = "no data, not recommended" (VreKi 2026-10-28).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.VREKI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-mic-'));
const { resolveStt } = require('../app/detect');
const { saveSettings, DEFAULTS } = require('../app/settings');

const py = { ok: true, path: process.execPath, edgeTts: true };
const where = (has) => async (n) => (n === 'nvidia-smi' && has ? ['C:\\Windows\\System32\\nvidia-smi.exe'] : []);
const probe = (fw, model) => async () => ({ fw, model });

test('no NVIDIA card: the mic is off and the reason says NVIDIA only', async () => {
  const r = await resolveStt({}, { where: where(false), python: py, probe: probe(true, true) });
  assert.strictEqual(r.ready, false);
  assert.match(r.reason, /NVIDIA/);
  assert.match(r.reason, /ไม่แนะนำ/);
});

test('NVIDIA but faster-whisper not installed', async () => {
  const r = await resolveStt({}, { where: where(true), python: py, probe: probe(false, false) });
  assert.strictEqual(r.ready, false);
  assert.match(r.reason, /ยังไม่ได้ติดตั้งตัวแปลงเสียง/);
});

test('installed but the model is not downloaded', async () => {
  const r = await resolveStt({}, { where: where(true), python: py, probe: probe(true, false) });
  assert.strictEqual(r.ready, false);
  assert.match(r.reason, /ยังไม่ได้โหลดโมเดล/);
});

test('everything there: ready, with the python that has faster-whisper', async () => {
  const r = await resolveStt({}, { where: where(true), python: py, probe: probe(true, true) });
  assert.deepStrictEqual({ ready: r.ready, python: r.python }, { ready: true, python: process.execPath });
});

test('the mic setting is off by default and saves', () => {
  assert.strictEqual(DEFAULTS.mic, false);
  assert.strictEqual(saveSettings({ mic: true }).mic, true);
  assert.strictEqual(saveSettings({ mic: 'yes' }).mic, true, 'a bad value keeps the saved one');
});

test('the server accepts a WAV only on the speech route', async () => {
  const { start } = require('../app/server');
  const srv = await start(0);
  const req = (p, type) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: p, headers: { Host: `localhost:${srv.port}`, 'Content-Type': type } },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.end('RIFFxxxx');
  });
  try {
    const stt = await req('/api/stt', 'audio/wav');
    assert.notStrictEqual(stt.status, 415);
    assert.notStrictEqual(stt.status, 403);
    const other = await req('/api/settings', 'audio/wav');
    assert.strictEqual(other.status, 415);
    const st = await fetch(`http://127.0.0.1:${srv.port}/api/stt/status`).then((r) => r.json());
    assert.strictEqual(st.state, 'disabled', 'no game with the mic on yet');
  } finally { srv.close(); }
});
