// server.js — serves the room page, runs one game at a time, streams events
// over SSE filtered per view (god sees everything, a player sees only what
// that seat may see), and accepts the human seat's input.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Game } = require('./engine');
const { Voice } = require('./voice');
const P = require('./paths');
const S = require('./settings');
const D = require('./detect');

const APP_ID = 'vreki-werewolf';
const VERSION = require('../package.json').version;
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
CONFIG.logsDir = P.LOGS;
CONFIG.sandboxDir = P.SANDBOX;
const PUB = path.join(__dirname, 'public');
P.ensureDataDirs();
const SERVER_LOG = path.join(CONFIG.logsDir, 'server.log');
const QUIET = !!process.env.VREKI_QUIET;
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(SERVER_LOG, line); } catch (_) {}
  if (!QUIET) process.stdout.write(line);
}

let game = null;
let voice = null; // tts.py workers, started by the first game that has voices on
const clients = new Set(); // { res, view, seat }

// which voice modes this PC can play right now
function voiceModes(det) {
  const py = det.python.ready && det.python.edgeTts;
  return { off: true, free: py, gemini: py && det.gemini.ready && det.ffmpeg.ready };
}
// the asked-for mode, or the next one down that works (gemini → free → off)
function pickVoice(want, modes) {
  const order = ['gemini', 'free', 'off'];
  for (const m of order.slice(Math.max(0, order.indexOf(want)))) if (modes[m]) return m;
  return 'off';
}
function voiceFor(mode, det) {
  if (mode === 'off') return null;
  if (!voice) {
    voice = new Voice({ ...CONFIG.voice, python: det.python.path, script: path.join(__dirname, 'tts.py'),
      env: { VREKI_GEMINI_KEY_FILE: P.GEMINI_KEY_FILE, VREKI_TTS_USAGE_LOG: P.TTS_USAGE_LOG, ...(det.ffmpeg.path ? { VREKI_FFMPEG: det.ffmpeg.path } : {}) } }, log);
  }
  const over = mode === 'free' ? { engine: 'edge' } : {};
  return { say: (char, text, out) => voice.say(char, text, out, over) };
}

function setupInfo(det, settings) {
  const pub = (d) => ({ ready: d.ready, reason: d.reason || null, warn: d.warn || null });
  return {
    settings,
    detect: { claude: pub(det.claude), codex: pub(det.codex), gemini: pub(det.gemini), python: { ...pub(det.python), edgeTts: det.python.edgeTts }, ffmpeg: pub(det.ffmpeg) },
    voiceModes: voiceModes(det),
    defaults: S.DEFAULTS,
    labels: Object.fromEntries(S.COMPANIES.map((id) => [id, { label: CONFIG.providers[id].label, color: CONFIG.providers[id].color, modelLabel: CONFIG.providers[id].modelLabel }])),
  };
}

const THAI_COMPANY = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini' };

function visibleTo(ev, view, seat) {
  if (view === 'god') return true;
  if (ev.vis === 'all') return true;
  if (view === 'audience') return false; // spectators see public events only
  if (ev.vis && Array.isArray(ev.vis.seats)) return ev.vis.seats.includes(seat);
  return false;
}
function send(res, ev) { res.write(`data: ${JSON.stringify(ev)}\n\n`); }

function broadcast(ev) {
  for (const c of clients) if (!c.replay && visibleTo(ev, c.view, c.seat)) send(c.res, ev);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
  });
}

const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

// the two games from the ep003 clip ship in replays/ (read-only); the viewer's own games live in data/logs
let clipIndex = [];
try { clipIndex = JSON.parse(fs.readFileSync(path.join(P.REPLAYS, 'index.json'), 'utf8')); } catch (_) {}
const VALID_ID = /^g_[0-9_]+$/;

// folder of a finished game, or null
function gameDir(id) {
  if (!VALID_ID.test(id || '')) return null;
  for (const root of [CONFIG.logsDir, P.REPLAYS]) {
    const d = path.join(root, id);
    if (fs.existsSync(path.join(d, 'events.jsonl'))) return d;
  }
  return null;
}

function listGames() {
  const row = (dir, id, extra) => {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, id, 'summary.json'), 'utf8')); } catch (_) {}
    return { id, winner: s?.winner || null, durationSec: s?.durationSec || null, humanSeat: s?.humanSeat ?? null, mock: s?.mock || false, ...extra };
  };
  const clip = clipIndex.filter((c) => VALID_ID.test(c.id) && fs.existsSync(path.join(P.REPLAYS, c.id))).map((c) => row(P.REPLAYS, c.id, { fromClip: true, label: c.label }));
  const own = fs.existsSync(CONFIG.logsDir)
    ? fs.readdirSync(CONFIG.logsDir).filter((d) => VALID_ID.test(d)).sort().reverse().map((d) => row(CONFIG.logsDir, d, {}))
    : [];
  return [...clip, ...own];
}

// Only the game's own page may talk to the game. Other sites open in the same browser
// could otherwise POST here (a text/plain "simple request" skips CORS) or read it through
// DNS rebinding: refuse foreign Host / Origin, and POSTs that are not JSON.
function blocked(req) {
  const port = server.address()?.port;
  const own = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!own.includes(String(req.headers.host || '').toLowerCase())) return [403, 'forbidden host'];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !own.some((h) => origin.toLowerCase() === `http://${h}`)) return [403, 'forbidden origin'];
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return [415, 'json only'];
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const no = blocked(req);
  if (no) return json(res, no[0], { error: no[1] });
  try {
    if (p === '/events') {
      const replayId = url.searchParams.get('replay');
      const view = ['player', 'audience'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'god';
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (replayId) {
        if (!VALID_ID.test(replayId)) { send(res, { type: 'error', message: 'bad id' }); return res.end(); }
        const dir = gameDir(replayId);
        if (!dir) { send(res, { type: 'error', message: 'no such game' }); return res.end(); }
        const f = path.join(dir, 'events.jsonl');
        const seat = url.searchParams.has('seat') ? Number(url.searchParams.get('seat')) : null;
        const evs = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
        send(res, { type: 'hello', view, seat, replay: replayId });
        for (const ev of evs) if (visibleTo(ev, view, seat)) send(res, ev);
        send(res, { type: 'replay_end' });
        const c = { res, view, seat, replay: true };
        clients.add(c);
        req.on('close', () => clients.delete(c));
        return;
      }
      let seat = null;
      if (view === 'player') seat = url.searchParams.has('seat') ? Number(url.searchParams.get('seat')) : (game?.humanSeat ?? null);
      const c = { res, view, seat };
      clients.add(c);
      req.on('close', () => clients.delete(c));
      send(res, { type: 'hello', view, seat, gameId: game?.id || null, running: !!(game && !game.done) });
      if (game) {
        for (const ev of game.events) if (visibleTo(ev, view, seat)) send(res, { ...ev, backlog: true });
        // a pending human turn must be re-offered after a page reload
        if (game.pendingHuman && view === 'player' && seat === game.pendingHuman.seat) {
          const last = [...game.events].reverse().find((e) => e.type === 'await_human' && e.token === game.pendingHuman.token);
          if (last) send(res, { ...last, backlog: false, reoffer: true });
        }
      }
      send(res, { type: 'live' });
      return;
    }

    if (p === '/api/setup') {
      const settings = S.loadSettings();
      const det = await D.detectAll(settings, { refresh: url.searchParams.get('refresh') === '1' });
      return json(res, 200, setupInfo(det, settings));
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      delete b.paths; // program paths are never set over HTTP (the game runs them); edit data/settings.json by hand
      if (typeof b.geminiKey === 'string' && b.geminiKey.trim() && !/^[\x21-\x7e]+$/.test(b.geminiKey.trim())) {
        return json(res, 400, { error: 'คีย์ Gemini ต้องเป็นตัวอักษรภาษาอังกฤษ/ตัวเลขติดกัน ไม่มีช่องว่างหรือขึ้นบรรทัดใหม่' });
      }
      if (typeof b.geminiKey === 'string' && b.geminiKey.trim()) {
        fs.mkdirSync(P.DATA, { recursive: true });
        fs.writeFileSync(P.GEMINI_KEY_FILE, b.geminiKey.trim());
      } else if (b.geminiKey === null) {
        try { fs.unlinkSync(P.GEMINI_KEY_FILE); } catch (_) {}
      }
      if ('geminiKey' in b) D.clearDetectCache();
      const settings = S.saveSettings(b);
      const geminiKeySet = fs.existsSync(P.GEMINI_KEY_FILE);
      return json(res, 200, { settings, geminiKeySet });
    }

    if (p === '/api/test' && req.method === 'POST') {
      const b = await body(req);
      if (!S.COMPANIES.includes(b.provider)) return json(res, 400, { ok: false, message: 'ไม่รู้จักค่ายนี้' });
      const settings = S.loadSettings();
      const det = await D.detectAll(settings);
      const r = await D.testProvider(b.provider, S.applyModels(CONFIG, settings), det);
      log('test', b.provider, r.ok ? 'ok' : 'FAIL', r.ms, r.raw || '');
      return json(res, 200, { ok: r.ok, ms: r.ms, message: r.message });
    }

    if (p === '/api/new' && req.method === 'POST') {
      const b = await body(req);
      if (game && !game.done) {
        if (!b.force) return json(res, 409, { error: 'มีเกมกำลังเล่นอยู่' });
        game.abort();
      }
      const settings = S.loadSettings();
      const det = await D.detectAll(settings);
      const mock = !!b.mock;
      let providers = Array.isArray(b.providers) ? b.providers.filter((x) => S.COMPANIES.includes(x)) : settings.providers;
      if (mock && !providers.length) providers = [...S.COMPANIES]; // test mode needs no AI at all
      if (!providers.length) return json(res, 400, { error: 'เลือกค่าย AI อย่างน้อย 1 ค่ายก่อนเริ่มเกม' });
      if (!mock) {
        const notReady = providers.filter((x) => !det[x].ready);
        if (notReady.length) return json(res, 400, { error: `${notReady.map((x) => THAI_COMPANY[x]).join(' · ')} ยังไม่พร้อม — ${det[notReady[0]].reason}` });
      }
      const humanSeat = Number.isInteger(b.humanSeat) && b.humanSeat >= 0 && b.humanSeat < CONFIG.characters.length ? b.humanSeat : null;
      // an aborted game may still be finishing its last call: only the current game reaches the screens
      const humanChar = CONFIG.characters.some((c) => c.id === b.humanChar) ? b.humanChar : null;
      const seats = S.seatSplit(providers);
      const wantVoice = S.VOICES.includes(b.voice) ? b.voice : settings.voice;
      const voiceUsed = mock && !b.mockVoice ? 'off' : pickVoice(wantVoice, voiceModes(det));
      const showCompanies = !humanChar && (typeof b.showCompanies === 'boolean' ? b.showCompanies : settings.showCompanies);
      const cfg = D.withTools(S.applyModels(CONFIG, settings), det);
      const g = new Game(cfg, { humanSeat: humanChar ? null : humanSeat, humanChar, mock, mockDelay: b.mockDelay, seatsPerProvider: seats, showCompanies,
        voice: voiceFor(voiceUsed, det), onEvent: (ev) => { if (game === g) broadcast(ev); } });
      game = g;
      log('new game', g.id, 'human', g.humanSeat, humanChar || '', 'mock', mock, 'seats', JSON.stringify(seats), 'voice', voiceUsed, 'show', showCompanies);
      for (const c of clients) if (!c.replay) send(c.res, { type: 'reset', gameId: g.id, humanSeat: g.humanSeat });
      setTimeout(() => g.run().then(() => log('game done', g.id, g.summary?.winner)), 300);
      return json(res, 200, { ok: true, gameId: g.id, humanSeat: g.humanSeat, seats, voiceUsed, showCompanies });
    }

    if (p === '/api/human' && req.method === 'POST') {
      if (!game) return json(res, 400, { error: 'no game' });
      const r = game.humanInput(await body(req));
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/abort' && req.method === 'POST') {
      if (game && !game.done) game.abort();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/status') {
      return json(res, 200, {
        app: APP_ID, version: VERSION,
        gameId: game?.id || null, running: !!(game && !game.done), humanSeat: game?.humanSeat ?? null,
        waitingHuman: !!game?.pendingHuman, events: game?.events.length || 0, summary: game?.summary || null,
        characters: CONFIG.characters.map((c) => ({ id: c.id, name: c.name, tag: c.tag, color: c.color })),
      });
    }

    if (p === '/api/games') return json(res, 200, listGames());

    if (p === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true });
      log('shutdown requested');
      if (game && !game.done) game.abort();
      setTimeout(() => { voice && voice.close(); process.exit(0); }, 400);
      return;
    }

    // character voice files of a game
    const am = p.match(/^\/audio\/(g_[0-9_]+)\/([0-9]+_[a-z]+\.mp3)$/);
    if (am) {
      // a game still being played has no events.jsonl yet in some moments: check the live folder first
      const dir = fs.existsSync(path.join(CONFIG.logsDir, am[1])) ? path.join(CONFIG.logsDir, am[1]) : gameDir(am[1]);
      const f = dir && path.join(dir, 'audio', am[2]);
      if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }

    // static
    let f = p === '/' ? '/index.html' : p;
    f = path.normalize(path.join(PUB, f));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    log('error', e.stack || e);
    try { json(res, 500, { error: String(e) }); } catch (_) {}
  }
});

// keep SSE connections alive through idle stretches
const ping = setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 15000);
ping.unref();

// → Promise<{ port, close() }>; rejects with EADDRINUSE when the port is taken (launch.js tries the next one)
function start(port = CONFIG.port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => {
      server.off('error', onErr);
      server.on('error', (e) => log('server error', e.stack || e));
      const real = server.address().port;
      log(`werewolf room on http://localhost:${real} pid ${process.pid}`);
      resolve({ port: real, close: () => { if (game && !game.done) game.abort(); voice && voice.close(); for (const c of clients) c.res.end(); server.close(); } });
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

// in use by another program, or reserved by Windows (Hyper-V / WSL port ranges give EACCES)
const portTaken = (e) => e && (e.code === 'EADDRINUSE' || e.code === 'EACCES');

module.exports = { start, portTaken, APP_ID };

if (require.main === module) {
  const argPort = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7));
  start(argPort || Number(process.env.VREKI_PORT) || CONFIG.port).catch((e) => { log('cannot start:', e.code || e); process.exit(1); });
}
