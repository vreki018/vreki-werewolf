// settings.js — what the viewer picked in the lobby (companies, models, voice,
// show-companies switch). Saved in data/settings.json. The Gemini key is never
// stored here: it has its own file (paths.GEMINI_KEY_FILE).
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const COMPANIES = ['claude', 'codex', 'gemini'];
const VOICES = ['off', 'free', 'gemini'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

const DEFAULTS = Object.freeze({
  providers: [],
  models: { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol', gemini: 'gemini-4-argon' },
  effort: { claude: 'medium', codex: 'medium' },
  voice: 'free',
  showCompanies: false,
  paths: { claude: null, codex: null, python: null, ffmpeg: null },
});

// 6 seats shared as evenly as possible between the picked companies (6 · 3+3 · 2+2+2)
function seatSplit(providers, seats = 6) {
  const ids = [...new Set(providers || [])];
  if (!ids.length) throw new Error('pick at least one company');
  for (const id of ids) if (!COMPANIES.includes(id)) throw new Error(`unknown company ${id}`);
  const out = {};
  ids.forEach((id, i) => { out[id] = Math.floor(seats / ids.length) + (i < seats % ids.length ? 1 : 0); });
  return out;
}

const str = (v, max = 80) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

// keeps only known, well-formed values; everything else falls back to DEFAULTS
function clean(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (Array.isArray(r.providers)) s.providers = [...new Set(r.providers.filter((p) => COMPANIES.includes(p)))];
  // first character a letter/digit: a name like "--flag" would be read as a CLI option
  for (const id of COMPANIES) { const m = str(r.models?.[id]); if (m && /^[A-Za-z0-9][\w.\-:]*$/.test(m)) s.models[id] = m; }
  for (const id of Object.keys(s.effort)) if (EFFORTS.includes(r.effort?.[id])) s.effort[id] = r.effort[id];
  if (VOICES.includes(r.voice)) s.voice = r.voice;
  if (typeof r.showCompanies === 'boolean') s.showCompanies = r.showCompanies;
  for (const k of Object.keys(s.paths)) { const v = str(r.paths?.[k], 400); s.paths[k] = v; }
  return s;
}

function loadSettings() {
  try { return clean(JSON.parse(fs.readFileSync(P.SETTINGS_FILE, 'utf8'))); } catch (_) { return clean({}); }
}

function saveSettings(patch) {
  const cur = loadSettings();
  const p = patch || {};
  const next = clean({
    ...cur,
    ...('providers' in p ? { providers: p.providers } : {}),
    models: { ...cur.models, ...(p.models || {}) },
    effort: { ...cur.effort, ...(p.effort || {}) },
    ...('voice' in p ? { voice: p.voice } : {}),
    ...('showCompanies' in p ? { showCompanies: p.showCompanies } : {}),
    paths: { ...cur.paths, ...(p.paths || {}) },
  });
  fs.mkdirSync(path.dirname(P.SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(P.SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

// a copy of the game config with the viewer's models and effort filled in
function applyModels(config, settings) {
  const out = JSON.parse(JSON.stringify(config));
  for (const id of COMPANIES) {
    const pc = out.providers[id];
    if (!pc) continue;
    const m = settings.models?.[id];
    if (m && m !== pc.model) { pc.model = m; pc.modelLabel = m; }
    if (settings.effort?.[id]) pc.effort = settings.effort[id];
  }
  return out;
}

module.exports = { COMPANIES, VOICES, DEFAULTS, seatSplit, loadSettings, saveSettings, applyModels };
