'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveTool } = require('../app/detect');

function shimDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-npm-'));
  const touch = (rel) => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };
  return { d, touch };
}
const whereOf = (map) => (name) => map[name] || [];

test('claude installed with npm: the .cmd shim resolves to the bundled claude.exe', async () => {
  const { d, touch } = shimDir();
  touch('claude.cmd');
  const exe = touch('node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  const r = await resolveTool('claude', null, { where: whereOf({ claude: [path.join(d, 'claude'), path.join(d, 'claude.cmd')] }), home: d });
  assert.deepStrictEqual(r, { ok: true, path: exe, runner: 'exe' });
});

test('claude from the native installer (.exe on PATH) is used as is', async () => {
  const { d, touch } = shimDir();
  const exe = touch('claude.exe');
  const r = await resolveTool('claude', null, { where: whereOf({ claude: [exe] }), home: d });
  assert.deepStrictEqual(r, { ok: true, path: exe, runner: 'exe' });
});

test('claude not on PATH but in ~/.local/bin', async () => {
  const { d, touch } = shimDir();
  const exe = touch('.local/bin/claude.exe');
  const r = await resolveTool('claude', null, { where: whereOf({}), home: d });
  assert.deepStrictEqual(r, { ok: true, path: exe, runner: 'exe' });
});

test('codex installed with npm resolves to codex.js run by node', async () => {
  const { d, touch } = shimDir();
  touch('codex.cmd');
  const js = touch('node_modules/@openai/codex/bin/codex.js');
  const r = await resolveTool('codex', null, { where: whereOf({ codex: [path.join(d, 'codex.cmd')] }), home: d });
  assert.deepStrictEqual(r, { ok: true, path: js, runner: 'node' });
});

test('an override path wins; a missing override is reported', async () => {
  const { d, touch } = shimDir();
  const exe = touch('custom/claude.exe');
  assert.deepStrictEqual(await resolveTool('claude', exe, { where: whereOf({}), home: d }), { ok: true, path: exe, runner: 'exe' });
  const bad = await resolveTool('claude', path.join(d, 'nope.exe'), { where: whereOf({}), home: d });
  assert.strictEqual(bad.ok, false);
});

test('a shim without its package is not found (never run through cmd.exe)', async () => {
  const { d, touch } = shimDir();
  touch('codex.cmd');
  const r = await resolveTool('codex', null, { where: whereOf({ codex: [path.join(d, 'codex.cmd')] }), home: d });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason);
});
