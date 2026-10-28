'use strict';
// The game listens on localhost. Other web pages open in the same browser must not be
// able to drive it (reviewer finding 2026-10-28: a cross-site text/plain POST could save
// a program path that the game later runs, drain quota, or shut the game down).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.VREKI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-sec-'));
const P = require('../app/paths');
const { start } = require('../app/server');

let srv;
test.before(async () => { srv = await start(0); });
test.after(() => srv.close());

// raw request so we can set Host / Origin / Content-Type freely
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    if (body) r.write(body);
    r.end();
  });
}
const own = () => ({ Host: `localhost:${srv.port}` });

test('a request with a foreign Host header is refused (DNS rebinding)', async () => {
  const r = await req('GET', '/api/status', { headers: { Host: 'evil.example:80' } });
  assert.strictEqual(r.status, 403);
});

test('a cross-site POST is refused', async () => {
  const r = await req('POST', '/api/shutdown', { headers: { ...own(), Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: '{}' });
  assert.strictEqual(r.status, 403);
});

test('a POST that is not JSON is refused (would skip the browser CORS check)', async () => {
  const r = await req('POST', '/api/settings', { headers: { ...own(), 'Content-Type': 'text/plain' }, body: '{"voice":"off"}' });
  assert.strictEqual(r.status, 415);
});

test('program paths cannot be set over HTTP', async () => {
  const r = await req('POST', '/api/settings', { headers: { ...own(), Origin: `http://localhost:${srv.port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: { python: '\\\\host\\share\\x.exe', claude: 'C:\\x\\claude.exe' } }) });
  assert.strictEqual(r.status, 200);
  const saved = JSON.parse(fs.readFileSync(P.SETTINGS_FILE, 'utf8'));
  assert.strictEqual(saved.paths.python, null);
  assert.strictEqual(saved.paths.claude, null);
});

test('the page itself (same host, JSON) still works', async () => {
  const r = await req('POST', '/api/settings', { headers: { ...own(), Origin: `http://localhost:${srv.port}`, 'Content-Type': 'application/json' }, body: '{"voice":"off"}' });
  assert.strictEqual(r.status, 200);
  const g = await req('GET', '/api/status', { headers: { Host: `127.0.0.1:${srv.port}` } });
  assert.strictEqual(g.status, 200);
});

test('a network-share override path is never used', async () => {
  const { resolveTool } = require('../app/detect');
  const r = await resolveTool('claude', '\\\\host\\share\\claude.exe', { where: () => [], home: os.tmpdir() });
  assert.strictEqual(r.ok, false);
});
