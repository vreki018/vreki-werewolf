'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Game } = require('../app/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-eng-'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'config.default.json'), 'utf8'));
cfg.logsDir = tmp;
cfg.sandboxDir = tmp;

const count = (g) => g.players.reduce((m, p) => ((m[p.provider] = (m[p.provider] || 0) + 1), m), {});

test('seatsPerProvider from the game options overrides the config', () => {
  const g = new Game(cfg, { seatsPerProvider: { codex: 3, gemini: 3 } });
  assert.deepStrictEqual(count(g), { codex: 3, gemini: 3 });
});

test('the human replaces the picked character: 5 AI + 1 human', () => {
  const g = new Game(cfg, { seatsPerProvider: { claude: 6 }, humanChar: 'fah' });
  assert.deepStrictEqual(count(g), { claude: 5, human: 1 });
  assert.strictEqual(g.players[g.humanSeat].id, 'fah');
});

function gameInit(opts) {
  const evs = [];
  const g = new Game(cfg, { ...opts, mock: true, onEvent: (e) => evs.push(e) });
  g.emit('game_init', g.gameInitData());
  return evs.find((e) => e.type === 'game_init');
}

test('game_init carries the companies only when showCompanies is on', () => {
  const on = gameInit({ seatsPerProvider: { claude: 3, codex: 3 }, showCompanies: true });
  assert.strictEqual(on.showCompanies, true);
  for (const s of on.seats) assert.ok(s.label && s.companyColor && s.provider, JSON.stringify(s));
  const off = gameInit({ seatsPerProvider: { claude: 3, codex: 3 } });
  assert.strictEqual(off.showCompanies, false);
  for (const s of off.seats) assert.strictEqual(s.label, undefined);
});

test('mock games show the company the seat would have had', () => {
  const ev = gameInit({ seatsPerProvider: { gemini: 6 }, showCompanies: true });
  for (const s of ev.seats) assert.strictEqual(s.label, 'Gemini');
});
