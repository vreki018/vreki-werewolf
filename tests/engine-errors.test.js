'use strict';
// A viewer who is logged out / out of quota must see why the AIs are silent, in Thai,
// in every view — and the game must stop instead of playing on with empty turns.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game } = require('../app/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-err-'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'config.default.json'), 'utf8'));
cfg.logsDir = tmp;
cfg.sandboxDir = tmp;
// no exe → every Claude call fails at once with "not found"

test('a company that keeps failing is explained to everyone and the game stops', async () => {
  const evs = [];
  const g = new Game(cfg, { seatsPerProvider: { claude: 6 }, onEvent: (e) => evs.push(e) });
  await g.run();
  const warn = evs.filter((e) => e.type === 'ai_error');
  assert.ok(warn.length >= 1, 'at least one warning');
  assert.strictEqual(warn[0].vis, 'all');
  assert.match(warn[0].text, /ยังไม่ได้ติดตั้ง Claude Code/);
  assert.strictEqual(new Set(warn.map((w) => w.text)).size, warn.length, 'the same message is not repeated');
  const over = evs.find((e) => e.type === 'game_over');
  assert.strictEqual(over.winner, 'aborted');
  assert.match(over.text, /หยุดเกม.*Claude Code/);
});

test('summary.json says the Claude dollar figure is not money paid', async () => {
  const g = new Game(cfg, { seatsPerProvider: { claude: 6 } });
  await g.run();
  assert.match(g.summary.costNote.claude, /ไม่ใช่เงินที่จ่ายจริง/);
  assert.match(fs.readFileSync(path.join(g.dir, 'transcript.md'), 'utf8'), /ไม่ใช่เงินที่จ่ายจริง/);
});
