// providers.js — one caller per AI company. Every caller returns
// { ok, text, json, ms, usage, meta, raw, error } and never throws.
'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./paths');

const SCHEMA_DIR = path.join(__dirname, 'schemas');

// ---------- process helper ----------
function run(cmd, args, { input, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || cleanEnv(), windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e), ms: 0, timedOut: false });
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => err.push(Buffer.from(String(e))));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Date.now() - t0,
        timedOut,
      });
    });
    if (input != null) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  else try { process.kill(pid, 'SIGKILL'); } catch (_) {}
}

// Children must not think they run inside a Claude Code session.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(k) || k === 'CLAUDECODE') delete env[k];
  }
  return env;
}

// ---------- JSON helpers ----------
function extractJson(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  const chunk = text.slice(s, e + 1);
  try { return JSON.parse(chunk); } catch (_) {}
  // several objects back to back: take the first balanced one
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i <= e; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch (_) { return null; } } }
  }
  return null;
}

function schemaFor(kind) {
  const p = { aside: { type: 'string' } };
  const req = ['aside'];
  if (kind === 'speak') { p.say = { type: 'string' }; p.suspect = { type: 'string' }; req.push('say', 'suspect'); }
  if (kind === 'last') { p.say = { type: 'string' }; req.push('say'); }
  if (kind === 'wolf') { p.whisper = { type: 'string' }; p.target = { type: 'string' }; req.push('whisper', 'target'); }
  if (kind === 'target') { p.target = { type: 'string' }; req.push('target'); }
  return { type: 'object', properties: p, required: req, additionalProperties: false };
}

function schemaNoAside(kind) {
  const s = schemaFor(kind);
  delete s.properties.aside;
  s.required = s.required.filter((k) => k !== 'aside');
  return s;
}

function schemaFile(kind) {
  if (!fs.existsSync(SCHEMA_DIR)) fs.mkdirSync(SCHEMA_DIR, { recursive: true });
  const f = path.join(SCHEMA_DIR, `${kind}.json`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(schemaFor(kind)));
  return f;
}

// ---------- Claude (claude -p) ----------
// cfg.exe = claude.exe found by detect.js (never a .cmd shim: cmd.exe would mangle the Thai prompt)
// Opus 5.5 safeguards sometimes refuse ("[reasoning_extraction]") when asked for the
// character's inner aside. Retry once without the aside field.
async function callClaude(cfg, app, req) {
  const r = await callClaudeOnce(cfg, app, req, true);
  if (r.ok || !/safeguards flagged/i.test(r.error || '')) return r;
  const prompt = req.prompt.replace(/"aside":"[^"]*",\s*/g, '').split(/\r?\n/).filter((l) => !l.startsWith('บทพูดในใจ')).join('\n');
  const r2 = await callClaudeOnce(cfg, app, { ...req, prompt }, false);
  r2.meta = { ...(r2.meta || {}), retriedWithoutAside: true, firstError: 'safeguards' };
  r2.ms = (r2.ms || 0) + (r.ms || 0);
  return r2;
}

async function callClaudeOnce(cfg, app, { system, prompt, kind }, withAside) {
  const args = [
    '-p', '--model', cfg.model,
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(withAside ? schemaFor(kind) : schemaNoAside(kind)),
  ];
  if (cfg.effort) args.push('--effort', cfg.effort);
  const exe = cfg.exe;
  if (!exe) return { ok: false, ms: 0, error: 'not found' };
  const r = await run(exe, args, { input: prompt, cwd: app.sandboxDir, timeoutMs: app.timeoutMs });
  const res = { ms: r.ms, raw: r.stdout.slice(0, 20000), stderr: r.stderr.slice(0, 4000), exe };
  let j = null;
  try { j = JSON.parse(r.stdout); } catch (_) {}
  if (!j) return { ...res, ok: false, error: r.timedOut ? 'timeout' : `no json (exit ${r.code})` };
  if (j.is_error) return { ...res, ok: false, error: String(j.result || 'is_error').slice(0, 300) };
  const json = j.structured_output || extractJson(j.result);
  return {
    ...res,
    ok: !!json,
    error: json ? null : 'unparsable',
    text: j.result,
    json,
    usage: {
      input: (j.usage?.input_tokens || 0),
      cacheRead: j.usage?.cache_read_input_tokens || 0,
      cacheWrite: j.usage?.cache_creation_input_tokens || 0,
      output: j.usage?.output_tokens || 0,
      costUsd: j.total_cost_usd || 0,
      apiMs: j.duration_api_ms || 0,
    },
  };
}

// ---------- GPT (codex exec) ----------
async function callCodex(cfg, app, { system, prompt, kind }) {
  if (!cfg.exe) return { ok: false, ms: 0, error: 'not found' };
  const args = [
    ...(cfg.runner === 'exe' ? [] : [cfg.exe]), 'exec',
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '-m', cfg.model,
    '-c', `model_reasoning_effort=${cfg.effort || 'medium'}`,
    '-s', 'read-only',
    '-C', app.sandboxDir,
    '--json',
    '--output-schema', schemaFile(kind),
    '-',
  ];
  const r = await run(cfg.runner === 'exe' ? cfg.exe : process.execPath, args, { input: `${system}\n\n${prompt}`, cwd: app.sandboxDir, timeoutMs: app.timeoutMs });
  const res = { ms: r.ms, raw: r.stdout.slice(0, 20000), stderr: r.stderr.slice(0, 4000) };
  let text = null, usage = null, threadId = null, errMsg = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
    if (ev.type === 'thread.started') threadId = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text;
    if (ev.type === 'turn.completed') usage = ev.usage;
    if (ev.type === 'error' || ev.type === 'turn.failed') errMsg = JSON.stringify(ev).slice(0, 300);
  }
  const json = extractJson(text);
  const rl = threadId ? codexRateLimits(threadId) : null;
  return {
    ...res,
    ok: !!json,
    error: json ? null : (r.timedOut ? 'timeout' : (errMsg || `no answer (exit ${r.code})`)),
    text,
    json,
    usage: usage ? {
      input: usage.input_tokens || 0,
      cacheRead: usage.cached_input_tokens || 0,
      output: usage.output_tokens || 0,
      reasoning: usage.reasoning_output_tokens || 0,
    } : null,
    meta: { threadId, rateLimits: rl },
  };
}

// Codex writes the plan's rate-limit percentages into the session file.
function codexRateLimits(threadId) {
  try {
    const root = path.join(os.homedir(), '.codex', 'sessions');
    const d = new Date();
    const days = [0, 1].map((back) => {
      const x = new Date(d.getTime() - back * 86400000);
      return path.join(root, String(x.getFullYear()), String(x.getMonth() + 1).padStart(2, '0'), String(x.getDate()).padStart(2, '0'));
    });
    for (const dir of days) {
      if (!fs.existsSync(dir)) continue;
      const f = fs.readdirSync(dir).find((n) => n.includes(threadId));
      if (!f) continue;
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      const lines = txt.trim().split(/\r?\n/).reverse();
      for (const line of lines) {
        if (!line.includes('"rate_limits"')) continue;
        const ev = JSON.parse(line);
        const rl = ev.payload?.rate_limits || ev.rate_limits || ev.payload?.info?.rate_limits;
        if (rl) return { primary: rl.primary?.used_percent, primaryWindowMin: rl.primary?.window_minutes, secondary: rl.secondary?.used_percent, secondaryWindowMin: rl.secondary?.window_minutes };
      }
    }
  } catch (_) {}
  return null;
}

// ---------- Gemini prompt softening ----------
// Google refuses some prompts outright because of ordinary game words in the chat
// history (จับ, เล็ง, ตาย …). The check is flaky, so the API call steps down:
// as is → softer words + only the latest history lines.
const SOFT_WORDS = [
  [/ตายแล้ว/g, 'แย่แล้ว'], [/ฆ่า/g, 'เลือก'], [/ศพ/g, 'คนที่ออก'], [/ตาย/g, 'ออก'], [/กัด/g, 'เลือก'],
  [/จับ/g, 'เลือก'], [/เล็ง/g, 'สงสัย'], [/ฟันธง/g, 'ตัดสิน'], [/ฟัน/g, 'ตัด'], [/เหยื่อ/g, 'คนที่ถูกเลือก'],
  [/เลือด/g, ''], [/แทง/g, 'ชี้'], [/ยิง/g, 'ชี้'], [/เชือด/g, 'เลือก'], [/สังหาร/g, 'เลือก'], [/ขย้ำ/g, 'เลือก'],
];
function softWords(t) { return SOFT_WORDS.reduce((s, [re, to]) => s.replace(re, to), t); }
function shortHistory(t, keep = 6) {
  const a = t.indexOf('เหตุการณ์ที่ผ่านมา:');
  const b = t.lastIndexOf('ตอนนี้:');
  if (a < 0 || b < a) return t;
  const lines = t.slice(a, b).trim().split('\n').slice(1).filter((l) => l.trim());
  return t.slice(0, a) + 'เหตุการณ์ล่าสุด:\n' + lines.slice(-keep).join('\n') + '\n\n' + t.slice(b);
}

// ---------- Mock (no quota, for UI tests) ----------
const MOCK_LINES = [
  'เมื่อคืนได้ยินเสียงอะไรแปลกๆ แถวบ้านท้ายซอย ใครออกไปข้างนอกบ้าง',
  'ฉันว่าคนที่เงียบที่สุดนั่นแหละน่าสงสัย',
  'อย่าเพิ่งรีบโหวตนะ ฟังเหตุผลกันก่อน',
  'ฉันเป็นชาวบ้านธรรมดา ไม่มีอะไรจะซ่อน',
  'คำพูดเมื่อกี้ขัดกับที่พูดรอบแรกนะ สังเกตไหม',
  'โอเค งั้นรอบนี้ฉันขอตามเสียงส่วนใหญ่',
];
async function callMock(cfg, app, { kind, names }) {
  const ms = 300 + Math.floor(Math.random() * 700);
  await new Promise((r) => setTimeout(r, app.mockDelay ?? ms));
  const pick = (a) => (a && a.length ? a[Math.floor(Math.random() * a.length)] : 'ใครสักคน');
  const json = { aside: 'ทดสอบ: คิดในใจว่า ' + pick(names || ['ใครสักคน']) + ' น่าสงสัย' };
  if (kind === 'speak') { json.say = pick(MOCK_LINES); json.suspect = pick(names); }
  if (kind === 'last') json.say = 'ฝากด้วยนะทุกคน ฉันไม่ใช่หมาป่าจริงๆ';
  if (kind === 'wolf') { json.whisper = 'คืนนี้เอา ' + pick(names) + ' ดีไหม'; json.target = pick(names); }
  if (kind === 'target') json.target = pick(names);
  return { ok: true, ms, json, text: JSON.stringify(json), usage: { input: 0, output: 0 } };
}

// ---------- Gemini (direct API, billed key) ----------
// Gemini seats call the API directly with the viewer's key (data/gemini_key.txt).
function toApiSchema(js) {
  // JSON Schema subset → Gemini responseSchema (no additionalProperties)
  const out = { type: String(js.type).toUpperCase() };
  if (js.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(js.properties)) out.properties[k] = toApiSchema(v);
  }
  if (js.required) out.required = js.required;
  return out;
}

async function callGeminiOnce(cfg, app, { system, prompt, kind }) {
  const t0 = Date.now();
  let key;
  try { key = fs.readFileSync(P.GEMINI_KEY_FILE, 'utf8').trim(); } catch (e) { key = ''; }
  if (!key) return { ok: false, ms: 0, error: 'no key file' };
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: toApiSchema(schemaFor(kind)) },
    // a party game talks about wolves "taking" people — only block clearly harmful output
    safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
      .map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), app.timeoutMs);
  let j = null, status = 0, raw = '';
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: ctl.signal,
    });
    status = r.status;
    raw = await r.text();
    try { j = JSON.parse(raw); } catch (_) {}
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, ms: Date.now() - t0, error: ctl.signal.aborted ? 'timeout' : String(e).slice(0, 200) };
  }
  clearTimeout(timer);
  const ms = Date.now() - t0;
  const res = { ms, raw: raw.slice(0, 4000) };
  if (!j || status !== 200) {
    const msg = String(j?.error?.message || raw);
    // a free key on a paid-only model: "limit: 0" sits far down Google's 429 text — keep it for explainError
    const zero = /limit:\s*0\b/.test(msg) && !/limit:\s*0\b/.test(msg.slice(0, 200)) ? ' … limit: 0' : '';
    return { ...res, ok: false, error: `HTTP ${status}: ${msg.slice(0, 200)}${zero}` };
  }
  const um = j.usageMetadata || {};
  const usage = {
    input: um.promptTokenCount || 0, output: um.candidatesTokenCount || 0, thinking: um.thoughtsTokenCount || 0,
    costUsd: ((um.promptTokenCount || 0) * (cfg.priceIn || 0) + ((um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0)) * (cfg.priceOut || 0)) / 1e6,
  };
  const blockReason = j.promptFeedback?.blockReason;
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  const json = extractJson(text);
  if (blockReason || (cand && cand.finishReason === 'SAFETY')) return { ...res, ok: false, usage, blocked: true, error: `blocked (${blockReason || 'SAFETY'})` };
  return { ...res, ok: !!json, error: json ? null : `unparsable (${cand?.finishReason || 'no candidate'})`, text, json, usage, meta: { path: 'api', finishReason: cand?.finishReason } };
}

async function callGemini(cfg, app, req) {
  // API: as is → softer words + latest history if Google's filter blocks it
  const tries = [(p) => p, (p) => softWords(shortHistory(p, 12))];
  let r = null;
  let spent = 0;
  for (let i = 0; i < tries.length; i++) {
    r = await callGeminiOnce(cfg, app, { ...req, prompt: tries[i](req.prompt) });
    spent += r.ms || 0;
    if (r.ok) { r.meta = { ...(r.meta || {}), apiStage: i }; r.ms = spent; return r; }
    if (!r.blocked) break; // a real error: softer words will not help
  }
  return r;
}

const CALLERS = { claude: callClaude, codex: callCodex, gemini: callGemini, mock: callMock };

async function callProvider(providerId, cfg, app, req) {
  const fn = CALLERS[providerId];
  if (!fn) return { ok: false, error: `unknown provider ${providerId}`, ms: 0 };
  try { return await fn(cfg, app, req); }
  catch (e) { return { ok: false, error: String(e && e.stack || e).slice(0, 500), ms: 0 }; }
}

module.exports = { callProvider, extractJson, schemaFor, codexRateLimits };
