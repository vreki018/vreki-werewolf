'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-set-'));
process.env.VREKI_DATA_DIR = tmp;
const P = require('../app/paths');
const { seatSplit, loadSettings, saveSettings, applyModels, DEFAULTS } = require('../app/settings');

test('seatSplit: one company takes all 6 seats', () => {
  for (const id of ['claude', 'codex', 'gemini']) assert.deepStrictEqual(seatSplit([id]), { [id]: 6 });
});

test('seatSplit: any two companies split 3 + 3', () => {
  for (const pair of [['claude', 'codex'], ['claude', 'gemini'], ['codex', 'gemini']]) {
    const s = seatSplit(pair);
    assert.strictEqual(s[pair[0]], 3);
    assert.strictEqual(s[pair[1]], 3);
    assert.strictEqual(Object.keys(s).length, 2);
  }
});

test('seatSplit: all three companies split 2 + 2 + 2, order does not matter', () => {
  assert.deepStrictEqual(seatSplit(['gemini', 'claude', 'codex']), { gemini: 2, claude: 2, codex: 2 });
});

test('seatSplit: duplicates count once', () => {
  assert.deepStrictEqual(seatSplit(['claude', 'claude']), { claude: 6 });
});

test('seatSplit: empty or unknown company throws', () => {
  assert.throws(() => seatSplit([]));
  assert.throws(() => seatSplit(['agy']));
});

test('settings round-trip and never store the Gemini key', () => {
  const s = saveSettings({ providers: ['claude', 'gemini'], voice: 'gemini', showCompanies: true, models: { codex: 'gpt-6.1-luna' }, geminiKey: 'should-not-be-saved' });
  assert.deepStrictEqual(s.providers, ['claude', 'gemini']);
  assert.strictEqual(s.models.codex, 'gpt-6.1-luna');
  assert.strictEqual(s.models.claude, DEFAULTS.models.claude);
  const again = loadSettings();
  assert.deepStrictEqual(again, s);
  assert.ok(!fs.readFileSync(P.SETTINGS_FILE, 'utf8').includes('should-not-be-saved'));
});

test('invalid values fall back to defaults', () => {
  fs.writeFileSync(P.SETTINGS_FILE, JSON.stringify({ providers: ['agy', 'codex'], voice: 'loud', showCompanies: 'yes', effort: { claude: 'ultra' } }));
  const s = loadSettings();
  assert.deepStrictEqual(s.providers, ['codex']);
  assert.strictEqual(s.voice, DEFAULTS.voice);
  assert.strictEqual(s.showCompanies, false);
  assert.strictEqual(s.effort.claude, DEFAULTS.effort.claude);
});

test('a corrupt settings file gives the defaults', () => {
  fs.writeFileSync(P.SETTINGS_FILE, '{not json');
  assert.deepStrictEqual(loadSettings(), DEFAULTS);
});

test('applyModels copies models and effort into the provider config', () => {
  const cfg = { providers: { claude: { model: 'claude-opus-5-5', modelLabel: 'Opus 5.5' }, codex: { model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol' }, gemini: { model: 'gemini-4-argon', modelLabel: '4 Argon' } } };
  const out = applyModels(cfg, { ...DEFAULTS, models: { ...DEFAULTS.models, gemini: 'gemini-3.8-flash' }, effort: { claude: 'high', codex: 'low' } });
  assert.strictEqual(out.providers.gemini.model, 'gemini-3.8-flash');
  assert.strictEqual(out.providers.gemini.modelLabel, 'gemini-3.8-flash');
  assert.strictEqual(out.providers.claude.modelLabel, 'Opus 5.5');
  assert.strictEqual(out.providers.claude.effort, 'high');
  assert.strictEqual(out.providers.codex.effort, 'low');
  assert.strictEqual(cfg.providers.gemini.model, 'gemini-4-argon', 'input config is not changed');
});
