// paths.js — every file location the game uses, relative to the folder it was
// unpacked into. Viewer data (settings, Gemini key, game logs) lives in data/,
// which git ignores. VREKI_DATA_DIR moves data/ elsewhere (tests use it).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const DATA = path.resolve(process.env.VREKI_DATA_DIR || path.join(ROOT, 'data'));

const P = {
  ROOT,
  APP,
  DATA,
  LOGS: path.join(DATA, 'logs'),
  SANDBOX: path.join(DATA, 'sandbox'),
  REPLAYS: path.join(ROOT, 'replays'),
  SETTINGS_FILE: path.join(DATA, 'settings.json'),
  GEMINI_KEY_FILE: path.join(DATA, 'gemini_key.txt'),
  TTS_USAGE_LOG: path.join(DATA, 'tts_usage.jsonl'),
};

P.ensureDataDirs = function ensureDataDirs() {
  for (const d of [P.DATA, P.LOGS, P.SANDBOX]) fs.mkdirSync(d, { recursive: true });
};

module.exports = P;
