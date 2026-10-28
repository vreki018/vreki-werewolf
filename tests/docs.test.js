'use strict';
// README / INSTALL-FOR-AI are part of the giveaway: a viewer's AI installs the game from
// INSTALL-FOR-AI.md, so its steps must name the real commands and keep the key out of the chat.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('INSTALL-FOR-AI names the real install, shortcut and self-test commands', () => {
  const g = read('INSTALL-FOR-AI.md');
  for (const s of ['node -v', 'requirements.txt', 'scripts\\make-shortcut.ps1', 'node app/launch.js --selftest', 'data/gemini_key.txt', 'Thai']) {
    assert.ok(g.includes(s), `missing ${s}`);
  }
  for (const f of ['requirements.txt', 'scripts/make-shortcut.ps1', 'app/launch.js', 'start.bat']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('INSTALL-FOR-AI keeps the Gemini key out of the chat and never starts the game itself', () => {
  const g = read('INSTALL-FOR-AI.md');
  assert.ok(g.includes('Never ask for it and never accept it here'));
  assert.ok(g.includes('ตั้งค่า AI และเสียง'));
  assert.ok(!/write it (only )?to `data\/gemini_key\.txt`/.test(g), 'the AI must not write the key from the chat');
  assert.ok(!/pastes? a key, write/i.test(g));
  assert.ok(!/มีคีย์ Gemini API ไหม/.test(g), 'the AI must not ask for the key');
  assert.ok(g.includes('Do not start `start.bat` or the server yourself'));
  assert.ok(!/want you to start the game/.test(g));
});

test('README says the key stays on this PC and is typed into the game, not the chat', () => {
  const r = read('README.md');
  assert.ok(r.includes('ไม่ถูกส่งไปไหนนอกจาก Google'));
  assert.ok(r.includes('อ่าน INSTALL-FOR-AI.md แล้วติดตั้งเกมนี้ให้หน่อย'));
});

// episode numbers are internal: viewers never see one (the repo is public, so comments count too)
test('no episode number in any repo file', () => {
  const bad = new RegExp(String.raw`\b` + 'ep' + String.raw`\s*0*\d+\b`, 'i'); // in pieces, so this file does not match itself
  let files;
  try {
    files = require('child_process').execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch (_) { // a copy without git (the release ZIP): every file but the viewer's own data
    const SKIP = new Set(['.git', 'data', 'node_modules', '__pycache__']);
    const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? (SKIP.has(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    files = walk('.');
  }
  assert.ok(files.length > 20);
  const hits = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue; // deleted in the working tree, not yet committed
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) continue; // binary (mp3 bytes can spell anything)
    buf.toString('utf8').split(/\r?\n/).forEach((l, i) => { if (bad.test(l)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepStrictEqual(hits, []);
});
