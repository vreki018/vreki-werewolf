'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-paths-'));
process.env.VREKI_DATA_DIR = path.join(tmp, 'data');
const P = require('../app/paths');

test('every path is absolute and data paths follow VREKI_DATA_DIR', () => {
  for (const k of ['ROOT', 'APP', 'DATA', 'LOGS', 'SANDBOX', 'REPLAYS', 'SETTINGS_FILE', 'GEMINI_KEY_FILE', 'TTS_USAGE_LOG']) {
    assert.ok(path.isAbsolute(P[k]), `${k} = ${P[k]}`);
  }
  assert.strictEqual(P.DATA, path.join(tmp, 'data'));
  assert.ok(P.LOGS.startsWith(P.DATA) && P.SANDBOX.startsWith(P.DATA) && P.SETTINGS_FILE.startsWith(P.DATA));
  assert.strictEqual(P.REPLAYS, path.join(P.ROOT, 'replays'));
  assert.strictEqual(P.APP, path.join(P.ROOT, 'app'));
});

test('ensureDataDirs creates logs and sandbox', () => {
  P.ensureDataDirs();
  assert.ok(fs.statSync(P.LOGS).isDirectory());
  assert.ok(fs.statSync(P.SANDBOX).isDirectory());
});
