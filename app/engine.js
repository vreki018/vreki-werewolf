// engine.js — the moderator. Pure code, no AI: runs nights, days, deaths,
// discussion turns and votes, asks each seat's provider for its move,
// and emits events tagged with who may see them.
'use strict';
const fs = require('fs');
const path = require('path');
const { callProvider } = require('./providers');
const { explainError } = require('./detect');

// a company that fails this many turns in a row stops the game (logged out, quota gone, …)
const MAX_FAIL_STREAK = 3;
const COST_NOTE = {
  claude: 'ราคาเทียบ API ไม่ใช่เงินที่จ่ายจริง (เล่นด้วยโควต้าแพ็ก Claude)',
  codex: 'ใช้โควต้าแพ็ก ChatGPT ไม่มีค่าใช้จ่ายแยก',
  gemini: 'ประมาณจากราคาใน config.default.json (คีย์ฟรี = 0)',
};

const ROLE_TH = { wolf: 'หมาป่า', seer: 'หมอดู', doctor: 'หมอ', villager: 'ชาวบ้าน' };
const GOD = { seats: [] }; // visible to god view only (plus nobody else)
// AI lines: the length VreKi liked in his own first game (prompt asks 1-2 sentences, ≤40 words;
// 260 chars is only a safety net — max seen in that game was 164).
const AI_SPEECH_CAP = 260;
// The human player's lines are never cut (VreKi 2026-10-19: "เผื่อผมอยากพูดยาว").
const capFor = (p) => (p.provider === 'human' ? Infinity : AI_SPEECH_CAP);

function shuffle(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class Game {
  // opts: { humanSeat: number|null, mock: bool, onEvent(ev) }
  constructor(config, opts) {
    this.cfg = config;
    this.opts = opts;
    this.id = `g_${stamp()}`;
    this.dir = path.join(config.logsDir, this.id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.events = [];
    this.seq = 0;
    this.t0 = Date.now();
    this.publicLog = [];
    this.pendingHuman = null;
    this.aborted = false;
    this.stats = {};
    this.failStreak = {};  // provider → failed turns in a row
    this.lastWarn = {};    // provider → last Thai warning shown (no repeats)
    this.stopReason = null;
    this.codexLimits = { first: null, last: null };
    this.lastProtected = null;
    this.app = {
      sandboxDir: config.sandboxDir,
      timeoutMs: (config.callTimeoutSec || 150) * 1000,
      mockDelay: opts.mockDelay,
      providers: config.providers, // lets a provider fall back to another one
    };

    // every game shuffles three things: where each character sits on screen,
    // which company plays each character, and the roles
    // opts.seatsPerProvider = the viewer's pick for this game (settings.seatSplit)
    const provPool = [];
    for (const [pid, n] of Object.entries(opts.seatsPerProvider || config.seatsPerProvider)) for (let i = 0; i < n; i++) provPool.push(pid);
    const providers = shuffle(provPool);
    const roles = shuffle(config.roles);
    const chars = opts.fixedSeats ? config.characters : shuffle(config.characters);
    this.players = chars.map((c, i) => ({
      seat: i,
      id: c.id,
      name: c.name,
      tag: c.tag,
      color: c.color,
      persona: c.persona,
      provider: opts.mock ? 'mock' : providers[i],
      company: providers[i], // the AI this seat stands for, also in a mock game (show-companies switch)
      role: roles[i],
      alive: true,
      notes: [],      // private memory lines (role info, seer results, wolf plans)
      thoughts: [],   // own past thoughts, fed back for continuity
    }));
    // the human picks a character in the lobby; find where it sits this game
    if (opts.humanChar) {
      const k = this.players.findIndex((p) => p.id === opts.humanChar);
      opts.humanSeat = k >= 0 ? k : null;
    }
    if (opts.humanSeat != null) {
      const h = this.players[opts.humanSeat];
      h.replacedProvider = h.provider;
      h.provider = 'human';
    }
    this.humanSeat = opts.humanSeat ?? null;
    this.callsFile = path.join(this.dir, 'calls.jsonl');
    this.eventsFile = path.join(this.dir, 'events.jsonl');
    this.outbox = [];      // events wait here in order until their voice file is ready
    this.drainWaiters = [];
    this.voice = opts.voice || null;
    this.audioN = 0;
    this.humanN = 0;
    this.voiceStats = { lines: 0, ok: 0, failed: 0, totalMs: 0, maxMs: 0, audioSec: 0, byChar: {} };
  }

  // ---------- events ----------
  // pending: a promise (voice file) — this event and every later one wait for it,
  // so the screen always gets events in game order while the next AI already thinks.
  emit(type, data = {}, vis = 'all', pending = null) {
    const ev = { type, vis, ...data };
    const item = { ev, ready: !pending };
    this.outbox.push(item);
    if (pending) pending.then((extra) => { Object.assign(ev, extra || {}); item.ready = true; this.flushOutbox(); });
    this.flushOutbox();
    return ev;
  }
  flushOutbox() {
    while (this.outbox.length && this.outbox[0].ready) {
      const { ev } = this.outbox.shift();
      ev.seq = ++this.seq;
      ev.t = Date.now() - this.t0;
      this.events.push(ev);
      fs.appendFileSync(this.eventsFile, JSON.stringify(ev) + '\n');
      this.opts.onEvent && this.opts.onEvent(ev);
    }
    if (!this.outbox.length) { const w = this.drainWaiters; this.drainWaiters = []; w.forEach((r) => r()); }
  }
  drain() { return this.outbox.length ? new Promise((r) => this.drainWaiters.push(r)) : Promise.resolve(); }

  // a spoken line: the character's voice is made in the background, the event waits for it
  sayLine(p, kind, text, extra = {}, vis = 'all') {
    let pending = null;
    if (this.voice && kind !== 'whisper' && /[ก-๙A-Za-z0-9]/.test(text)) {
      const file = path.join(this.dir, 'audio', `${++this.audioN}_${p.id}.mp3`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      pending = this.voice.say(p.id, text, file).then((r) => {
        const v = this.voiceStats;
        const c = (v.byChar[p.id] ||= { lines: 0, ok: 0, totalMs: 0, maxMs: 0 });
        v.lines++; c.lines++;
        v.totalMs += r.ms || 0; c.totalMs += r.ms || 0;
        v.maxMs = Math.max(v.maxMs, r.ms || 0); c.maxMs = Math.max(c.maxMs, r.ms || 0);
        if (r.ok) { v.ok++; c.ok++; v.audioSec += r.duration_sec || 0; } else v.failed++;
        fs.appendFileSync(this.callsFile, JSON.stringify({ t: Date.now() - this.t0, type: 'voice', seat: p.seat, name: p.name, ok: !!r.ok, ms: r.ms, synthMs: r.synth_ms, audioSec: r.duration_sec, attempts: r.attempts, error: r.error || null }) + '\n');
        return r.ok ? { audio: `/audio/${this.id}/${path.basename(file)}`, audioSec: r.duration_sec } : { audioError: r.error };
      });
    }
    this.emit('speech', { seat: p.seat, kind, text, ...extra }, vis, pending);
  }
  pub(line) { this.publicLog.push(line); }
  // promptText: softer wording for the AIs (Google's safety filter trips on gore words)
  // extra: { big, title, sub, cue } → the page shows a centred announcement and plays a sound cue
  narrate(text, vis = 'all', promptText = null, extra = {}) {
    this.emit('narrate', { text, ...extra }, vis);
    if (vis === 'all') this.pub(`ผู้ดำเนินเกม: ${promptText || text}`);
  }

  alive() { return this.players.filter((p) => p.alive); }
  wolves() { return this.alive().filter((p) => p.role === 'wolf'); }
  byRole(r) { return this.alive().filter((p) => p.role === r); }
  wolfSeats() { return this.players.filter((p) => p.role === 'wolf').map((p) => p.seat); }

  seatInfo(p) {
    const prov = this.cfg.providers[p.provider] || {};
    return { seat: p.seat, id: p.id, name: p.name, tag: p.tag, color: p.color, role: p.role, roleTh: ROLE_TH[p.role],
      provider: p.provider, company: prov.company, label: prov.label, model: prov.model, modelLabel: prov.modelLabel, companyColor: prov.color,
      replacedProvider: p.replacedProvider || null };
  }

  // the table everyone sees at the start; with the show-companies switch on (AI-only games)
  // each seat also carries its company, so the page can show the badges from the first frame
  gameInitData() {
    const show = !!this.opts.showCompanies && this.humanSeat == null;
    return {
      gameId: this.id,
      humanSeat: this.humanSeat,
      showCompanies: show,
      seats: this.players.map((p) => {
        const s = { seat: p.seat, id: p.id, name: p.name, tag: p.tag, color: p.color };
        if (!show) return s;
        const prov = this.cfg.providers[p.company] || {};
        return { ...s, provider: p.company, label: prov.label, modelLabel: prov.modelLabel, companyColor: prov.color };
      }),
    };
  }

  // ---------- main loop ----------
  async run() {
    try {
      this.emit('game_init', this.gameInitData());
      // each seat learns its own role; god sees all
      for (const p of this.players) {
        const partner = p.role === 'wolf' ? this.players.filter((q) => q.role === 'wolf' && q !== p).map((q) => q.name) : [];
        this.emit('role', { seat: p.seat, role: p.role, roleTh: ROLE_TH[p.role], partners: partner }, { seats: [p.seat] });
        p.notes.push(`บทลับของคุณ: ${ROLE_TH[p.role]}` + (partner.length ? ` (เพื่อนหมาป่าของคุณ: ${partner.join(', ')})` : ''));
      }
      this.narrate('ยินดีต้อนรับสู่หมู่บ้าน มีหมาป่าแฝงตัวอยู่ 2 ตัว ใครโกหกเก่งที่สุดจะรอด', 'all', null, { big: true, title: 'หมู่บ้านหมาป่า', sub: 'มีหมาป่าแฝงตัวอยู่ 2 ตัว ใครโกหกเก่งที่สุดจะรอด', cue: 'start' });
      let winner = null;
      for (let n = 1; n <= this.cfg.maxDays && !winner && !this.aborted; n++) {
        await this.night(n);
        winner = this.checkWin();
        if (winner || this.aborted) break;
        await this.day(n);
        winner = this.checkWin();
      }
      await this.drain();
      this.finish(winner || (this.aborted ? 'aborted' : 'draw'));
    } catch (e) {
      this.emit('error', { message: String(e && e.stack || e) }, GOD);
      await this.drain();
      this.finish('error');
    }
  }

  checkWin() {
    const w = this.wolves().length;
    const others = this.alive().length - w;
    if (w === 0) return 'village';
    if (w >= others) return 'wolves';
    return null;
  }

  // ---------- night ----------
  async night(n) {
    this.emit('phase', { phase: 'night', n });
    this.pub(`[คืนที่ ${n}]`);
    this.narrate(`คืนที่ ${n} มาถึงแล้ว ทุกคนหลับตา…`, 'all', null, { big: true, title: `คืนที่ ${n}`, sub: 'ทุกคนหลับตา… หมาป่าออกล่า', cue: 'night' });
    // config nightOneKill:false → on the first night the wolves only scout (games last longer)
    const wolves = n === 1 && this.cfg.nightOneKill === false ? Promise.resolve(null) : this.wolfTurn(n);
    const [kill, seen, saved] = await Promise.all([wolves, this.seerTurn(n), this.doctorTurn(n)]);
    this.emit('dawn', { n });
    this.nightResult = { kill, seen, saved };
  }

  async wolfTurn(n) {
    const wolves = shuffle(this.wolves());
    if (!wolves.length) return null;
    const vis = { seats: this.wolfSeats() };
    const validTargets = this.alive().filter((p) => p.role !== 'wolf');
    let lastPlan = null;
    let target = null;
    for (const w of wolves) {
      const partnerLine = lastPlan ? `เพื่อนหมาป่า ${lastPlan.name} กระซิบว่า: "${lastPlan.whisper}" และเสนอจับ ${lastPlan.target}` : (wolves.length > 1 ? 'คุณเป็นคนเสนอก่อน เพื่อนหมาป่าจะเห็นข้อความของคุณ' : 'เพื่อนหมาป่าของคุณตายแล้ว คุณตัดสินใจคนเดียว');
      const task = `ตอนนี้: คืนที่ ${n} (กลางคืน) คุณคุยลับกับเพื่อนหมาป่าแล้วเลือก 1 คนที่จะจับออกจากเกมคืนนี้\n${partnerLine}\nเลือกได้จาก: ${validTargets.map((p) => p.name).join(', ')}\nตอบ JSON: {"aside":"บทพูดในใจของตัวละคร 1 ประโยค","whisper":"ประโยคกระซิบเพื่อนหมาป่า 1 ประโยค","target":"ชื่อคนที่จะจับออก"}`;
      const r = await this.ask(w, 'wolf', task, validTargets, vis, { n });
      const t = r.target || validTargets[Math.floor(Math.random() * validTargets.length)];
      if (r.whisper) this.sayLine(w, 'whisper', r.whisper, {}, vis);
      this.emit('night_action', { seat: w.seat, action: 'kill', target: t.seat, targetName: t.name }, vis);
      lastPlan = { name: w.name, whisper: r.whisper || '', target: t.name };
      target = t; // the last wolf to speak has the final say
    }
    for (const w of this.players.filter((p) => p.role === 'wolf')) {
      w.notes.push(`คืนที่ ${n}: ฝั่งหมาป่าเลือกจับ ${target.name}`);
    }
    return target;
  }

  async seerTurn(n) {
    const s = this.byRole('seer')[0];
    if (!s) return null;
    const options = this.alive().filter((p) => p !== s);
    const task = `ตอนนี้: คืนที่ ${n} (กลางคืน) คุณเป็นหมอดู เลือกส่อง 1 คนเพื่อรู้ว่าเป็นหมาป่าหรือไม่\nเลือกได้จาก: ${options.map((p) => p.name).join(', ')}\nตอบ JSON: {"aside":"บทพูดในใจของตัวละคร 1 ประโยค","target":"ชื่อคนที่จะส่อง"}`;
    const r = await this.ask(s, 'target', task, options, { seats: [s.seat] }, { n });
    const t = r.target || options[Math.floor(Math.random() * options.length)];
    const isWolf = t.role === 'wolf';
    this.emit('night_action', { seat: s.seat, action: 'see', target: t.seat, targetName: t.name, result: isWolf ? 'wolf' : 'notwolf' }, { seats: [s.seat] });
    s.notes.push(`คืนที่ ${n}: คุณส่อง ${t.name} → ${isWolf ? 'เป็นหมาป่า!' : 'ไม่ใช่หมาป่า'}`);
    return t;
  }

  async doctorTurn(n) {
    const d = this.byRole('doctor')[0];
    if (!d) return null;
    const options = this.alive().filter((p) => p !== this.lastProtected);
    const rule = this.lastProtected ? ` (เมื่อคืนคุณปกป้อง ${this.lastProtected.name} คืนนี้ห้ามซ้ำ)` : '';
    const task = `ตอนนี้: คืนที่ ${n} (กลางคืน) คุณเป็นหมอ เลือกปกป้อง 1 คน (ปกป้องตัวเองได้)${rule} ถ้าหมาป่าเลือกคนนั้น เขาจะรอด\nเลือกได้จาก: ${options.map((p) => p.name).join(', ')}\nตอบ JSON: {"aside":"บทพูดในใจของตัวละคร 1 ประโยค","target":"ชื่อคนที่จะปกป้อง"}`;
    const r = await this.ask(d, 'target', task, options, { seats: [d.seat] }, { n });
    const t = r.target || options[Math.floor(Math.random() * options.length)];
    this.emit('night_action', { seat: d.seat, action: 'protect', target: t.seat, targetName: t.name }, { seats: [d.seat] });
    d.notes.push(`คืนที่ ${n}: คุณปกป้อง ${t.name}`);
    this.lastProtected = t;
    return t;
  }

  // ---------- day ----------
  async day(n) {
    this.emit('phase', { phase: 'day', n });
    this.pub(`[วันที่ ${n}]`);
    const { kill, saved } = this.nightResult || {};
    if (kill && saved && kill.seat === saved.seat) {
      this.narrate(`เช้าวันที่ ${n} … เมื่อคืนไม่มีใครตาย มีคนรอดมาได้อย่างหวุดหวิด`, 'all', null, { big: true, title: `เช้าวันที่ ${n}`, sub: 'เมื่อคืนไม่มีใครตาย มีคนรอดมาอย่างหวุดหวิด', cue: 'morning' });
      this.emit('saved', { seat: kill.seat }, GOD);
    } else if (kill) {
      this.narrate(`เช้าวันที่ ${n} … ${kill.name} ถูกพบเป็นศพ (บท: ${ROLE_TH[kill.role]})`, 'all', `เช้าวันที่ ${n}: ${kill.name} ถูกหมาป่าจับออกจากเกมเมื่อคืน (บท: ${ROLE_TH[kill.role]})`, { big: true, title: `เช้าวันที่ ${n}`, sub: `${kill.name} ถูกพบเป็นศพ · เป็น${ROLE_TH[kill.role]}`, cue: 'death' });
      this.kill(kill, 'night');
    } else {
      this.narrate(`เช้าวันที่ ${n} … เมื่อคืนเงียบสงบ`, 'all', null, { big: true, title: `เช้าวันที่ ${n}`, sub: 'เมื่อคืนเงียบสงบ', cue: 'morning' });
    }
    if (this.checkWin()) return;

    // discussion
    const rounds = this.cfg.discussionRounds || 2;
    const alive = this.alive();
    const start = (n - 1) % alive.length;
    const order = alive.slice(start).concat(alive.slice(0, start));
    for (let r = 1; r <= rounds && !this.aborted; r++) {
      this.emit('round', { n, r, rounds });
      for (const p of order) {
        if (this.aborted) return;
        const task = `ตอนนี้: วันที่ ${n} การคุยรอบ ${r}/${rounds} ถึงตาคุณพูด\nตอบ JSON: {"aside":"บทพูดในใจของตัวละครที่คนดูได้ยินแต่ผู้เล่นอื่นไม่ได้ยิน 1 ประโยคสั้น","say":"สิ่งที่พูดออกไป 1-2 ประโยค ไม่เกิน 40 คำ พูดตามนิสัยตัวละคร ตอบโต้คนอื่นได้","suspect":"ชื่อคนที่สงสัยที่สุดตอนนี้"}`;
        const res = await this.ask(p, 'speak', task, this.alive().filter((q) => q !== p), 'all', { n, r });
        const say = clip(res.say || '…', capFor(p));
        this.sayLine(p, 'speak', say, { n, r });
        this.pub(`${p.name}: "${say}"`);
      }
    }
    if (this.aborted) return;
    await this.vote(n);
  }

  async vote(n) {
    const voters = this.alive();
    this.emit('vote_start', { n });
    this.narrate('ถึงเวลาโหวต! ชี้ตัวคนที่คิดว่าเป็นหมาป่า', 'all', null, { big: true, title: 'ถึงเวลาโหวต!', sub: 'ชี้ตัวคนที่คิดว่าเป็นหมาป่า', cue: 'vote' });
    const results = await Promise.all(voters.map((p) => {
      const options = voters.filter((q) => q !== p);
      const task = `ตอนนี้: วันที่ ${n} ถึงเวลาโหวตไล่ 1 คน (ห้ามโหวตตัวเอง)\nเลือกได้จาก: ${options.map((q) => q.name).join(', ')}\nตอบ JSON: {"aside":"ตัวละครบ่นในใจว่าทำไมโหวตคนนี้ 1 ประโยค","target":"ชื่อคนที่โหวต"}`;
      return this.ask(p, 'target', task, options, 'all', { n, vote: true }, { deferThought: true });
    }));
    const tally = {};
    voters.forEach((p, i) => {
      const options = voters.filter((q) => q !== p);
      const t = results[i].target || options[Math.floor(Math.random() * options.length)];
      results[i].target = t;
      tally[t.seat] = (tally[t.seat] || 0) + 1;
      // the reason appears right before the vote lands
      if (results[i].thought) this.emit('thought', { seat: p.seat, kind: 'vote', text: clip(results[i].thought, 200) }, GOD);
      this.emit('vote', { seat: p.seat, target: t.seat, targetName: t.name });
    });
    this.pub(`ผลโหวตวันที่ ${n}: ` + voters.map((p, i) => `${p.name}→${(results[i].target || {}).name || '?'}`).join(', '));
    const max = Math.max(...Object.values(tally));
    const top = Object.keys(tally).filter((k) => tally[k] === max).map(Number);
    if (top.length > 1) {
      this.emit('vote_result', { n, tally, eliminated: null, tie: top });
      this.narrate(`คะแนนเสมอกัน (${top.map((s) => this.players[s].name).join(' กับ ')}) วันนี้ไม่มีใครถูกไล่`, 'all', null, { big: true, title: 'คะแนนเสมอ', sub: 'วันนี้ไม่มีใครถูกไล่', cue: 'tie' });
      return;
    }
    const out = this.players[top[0]];
    this.emit('vote_result', { n, tally, eliminated: out.seat });
    this.narrate(`${out.name} ถูกโหวตออกด้วย ${max} เสียง ขอคำสั่งเสียหน่อย`, 'all', null, { big: true, title: `${out.name} ถูกโหวตออก`, sub: `${max} เสียง · ขอคำสั่งเสียหน่อย`, cue: 'eliminate' });
    const task = `ตอนนี้: คุณถูกโหวตออกจากหมู่บ้าน พูดคำสั่งเสียได้ 1 ครั้ง\nตอบ JSON: {"aside":"บทพูดในใจของตัวละคร 1 ประโยค","say":"คำสั่งเสีย 1-2 ประโยค"}`;
    const res = await this.ask(out, 'last', task, [], 'all', { n, last: true });
    const say = clip(res.say || '…', capFor(out));
    this.sayLine(out, 'last', say, { n });
    this.pub(`${out.name} (คำสั่งเสีย): "${say}"`);
    this.kill(out, 'vote');
    this.narrate(`${out.name} เป็น… ${ROLE_TH[out.role]}!`, 'all', null, { big: true, title: `${out.name} เป็น…`, sub: `${ROLE_TH[out.role]}!`, cue: out.role === 'wolf' ? 'reveal_wolf' : 'reveal_good' });
  }

  kill(p, cause) {
    p.alive = false;
    this.emit('death', { seat: p.seat, cause, role: p.role, roleTh: ROLE_TH[p.role] });
  }

  // ---------- asking one seat ----------
  // Returns { thought, say, whisper, target(player obj|null) }.
  async ask(p, kind, task, options, vis, ctx, flags = {}) {
    // night thinking would reveal who has a night role → same visibility as the action
    const thinkVis = vis === 'all' ? 'all' : vis;
    this.emit('thinking', { seat: p.seat, kind }, thinkVis);
    let res;
    if (p.provider === 'human') res = await this.askHuman(p, kind, task, options);
    else res = await this.askAI(p, kind, task, options, ctx);
    this.emit('thinking_off', { seat: p.seat }, thinkVis);
    if (res.thought && flags.deferThought) {
      p.thoughts.push(res.thought);
    } else if (res.thought) {
      this.emit('thought', { seat: p.seat, kind, text: clip(res.thought, 200) }, GOD);
      p.thoughts.push(res.thought);
    }
    return res;
  }

  buildPrompt(p, task) {
    const roleCounts = {};
    for (const r of this.cfg.roles) roleCounts[r] = (roleCounts[r] || 0) + 1;
    const roleList = Object.entries(roleCounts).map(([r, c]) => `${ROLE_TH[r]} ${c}`).join(', ');
    const dead = this.players.filter((q) => !q.alive);
    const lines = [
      `กติกา: ผู้เล่น ${this.players.length} คน = ${roleList} (แต่ละคนรู้แค่บทตัวเอง)`,
      (this.cfg.nightOneKill === false ? 'คืนแรกหมาป่ายังไม่เลือกใคร · ' : '') + 'กลางคืน: หมาป่าเลือกจับ 1 คนออกจากเกม · หมอดูส่องได้ 1 คนว่าเป็นหมาป่าไหม · หมอปกป้องได้ 1 คน (ห้ามคนเดิมสองคืนติด)',
      `กลางวัน: ประกาศคนที่ออกจากเกมพร้อมบท → คุยกัน ${this.cfg.discussionRounds} รอบ → โหวตไล่ 1 คน (เสมอ = ไม่มีใครออก) คนถูกไล่เปิดบท`,
      'ชาวบ้านชนะเมื่อหมาป่าตายหมด · หมาป่าชนะเมื่อจำนวนหมาป่าเท่ากับหรือมากกว่าคนที่เหลือ · หมาป่าโกหกได้ทุกอย่าง ฝั่งชาวบ้านจะอ้างบทหรือหลอกก็ได้ถ้าช่วยให้ชนะ',
      '',
      `ตัวคุณ: ${p.name} — ${p.persona}`,
      ...p.notes,
      // own past asides are NOT fed back: Opus 5.5 safeguards read that as reasoning extraction (2026-10-18)
      `ผู้เล่นที่ยังอยู่: ${this.alive().map((q) => q.name).join(', ')}`,
      dead.length ? `ออกจากเกมแล้ว: ${dead.map((q) => `${q.name} (${ROLE_TH[q.role]})`).join(', ')}` : '',
      '',
      'เหตุการณ์ที่ผ่านมา:',
      ...(this.publicLog.length ? this.publicLog : ['(ยังไม่มี)']),
      '',
      task,
    ];
    return lines.filter((l) => l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
  }

  systemPrompt() {
    return 'คุณเป็นผู้เล่นคนหนึ่งในเกมปาร์ตี้ทายบท "หมาป่า" (เกมกระดานสำหรับเพื่อนฝูง ไม่มีความรุนแรงจริง) สวมบทตัวละครที่ได้รับตลอดเวลา พูดภาษาไทยแบบคนคุยกันจริง สั้น เป็นธรรมชาติ ห้ามบอกว่าตัวเองเป็น AI ห้ามใช้เครื่องมือใดๆ ตอบเป็น JSON ก้อนเดียวเท่านั้น ไม่มีข้อความอื่น';
  }

  async askAI(p, kind, task, options, ctx) {
    const cfgP = this.cfg.providers[p.provider];
    const prompt = this.buildPrompt(p, task);
    const system = this.systemPrompt();
    const names = options.map((q) => q.name);
    let r = null;
    let attempt = 0;
    for (attempt = 1; attempt <= 2; attempt++) {
      r = await callProvider(p.provider, cfgP, this.app, { system, prompt, kind, names });
      this.recordCall(p, kind, prompt, r, attempt, ctx);
      if (r.ok) break;
      if (this.aborted) break;
    }
    const j = (r && r.ok && r.json) || {};
    const target = names.length ? matchName(j.target || j.suspect, options) : null;
    if (names.length && j.target !== undefined && !target) this.emit('note', { text: `${p.name} ตอบชื่อที่ไม่มีในเกม ("${j.target}") ระบบสุ่มให้` }, GOD);
    if (!r.ok) this.emit('note', { text: `${p.name} (${p.provider}) ตอบไม่ได้: ${r.error}` }, GOD);
    if (p.provider !== 'mock') this.trackFailure(p.provider, r, cfgP);
    return { thought: j.aside ?? j.thought, say: j.say, whisper: j.whisper, target: kind === 'speak' ? null : target, suspect: kind === 'speak' ? target : null };
  }

  // tells every view, in Thai, why a company is silent; stops the game when it keeps failing
  trackFailure(provider, r, cfgP) {
    if (r.ok) { this.failStreak[provider] = 0; return; }
    if (this.aborted) return;
    const msg = explainError(provider, `${r.error || ''} ${r.stderr || ''} ${r.text || ''}`, cfgP?.model);
    const streak = (this.failStreak[provider] = (this.failStreak[provider] || 0) + 1);
    if (msg !== this.lastWarn[provider]) { this.lastWarn[provider] = msg; this.emit('ai_error', { provider, text: msg }, 'all'); }
    if (streak >= MAX_FAIL_STREAK) { this.stopReason = `หยุดเกม: ${msg}`; this.abort(); }
  }

  recordCall(p, kind, prompt, r, attempt, ctx) {
    const s = (this.stats[p.provider] ||= { calls: 0, ok: 0, failed: 0, retries: 0, totalMs: 0, maxMs: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, promptChars: 0 });
    s.calls++;
    if (attempt > 1) s.retries++;
    if (r.ok) s.ok++; else s.failed++;
    if (r.warning) s.flagged = (s.flagged || 0) + 1;
    s.totalMs += r.ms || 0;
    s.maxMs = Math.max(s.maxMs, r.ms || 0);
    s.promptChars += prompt.length;
    const u = r.usage || {};
    s.input += u.input || 0;
    s.cacheRead += u.cacheRead || 0;
    s.cacheWrite += u.cacheWrite || 0;
    s.output += u.output || 0;
    s.reasoning += (u.reasoning || 0) + (u.thinking || 0);
    s.costUsd += u.costUsd || 0;
    if (p.provider === 'codex' && r.meta?.rateLimits) {
      if (!this.codexLimits.first) this.codexLimits.first = r.meta.rateLimits;
      this.codexLimits.last = r.meta.rateLimits;
    }
    const rec = {
      t: Date.now() - this.t0, seat: p.seat, name: p.name, provider: p.provider, model: this.cfg.providers[p.provider]?.model,
      role: p.role, kind, ctx, attempt, ok: r.ok, ms: r.ms, error: r.error || null, warning: r.warning || null, usage: r.usage || null, meta: r.meta || null,
      prompt, answer: r.json || null, text: r.text || null, stderr: r.ok ? undefined : r.stderr, raw: r.ok ? undefined : r.raw,
    };
    fs.appendFileSync(this.callsFile, JSON.stringify(rec) + '\n');
  }

  // ---------- human seat ----------
  askHuman(p, kind, task, options) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const token = `${this.id}_h${++this.humanN}`;
      this.pendingHuman = {
        token, kind, seat: p.seat, options,
        resolve: (input) => {
          this.pendingHuman = null;
          const target = options.find((o) => o.seat === Number(input.target)) || null;
          const text = clip(String(input.text || '').trim(), Infinity);
          const ans = { thought: '', say: text, whisper: text, target: kind === 'speak' ? null : target };
          fs.appendFileSync(this.callsFile, JSON.stringify({ t: Date.now() - this.t0, seat: p.seat, name: p.name, provider: 'human', role: p.role, kind, ok: true, ms: Date.now() - t0, answer: { text, target: target && target.name } }) + '\n');
          this.emit('human_done', { seat: p.seat }, { seats: [p.seat] });
          resolve(ans);
        },
      };
      const targetPrompt = task.includes('โหวต') ? 'โหวตไล่ใคร?' : p.role === 'seer' ? 'คืนนี้จะส่องใคร?' : p.role === 'doctor' ? 'คืนนี้จะปกป้องใคร?' : 'เลือก 1 คน';
      const prompts = {
        speak: 'ถึงตาคุณพูด', last: 'คุณถูกโหวตออก พูดคำสั่งเสีย', wolf: 'คืนนี้: กระซิบเพื่อนหมาป่า แล้วเลือกเหยื่อ', target: targetPrompt,
      };
      this.emit('await_human', {
        token, seat: p.seat, kind,
        prompt: prompts[kind] || 'ถึงตาคุณ',
        hint: task.split('\n')[0].replace('ตอนนี้: ', ''),
        needText: kind === 'speak' || kind === 'last' || kind === 'wolf',
        options: (kind === 'wolf' || kind === 'target') ? options.map((o) => ({ seat: o.seat, name: o.name })) : [],
      }, { seats: [p.seat] });
    });
  }

  humanInput(input) {
    const ph = this.pendingHuman;
    if (!ph || input.token !== ph.token) return { ok: false, error: 'not waiting for this input' };
    if ((ph.kind === 'wolf' || ph.kind === 'target') && !ph.options.find((o) => o.seat === Number(input.target))) return { ok: false, error: 'invalid target' };
    if ((ph.kind === 'speak' || ph.kind === 'last') && !String(input.text || '').trim()) return { ok: false, error: 'empty text' };
    ph.resolve(input);
    return { ok: true };
  }

  abort() {
    this.aborted = true;
    if (this.pendingHuman) this.pendingHuman.resolve({ text: '…', target: this.pendingHuman.options[0]?.seat });
  }

  // ---------- end ----------
  finish(winner) {
    const reveal = this.players.map((p) => ({ ...this.seatInfo(p), alive: p.alive }));
    const durationSec = Math.round((Date.now() - this.t0) / 1000);
    const byProvider = {};
    for (const [pid, s] of Object.entries(this.stats)) {
      byProvider[pid] = { ...s, avgMs: s.calls ? Math.round(s.totalMs / s.calls) : 0, avgInput: s.calls ? Math.round(s.input / s.calls) : 0 };
    }
    const summary = {
      gameId: this.id, startedAt: new Date(this.t0).toISOString(), durationSec, winner,
      humanSeat: this.humanSeat, mock: !!this.opts.mock,
      models: Object.fromEntries(Object.entries(this.cfg.providers).filter(([k]) => ['claude', 'codex', 'gemini'].includes(k)).map(([k, v]) => [k, { company: v.company, model: v.model, effort: v.effort || null }])),
      seats: reveal, stats: byProvider, costNote: COST_NOTE, codexRateLimits: this.codexLimits, voice: this.voice ? this.voiceStats : null,
      days: this.events.filter((e) => e.type === 'phase' && e.phase === 'day').length,
    };
    fs.writeFileSync(path.join(this.dir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(this.dir, 'transcript.md'), this.transcriptMd(summary));
    this.summary = summary;
    const text = winner === 'village' ? 'ชาวบ้านชนะ! หมาป่าถูกกำจัดหมดแล้ว' : winner === 'wolves' ? 'หมาป่าชนะ! หมู่บ้านถูกยึดแล้ว' : winner === 'draw' ? 'เกมยาวเกินกำหนด เสมอกัน' : (this.stopReason || 'เกมถูกหยุด');
    this.emit('game_over', { winner, text, reveal, durationSec });
    this.done = true;
  }

  transcriptMd(summary) {
    const name = (s) => this.players[s]?.name || s;
    const out = [`# ${this.id} — ผล: ${summary.winner} · ${summary.durationSec} วิ`, '', '| ที่นั่ง | ตัวละคร | บท | ค่าย | รุ่น | รอด |', '|---|---|---|---|---|---|'];
    for (const s of summary.seats) out.push(`| ${s.seat} | ${s.name} | ${s.roleTh} | ${s.company} | ${s.model} | ${s.alive ? 'รอด' : 'ตาย'} |`);
    out.push('', '## เหตุการณ์ (มุมมองพระเจ้า)', '');
    for (const e of this.events) {
      const ts = `${Math.floor(e.t / 60000)}:${String(Math.floor(e.t / 1000) % 60).padStart(2, '0')}`;
      if (e.type === 'phase') out.push('', `### ${e.phase === 'night' ? 'คืน' : 'วัน'}ที่ ${e.n}`);
      else if (e.type === 'narrate') out.push(`- ${ts} _ผู้ดำเนินเกม:_ ${e.text}`);
      else if (e.type === 'thought') out.push(`- ${ts} (คิด) **${name(e.seat)}**: ${e.text}`);
      else if (e.type === 'speech') out.push(`- ${ts} ${e.kind === 'whisper' ? '(กระซิบ) ' : e.kind === 'last' ? '(คำสั่งเสีย) ' : ''}**${name(e.seat)}**: ${e.text}`);
      else if (e.type === 'night_action') out.push(`- ${ts} [${e.action}] ${name(e.seat)} → ${e.targetName}${e.result ? ` (${e.result === 'wolf' ? 'หมาป่า' : 'ไม่ใช่หมาป่า'})` : ''}`);
      else if (e.type === 'vote') out.push(`- ${ts} โหวต: ${name(e.seat)} → ${e.targetName}`);
      else if (e.type === 'note') out.push(`- ${ts} ⚠ ${e.text}`);
      else if (e.type === 'ai_error') out.push(`- ${ts} ⚠ ${e.text}`);
    }
    out.push('', '## การใช้ AI', '');
    for (const [pid, s] of Object.entries(summary.stats || {})) {
      out.push(`- ${pid}: เรียก ${s.calls} ครั้ง (สำเร็จ ${s.ok})${s.costUsd ? ` · $${s.costUsd.toFixed(3)}` : ''}${COST_NOTE[pid] ? ` — ${COST_NOTE[pid]}` : ''}`);
    }
    return out.join('\n');
  }
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const i = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  return (i > n * 0.6 ? cut.slice(0, i + 1) : cut) + '…';
}

function matchName(raw, options) {
  if (!raw) return null;
  const s = String(raw).replace(/\s+/g, '');
  let best = null;
  for (const o of options) {
    const nm = o.name.replace(/\s+/g, '');
    if (s === nm) return o;
    if (s.includes(nm) || nm.includes(s)) if (!best || nm.length > best.name.length) best = o;
  }
  if (best) return best;
  // nickname without title, e.g. "แจ่ม" for "ป้าแจ่ม"
  for (const o of options) {
    const core = o.name.replace(/^(ป้า|ลุง|น้อง|ครู|เจ๊)/, '');
    if (core.length >= 2 && s.includes(core)) return o;
  }
  return null;
}

module.exports = { Game, ROLE_TH, matchName };
