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
    execFile(exe, args, { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (err, out) => resolve(err ? null : String(out)));
  });
}

const PKG = {
  claude: { rel: path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), runner: 'exe' },
  codex: { rel: path.join('node_modules', '@openai', 'codex', 'bin', 'codex.js'), runner: 'node' },
};
const LABEL = { claude: 'Claude Code', codex: 'Codex', python: 'Python', ffmpeg: 'ffmpeg' };

// → { ok, path, runner: 'exe'|'node' } or { ok: false, reason }
async function resolveTool(name, override, deps = {}) {
  const where = deps.where || whereExe;
  const home = deps.home || os.homedir();
  if (override) {
    if (!exists(override)) return { ok: false, reason: `ไม่เจอไฟล์ ${override}` };
    return { ok: true, path: override, runner: /\.js$/i.test(override) ? 'node' : 'exe' };
  }
  const lines = await where(name);
  const exe = lines.find((l) => /\.exe$/i.test(l) && exists(l));
  if (exe) return { ok: true, path: exe, runner: 'exe' };
  const pkg = PKG[name];
  if (pkg) {
    for (const dir of new Set(lines.map((l) => path.dirname(l)))) {
      const f = path.join(dir, pkg.rel);
      if (exists(f)) return { ok: true, path: f, runner: pkg.runner };
    }
    if (name === 'claude') {
      const local = path.join(home, '.local', 'bin', 'claude.exe');
      if (exists(local)) return { ok: true, path: local, runner: 'exe' };
    }
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

let cache = null;
async function detectAll(settings = {}, { refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < 30000) return cache.value;
  const paths = settings.paths || {};
  const [claude, codex, python, ffmpeg] = await Promise.all([
    resolveTool('claude', paths.claude), resolveTool('codex', paths.codex), resolvePython(paths.python), resolveTool('ffmpeg', paths.ffmpeg),
  ]);
  const keySet = exists(P.GEMINI_KEY_FILE) && fs.readFileSync(P.GEMINI_KEY_FILE, 'utf8').trim().length > 0;
  const value = {
    claude: { ready: claude.ok, path: claude.path || null, runner: claude.runner || null, reason: claude.ok ? null : explainError('claude', 'not found') },
    codex: { ready: codex.ok, path: codex.path || null, runner: codex.runner || null, reason: codex.ok ? null : explainError('codex', 'not found') },
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
  const e = String(error || '');
  const name = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }[provider] || provider;
  if (/^not found$|ENOENT|หาโปรแกรม/i.test(e)) return provider === 'gemini' ? 'ยังไม่มีคีย์ Gemini — ใส่คีย์ในหน้าตั้งค่า' : `ยังไม่ได้ติดตั้ง ${name} — ให้ AI ติดตั้งตาม INSTALL-FOR-AI.md`;
  if (provider === 'gemini' && /no key|no gemini key/i.test(e)) return 'ยังไม่มีคีย์ Gemini — ใส่คีย์ในหน้าตั้งค่า';
  if (provider === 'gemini' && /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|HTTP 40[13]/i.test(e)) return 'คีย์ Gemini ใช้ไม่ได้ — เช็คว่าก๊อปคีย์มาครบ แล้วบันทึกใหม่';
  if (/or newer is required|claude update|codex update|please upgrade|upgrade (the )?cli/i.test(e)) {
    return provider === 'codex' ? 'Codex เวอร์ชันเก่าเกินไปสำหรับรุ่นนี้ — เปิด terminal พิมพ์ npm install -g @openai/codex@latest แล้วลองใหม่'
      : 'Claude Code เวอร์ชันเก่าเกินไปสำหรับรุ่นนี้ — เปิด terminal พิมพ์ claude update แล้วลองใหม่';
  }
  if (/\b429\b|usage limit|rate limit|quota|exhausted|too many requests/i.test(e)) return `โควต้าเต็ม (${name}) — รอให้รีเซ็ต หรือเลือกค่ายอื่นไปก่อน`;
  if (/selected model|model\b.*\b(not supported|not exist|does not exist|not found|not available|access)|unknown model|invalid model/i.test(e)) return `แพ็กของคุณใช้รุ่น ${model || 'นี้'} ไม่ได้ — ลองเปลี่ยนรุ่นในหน้าตั้งค่า`;
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

module.exports = { resolveTool, resolvePython, detectAll, clearDetectCache, withTools, explainError, testProvider, LABEL };
