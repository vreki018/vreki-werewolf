'use strict';
// make-shortcut.ps1 must work when the game folder, the desktop and the link name are Thai
// (WScript.Shell alone fails on an en-US system locale — reviewer 2026-10-28).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('the desktop shortcut is made in Thai-named folders', { skip: process.platform !== 'win32', timeout: 60000 }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-lnk-'));
  const game = path.join(base, 'เกม หมาป่า');
  const desk = path.join(base, 'เดสก์ท็อป');
  fs.mkdirSync(path.join(game, 'scripts'), { recursive: true });
  fs.mkdirSync(desk);
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'make-shortcut.ps1'), path.join(game, 'scripts', 'make-shortcut.ps1'));
  fs.writeFileSync(path.join(game, 'start.bat'), '@echo off\r\n');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(game, 'scripts', 'make-shortcut.ps1'), '-Desktop', desk], { encoding: 'utf8' });
  const lnk = path.join(desk, 'หมู่บ้านหมาป่า.lnk');
  assert.ok(fs.existsSync(lnk), fs.readdirSync(desk).join(', '));
  const target = execFileSync('powershell', ['-NoProfile', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $s=New-Object -ComObject Shell.Application; $l=$s.Namespace('${desk}').ParseName('หมู่บ้านหมาป่า.lnk').GetLink; $l.Path`], { encoding: 'utf8' }).trim();
  assert.strictEqual(target.toLowerCase(), path.join(game, 'start.bat').toLowerCase());
});
