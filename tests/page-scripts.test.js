'use strict';
// every script the page loads must at least parse (a syntax error in ptt.js once hid the mic button)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'app', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

test('index.html loads the page scripts', () => {
  assert.deepStrictEqual(scripts, ['avatars.js', 'app.js', 'ptt.js', 'setup.js']);
});

for (const s of scripts) {
  test(`${s} parses`, () => {
    assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(PUB, s), 'utf8')));
  });
}
