// detect.js — finds the viewer's Claude Code, Codex, Python (+ edge-tts) and ffmpeg,
// checks the Gemini key file, and turns provider errors into Thai the viewer can act on.
// Never runs anything through cmd.exe: npm's .cmd shims are resolved to the real
// claude.exe / codex.js, because cmd would mangle the Thai multi-line prompts.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./paths');

const exists = (f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } };

function whereExe(name) {
  return new Promise((resolve) => {
    execFile('where.exe', [name], { windowsHide: true, timeout: 5000 }, (err, out) => {
      resolve(err ? [] : String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
}

function runPy(exe, args) {
  return new Promise((resolve) => {
    // utf-8 out: a Thai user name puts Python under a Thai path, which the ANSI code page cannot print
    execFile(exe, args, { windowsHide: true, timeout: 15000, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, out) => resolve(err ? null : String(out)));
  });
}

const PKG = {
  claude: { rel: path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), runner: 'exe' },
  codex: { rel: path.join('node_modules', '@openai', 'codex', 'bin', 'codex.js'), runner: 'node' },
};
const LABEL = { claude: 'Claude Code', codex: 'Codex', python: 'Python', ffmpeg: 'ffmpeg' };

// The Claude desktop app keeps its own Claude Code under
// %LOCALAPPDATA%\Claude-Data\<pkg>\claude-code\<version>\<hash>\claude.exe — newest version wins.
function newestDesktopClaude(localAppData) {
  const ls = (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } };
  const root = localAppData && path.join(localAppData, 'Claude-Data');
  const found = [];
  for (const pkg of ls(root)) {
    const cc = path.join(root, pkg, 'claude-code');
    for (const v of ls(cc).filter((x) => /^\d+\.\d+\.\d+$/.test(x))) {
      for (const h of ls(path.join(cc, v))) {
        const f = path.join(cc, v, h, 'claude.exe');
        if (exists(f)) found.push({ v: v.split('.').map(Number), f });
      }
    }
  }
  found.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return found[0]?.f || null;
}

// → { ok, path, runner: 'exe'|'node' } or { ok: false, reason }
async function resolveTool(name, override, deps = {}) {
  const where = deps.where || whereExe;
  const home = deps.home || os.homedir();
  if (override) {
    if (/^[\\/]{2}/.test(override)) return { ok: false, reason: 'ไม่ใช้โปรแกรมจากเครื่องอื่นในเครือข่าย' };
    if (!exists(override)) return { ok: false, reason: `ไม่เจอไฟล์ ${override}` };
    return { ok: true, path: override, runner: /\.js$/i.test(override) ? 'node' : 'exe' };
  }
  const lines = await where(name);
  const pkg = PKG[name];
  // PATH order, like a terminal: the first entry that is an .exe, or an npm shim whose package is there
  for (const l of lines) {
    if (/\.exe$/i.test(l) && exists(l)) return { ok: true, path: l, runner: 'exe' };
    const f = pkg && path.join(path.dirname(l), pkg.rel);
    if (f && exists(f)) return { ok: true, path: f, runner: pkg.runner };
  }
  if (name === 'claude') {
    const local = path.join(home, '.local', 'bin', 'claude.exe');
    if (exists(local)) return { ok: true, path: local, runner: 'exe' };
    const desktop = newestDesktopClaude(deps.localAppData || process.env.LOCALAPPDATA);
    if (desktop) return { ok: true, path: desktop, runner: 'exe' };
  }
  return { ok: false, reason: lines.length ? `เจอ ${name} แต่เป็นตัวเรียกแบบ .cmd ที่ใช้ตรงๆ ไม่ได้` : `หาโปรแกรม ${name} ไม่เจอ` };
}

// Python 3.10+ that can import edge_tts (falls back to any 3.10+ so the setup page can say what is missing)
async function resolvePython(override) {
  const probe = 'import sys,importlib.util;print(sys.executable);print(sys.version_info>=(3,10));print(bool(importlib.util.find_spec("edge_tts")))';
  const cands = override ? [[override]] : [['py', '-3'], ...(await whereExe('python')).map((p) => [p])];
  let fallback = null;
  for (const [exe, ...pre] of cands) {
    const out = await runPy(exe, [...pre, '-c', probe]);
    if (!out) continue;
    const [real, okVer, hasEdge] = out.trim().split(/\r?\n/);
    if (okVer !== 'True') continue;
    // tts.py also loads edge-tts from a pylib/ folder next to app/ (for PCs where pip is not an option)
    const r = { ok: true, path: real, runner: 'exe', edgeTts: hasEdge === 'True' || fs.existsSync(path.join(P.ROOT, 'pylib', 'edge_tts')) };
    if (r.edgeTts) return r;
    fallback = fallback || r;
  }
  return fallback || { ok: false, edgeTts: false, reason: 'หา Python 3.10 ขึ้นไปไม่เจอ' };
}

// login status without spending quota: `claude auth status --json` / `codex login status`
// → true / false, or null when this CLI cannot tell (then the game does not block it)
function parseLogin(name, code, out) {
  const s = String(out || '');
  if (name === 'claude') {
    const m = s.match(/"loggedIn"\s*:\s*(true|false)/);
    return m ? m[1] === 'true' : null;
  }
  if (/not logged in|no credentials|please (log|sign) ?in/i.test(s)) return false;
  if (code === 0 && /logged in/i.test(s)) return true;
  return null;
}
function versionTooOld(out, min) {
  const m = String(out || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const a = m.slice(1).map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
function runTool(tool, args) {
  const [cmd, pre] = tool.runner === 'node' ? [process.execPath, [tool.path]] : [tool.path, []];
  return new Promise((resolve) => {
    execFile(cmd, [...pre, ...args], { windowsHide: true, timeout: 10000, encoding: 'utf8' }, (err, out, errOut) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${out || ''}${errOut || ''}` });
    });
  });
}
const MIN_CLAUDE = '2.1.280'; // first Claude Code that runs claude-opus-5-5

// adds login / version facts to a found CLI: { ready, reason, warn }
async function checkCli(name, tool) {
  if (!tool.ok) return { ready: false, reason: `${explainError(name, 'not found')}${tool.reason ? ` (${tool.reason})` : ''}` };
  const st = await runTool(tool, name === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']);
  if (parseLogin(name, st.code, st.out) === false) return { ready: false, reason: explainError(name, 'not logged in') };
  if (name === 'claude') {
    const v = await runTool(tool, ['--version']);
    if (versionTooOld(v.out, MIN_CLAUDE)) return { ready: true, reason: null, warn: explainError('claude', 'or newer is required') };
  }
  return { ready: true, reason: null, warn: null };
}

let cache = null;
async function detectAll(settings = {}, { refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < 30000) return cache.value;
  const paths = settings.paths || {};
  const [claude, codex, python, ffmpeg] = await Promise.all([
    resolveTool('claude', paths.claude), resolveTool('codex', paths.codex), resolvePython(paths.python), resolveTool('ffmpeg', paths.ffmpeg),
  ]);
  const keySet = exists(P.GEMINI_KEY_FILE) && fs.readFileSync(P.GEMINI_KEY_FILE, 'utf8').trim().length > 0;
  const [cl, cx] = await Promise.all([checkCli('claude', claude), checkCli('codex', codex)]);
  const value = {
    claude: { ...cl, path: claude.path || null, runner: claude.runner || null },
    codex: { ...cx, path: codex.path || null, runner: codex.runner || null },
    gemini: { ready: keySet, reason: keySet ? null : explainError('gemini', 'no key file') },
    python: { ready: python.ok, path: python.path || null, edgeTts: !!python.edgeTts, reason: python.ok ? (python.edgeTts ? null : 'ยังไม่ได้ติดตั้ง edge-tts (pip install -r requirements.txt)') : python.reason },
    ffmpeg: { ready: ffmpeg.ok, path: ffmpeg.path || null },
  };
  cache = { at: Date.now(), value };
  return value;
}
function clearDetectCache() { cache = null; }

// a copy of the game config with the found programs filled in
function withTools(config, det) {
  const out = JSON.parse(JSON.stringify(config));
  for (const id of ['claude', 'codex']) if (out.providers[id] && det[id]?.ready) { out.providers[id].exe = det[id].path; out.providers[id].runner = det[id].runner; }
  return out;
}

// provider error → one Thai sentence the viewer can act on
function explainError(provider, error, model) {
  const e = String(error || '').trim();
  const name = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }[provider] || provider;
  if (/^not found$|ENOENT|หาโปรแกรม/i.test(e)) return provider === 'gemini' ? 'ยังไม่มีคีย์ Gemini — ใส่คีย์ในหน้าตั้งค่า' : `ยังไม่ได้ติดตั้ง ${name} — ให้ AI ติดตั้งตาม INSTALL-FOR-AI.md`;
  if (provider === 'gemini' && /no key|no gemini key/i.test(e)) return 'ยังไม่มีคีย์ Gemini — ใส่คีย์ในหน้าตั้งค่า';
  if (provider === 'gemini' && /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|HTTP 40[13]/i.test(e)) return 'คีย์ Gemini ใช้ไม่ได้ — เช็คว่าก๊อปคีย์มาครบ แล้วบันทึกใหม่';
  if (provider === 'gemini' && /limit:\s*0\b/i.test(e)) return 'คีย์ฟรีของ Gemini ใช้รุ่นนี้ไม่ได้ — เปลี่ยนรุ่นเป็นตระกูล Flash ในหน้าตั้งค่า (เช่น gemini-3.8-flash)';
  if (/or newer is required|claude update|codex update|please upgrade|upgrade (the )?cli|unexpected argument|unknown option|unrecognized (option|argument)/i.test(e)) {
    return provider === 'codex' ? 'Codex เวอร์ชันเก่าเกินไปสำหรับรุ่นนี้ — เปิด terminal พิมพ์ npm install -g @openai/codex@latest แล้วลองใหม่'
      : 'Claude Code เวอร์ชันเก่าเกินไปสำหรับรุ่นนี้ — เปิด terminal พิมพ์ claude update แล้วลองใหม่';
  }
  if (/\b429\b|usage limit|rate limit|quota|exhausted|too many requests|hit your .{0,20}limit|session limit|weekly limit/i.test(e)) return `โควต้าเต็ม (${name}) — รอให้รีเซ็ต หรือเลือกค่ายอื่นไปก่อน`;
  if (/selected model|models?\b.*\b(not supported|not exist|does not exist|not found|not available|access)|unknown model|invalid model/i.test(e)) return `แพ็กของคุณใช้รุ่น ${model || 'นี้'} ไม่ได้ — ลองเปลี่ยนรุ่นในหน้าตั้งค่า`;
  if (/\/login|not logged in|log ?in|\b401\b|unauthori[sz]ed|oauth|invalid api key|authenticat/i.test(e)) {
    return provider === 'codex' ? 'ยังไม่ได้ล็อกอิน Codex — เปิด terminal พิมพ์ codex login แล้วล็อกอินด้วยบัญชี ChatGPT'
      : 'ยังไม่ได้ล็อกอิน Claude Code — เปิด terminal พิมพ์ claude แล้วล็อกอินด้วยแพ็กของคุณ';
  }
  if (/timeout|timed out/i.test(e)) return `${name} ตอบช้าเกินไป — ลองใหม่อีกครั้ง`;
  return `ผิดพลาด: ${e.replace(/\s+/g, ' ').slice(0, 120)}`;
}

// one short real call to see that a company works (costs one message of the viewer's quota)
async function testProvider(id, config, det) {
  const { callProvider } = require('./providers');
  const cfg = withTools(config, det);
  const pc = cfg.providers[id];
  if (!pc) return { ok: false, ms: 0, message: `ไม่รู้จักค่าย ${id}` };
  if (pc.effort) pc.effort = 'low'; // a quick yes/no; a longer prompt made Codex think for ~90 s (2026-10-28)
  if ((id === 'claude' || id === 'codex') && !pc.exe) return { ok: false, ms: 0, message: explainError(id, 'not found') };
  P.ensureDataDirs();
  const r = await callProvider(id, pc, { sandboxDir: P.SANDBOX, timeoutMs: 90000, providers: cfg.providers }, {
    kind: 'target', names: ['ป้าแจ่ม'],
    system: 'ตอบเป็น JSON',
    prompt: 'เลือกชื่อนี้: ป้าแจ่ม',
  });
  if (r.ok) return { ok: true, ms: r.ms, message: `เชื่อมต่อได้ · ${pc.modelLabel || pc.model} ตอบใน ${Math.round((r.ms || 0) / 100) / 10} วิ` };
  return { ok: false, ms: r.ms || 0, message: explainError(id, `${r.error || ''} ${r.stderr || ''} ${r.text || ''}`, pc.model), raw: String(r.error || '').slice(0, 300) };
}

module.exports = { parseLogin, versionTooOld, checkCli, resolveTool, resolvePython, detectAll, clearDetectCache, withTools, explainError, testProvider, LABEL };
