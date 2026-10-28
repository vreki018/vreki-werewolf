// app.js — the room page. Pure event renderer: events from the server are
// queued and shown one at a time (typewriter bubbles), so the AIs can think
// ahead while the screen stays readable.
'use strict';

const ROLE_TH = { wolf: 'หมาป่า', seer: 'หมอดู', doctor: 'หมอ', villager: 'ชาวบ้าน' };
const params = new URLSearchParams(location.search);
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seg = (window.Intl && Intl.Segmenter) ? new Intl.Segmenter('th', { granularity: 'grapheme' }) : null;
const graphemes = (t) => (seg ? Array.from(seg.segment(t), (s) => s.segment) : Array.from(t));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = {
  view: 'god', seat: null, replay: null, seats: [], roles: {}, partners: [],
  humanSeat: null, speed: Number(params.get('speed') || 1), paused: false,
  reveal: null, revealed: false, gameOver: false, characters: [],
};
const Q = [];
let pumping = false;
let es = null;
const thinkStart = {};          // seat → when its thinking dots appeared on screen
const MIN_THINK = Number(params.get('think') || 10000); // same on-screen thinking time for every company

// ---------------- sound effects ----------------
const SFX_EXT = {}; // every cue is an mp3 (app/public/sfx/SOURCES.md)
const SFX_VOL = { start: .45, night: .3, night_amb: .04, morning: .4, death: .45, whoosh: .3, vote: .4, tick_loop: .12, vote_chip: .45, eliminate: .4, reveal_wolf: .45, reveal_good: .4, tie: .4, pop: .2, human_turn: .45, win_village: .45, win_wolves: .35, drumroll: .4, reveal_card: .4, role_card: .35 };
let muted = params.get('mute') === '1';
const loops = {};
function sfxSrc(n) { return `sfx/${n}.${SFX_EXT[n] || 'mp3'}`; }
function sfx(n) {
  if (muted) return null;
  const a = new Audio(sfxSrc(n));
  a.volume = SFX_VOL[n] ?? .4;
  a.play().catch(() => {});
  return a;
}
function loopStart(n) {
  if (muted || loops[n]) return;
  const a = new Audio(sfxSrc(n));
  a.loop = true; a.volume = SFX_VOL[n] ?? .2;
  a.play().catch(() => {});
  loops[n] = a;
}
function loopStop(n, ms = 900) {
  const a = loops[n];
  if (!a) return;
  delete loops[n];
  const v0 = a.volume, t0 = performance.now();
  const iv = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    a.volume = v0 * (1 - k);
    if (k >= 1) { clearInterval(iv); a.pause(); }
  }, 50);
}
function stopAllLoops() { for (const n of Object.keys(loops)) loopStop(n, 300); }

// ---------------- lobby ----------------
async function initLobby() {
  const st = await fetch('/api/status').then((r) => r.json()).catch(() => null);
  S.characters = st?.characters || [];
  $('#lobbyCast').innerHTML = S.characters.map((c, i) => `
    <div class="cast-item" data-seat="${i}" style="--c:${c.color}">
      <div class="portrait">${avatarSVG(c.id, c.color)}</div>
      <div class="nm">${esc(c.name)}</div><div class="tg">${esc(c.tag)}</div>
    </div>`).join('');
  $('#runningBox').hidden = !st?.running;
  document.body.addEventListener('click', onLobbyClick);
  $('#lobbyCast').addEventListener('click', (e) => {
    const it = e.target.closest('.cast-item');
    if (!it || !$('#lobbyCast').classList.contains('picking')) return;
    startGame(S.characters[Number(it.dataset.seat)].id);
  });
}

async function onLobbyClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'start-audience') startGame(null, 'audience');
  if (act === 'start-god') startGame(null, 'god');
  if (act === 'pick-seat') { $('#lobbyCast').classList.add('picking'); $('#pickHint').hidden = false; }
  if (act === 'watch-god') enterRoom({ view: 'god' });
  if (act === 'watch-audience') enterRoom({ view: 'audience' });
  if (act === 'watch-player') enterRoom({ view: 'player' });
  if (act === 'history') {
    const box = $('#historyBox');
    if (!box.hidden) { box.hidden = true; return; }
    const games = await fetch('/api/games').then((r) => r.json());
    box.innerHTML = games.length ? games.map((g) => `<button data-replay="${g.id}" class="${g.fromClip ? 'clip' : ''}"><span>${g.fromClip ? esc(g.label) : g.id.replace('g_', '') + (g.mock ? ' · ทดสอบ' : '') + (g.humanSeat != null ? ' · มีคนเล่น' : '')}</span><span>${g.winner ? (g.winner === 'wolves' ? 'หมาป่าชนะ' : g.winner === 'village' ? 'ชาวบ้านชนะ' : g.winner) : 'ไม่จบ'} · ${g.durationSec ? Math.round(g.durationSec / 60) + ' นาที' : '-'}</span></button>`).join('') : '<p class="hint">ยังไม่มีเกม</p>';
    box.hidden = false;
    box.onclick = (ev) => { const r = ev.target.closest('[data-replay]'); if (r) enterRoom({ view: $('#replayAudience').checked ? 'audience' : 'god', replay: r.dataset.replay }); };
  }
}

// humanChar: the character id the viewer plays (its seat is shuffled each game), or null
async function startGame(humanChar, view = 'audience') {
  const mock = $('#mockToggle').checked;
  const err = $('#startError');
  err.hidden = true;
  if (!mock && !window.SETUP?.ready()) {
    err.textContent = 'ยังไม่ได้เลือกค่าย AI ที่พร้อมใช้ — กด "ตั้งค่า AI และเสียง" ก่อน (หรือติ๊กโหมดทดสอบเพื่อลองเกมโดยไม่ใช้ AI)';
    err.hidden = false;
    $('#lobbyCast').classList.remove('picking'); $('#pickHint').hidden = true;
    return;
  }
  goFullscreen(); // while the click still counts as a user gesture (fetches below can take a while)
  const leaveFs = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  const opts = { humanChar, mock, ...(window.SETUP ? SETUP.current() : {}) };
  const post = (extra) => fetch('/api/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...opts, ...extra }) });
  let r = await post({});
  if (r.status === 409) {
    if (!(await SETUP.confirm('มีเกมกำลังเล่นอยู่ หยุดเกมนั้นแล้วเริ่มใหม่?'))) { leaveFs(); return; }
    r = await post({ force: true });
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    err.textContent = j.error || 'เริ่มเกมไม่ได้';
    err.hidden = false;
    leaveFs();
    return;
  }
  enterRoom({ view: humanChar == null ? view : 'player' });
}

function goFullscreen() {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}

// ---------------- room ----------------
function enterRoom({ view, seat, replay }) {
  const q = new URLSearchParams();
  q.set('view', view);
  if (seat != null) q.set('seat', seat);
  if (replay) q.set('replay', replay);
  if (S.speed !== 1) q.set('speed', S.speed);
  history.replaceState(null, '', '?' + q.toString());
  $('#lobby').hidden = true;
  $('#room').hidden = false;
  S.view = view; S.replay = replay || null;
  const src = new URLSearchParams({ view });
  if (seat != null) src.set('seat', seat);
  if (replay) src.set('replay', replay);
  if (es) es.close();
  es = new EventSource('/events?' + src.toString());
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  if (replay) es.addEventListener('message', (m) => { if (JSON.parse(m.data).type === 'replay_end') es.close(); });
}

function onEvent(ev) {
  if (ev.type === 'hello') {
    S.seat = ev.seat;
    S.view = ev.view;
    renderViewMode();
    return;
  }
  if (ev.type === 'reset') { location.reload(); return; }
  if (ev.type === 'live' || ev.type === 'replay_end') return;
  if (ev.backlog) { apply(ev, true); return; }
  Q.push(ev);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (Q.length) {
    while (S.paused) await sleep(120);
    const ev = Q.shift();
    try { await apply(ev, false); } catch (e) { console.error(e); }
  }
  pumping = false;
}

const D = (ms) => ms / S.speed; // durations follow the speed setting

async function apply(ev, instant) {
  switch (ev.type) {
    case 'game_init': return buildTable(ev);
    case 'role': return onRole(ev);
    case 'phase': return onPhase(ev, instant);
    case 'narrate': return onNarrate(ev, instant);
    case 'thinking': card(ev.seat)?.classList.add('thinking'); if (!instant) thinkStart[ev.seat] = performance.now(); return;
    case 'thinking_off': card(ev.seat)?.classList.remove('thinking'); return;
    case 'thought': return onBubble(ev, 'thought', instant);
    case 'speech': return onBubble(ev, ev.kind === 'whisper' ? 'whisper' : ev.kind === 'last' ? 'last' : 'speech', instant);
    case 'night_action': return onNightAction(ev, instant);
    case 'saved': log(`หมอช่วย ${nameOf(ev.seat)} ไว้ได้`, 'secret'); return;
    case 'death': return onDeath(ev, instant);
    case 'vote_start': clearVotes(); $('#roundText').textContent = 'โหวต'; return;
    case 'round': $('#roundText').textContent = `คุยรอบ ${ev.r}/${ev.rounds}`; return;
    case 'vote': return onVote(ev, instant);
    case 'vote_result': return onVoteResult(ev, instant);
    case 'note': log(ev.text, 'note'); return;
    case 'ai_error': log('⚠ ' + ev.text, 'note'); if (!instant) toast(ev.text, 7000); return;
    case 'await_human': if (S.view === 'player' && ev.seat === S.seat) showDock(ev); return;
    case 'human_done': hideDock(); return;
    case 'game_over': return onGameOver(ev, instant);
    case 'error': log('ผิดพลาด: ' + ev.message, 'note'); return;
    default: return;
  }
}

function seatData(s) { return S.seats[s]; }
function nameOf(s) { return S.seats[s]?.name ?? '?'; }
function card(s) { return document.querySelector(`.card[data-seat="${s}"]`); }

function renderViewMode() {
  const vm = $('#viewMode');
  if (S.replay) vm.innerHTML = `<b>ดูย้อนหลัง</b>${S.view === 'audience' ? 'มุมมองคนดู' : 'มุมมองพระเจ้า'}`;
  else if (S.view === 'god') vm.innerHTML = `<b>มุมมองพระเจ้า</b>เห็นบททุกคน`;
  else if (S.view === 'audience') vm.innerHTML = `<b>มุมมองคนดู</b>ซ่อนบทจนจบเกม`;
  else vm.innerHTML = `<b>มุมมองผู้เล่น</b>${S.seat != null && S.seats[S.seat] ? 'คุณคือ ' + esc(nameOf(S.seat)) : 'ซ่อนบทคนอื่น'}`;
}

function buildTable(ev) {
  S.seats = ev.seats;
  S.humanSeat = ev.humanSeat;
  S.roles = {}; S.gameOver = false; S.revealed = false; S.reveal = null;
  document.body.classList.remove('revealed');
  $('#endBanner').hidden = true;
  $('#companySummary').innerHTML = '';
  $('#logList').innerHTML = '';
  $('#bubbles').innerHTML = '';
  const mk = (s) => `
    <div class="card" data-seat="${s.seat}" style="--c:${s.color}">
      ${S.view === 'player' && s.seat === S.seat ? '<div class="you">คุณ</div>' : ''}
      <div class="portrait">${avatarSVG(s.id, s.color)}</div>
      <div class="dots"><i></i><i></i><i></i></div>
      <div class="marks"></div>
      <div class="deadmark">${ICON.cross}</div>
      <div class="name">${esc(s.name)}</div>
      <div class="tag">${esc(s.tag)}</div>
      <div class="role"><span class="ri">${ICON.unknown}</span><span class="rt">ไม่รู้บท</span></div>
      <div class="votes"></div>
      <div class="company"></div>
    </div>`;
  $('#rowTop').innerHTML = ev.seats.slice(0, 3).map(mk).join('');
  $('#rowBottom').innerHTML = ev.seats.slice(3).map(mk).join('');
  // show-companies switch: the stamps are on from the first frame (no drumroll at the end)
  S.preShown = !!ev.showCompanies;
  $('#revealBtn').disabled = false;
  if (ev.showCompanies) {
    document.body.classList.add('revealed');
    for (const s of ev.seats) {
      const c = card(s.seat)?.querySelector('.company');
      if (!c || !s.label) continue;
      c.style.color = s.companyColor;
      c.innerHTML = `${esc(s.label)}<small>${esc(s.modelLabel || '')}</small>`;
      c.classList.add('show');
    }
  }
  renderViewMode();
}

function setRole(seat, role) {
  const c = card(seat);
  if (!c) return;
  const r = c.querySelector('.role');
  r.className = 'role ' + role;
  r.querySelector('.ri').innerHTML = ICON[role] || ICON.unknown;
  r.querySelector('.rt').textContent = ROLE_TH[role] || role;
}

function onRole(ev) {
  S.roles[ev.seat] = ev.role;
  setRole(ev.seat, ev.role);
  if (S.view === 'player' && ev.seat === S.seat) {
    S.partners = ev.partners || [];
    log(`บทของคุณ: ${ev.roleTh}${ev.partners?.length ? ' · เพื่อนหมาป่า: ' + ev.partners.join(', ') : ''}`, 'secret');
    // a wolf player also learns the partner's role
    if (ev.role === 'wolf') for (const s of S.seats) if (ev.partners.includes(s.name)) setRole(s.seat, 'wolf');
  }
}

async function onPhase(ev, instant) {
  document.body.classList.toggle('night', ev.phase === 'night');
  document.body.classList.toggle('day', ev.phase === 'day');
  $('#phaseIcon').innerHTML = ev.phase === 'night' ? ICON.moon : ICON.sun;
  $('#phaseText').textContent = `${ev.phase === 'night' ? 'คืน' : 'วัน'}ที่ ${ev.n}`;
  $('#roundText').textContent = '';
  document.querySelectorAll('.marks').forEach((m) => (m.innerHTML = ''));
  if (ev.phase === 'day') clearVotes();
  clearBubbles();
  log(`${ev.phase === 'night' ? 'คืน' : 'วัน'}ที่ ${ev.n}`, 'phase');
  if (!instant) await sleep(D(300));
}

async function onNarrate(ev, instant) {
  const el = $('#narration');
  const status = ev.title ? `${ev.title} · ${ev.sub || ''}` : ev.text;
  log(ev.text, 'mod');
  if (instant) { el.textContent = status; return; }
  if (!ev.big) {
    await typeInto(el, ev.text, 40);
    await sleep(D(900 + ev.text.length * 18));
    return;
  }
  await announce(ev);
  el.textContent = status;
}

// Centred announcement: everything else dims, the text holds, fades, then lives in the top bar.
async function announce(ev) {
  const box = $('#announce');
  const reveal = (ev.cue || '').startsWith('reveal');
  box.querySelector('.a-title').textContent = ev.title;
  const sub = box.querySelector('.a-sub');
  sub.textContent = ev.sub || '';
  sub.classList.toggle('later', reveal);
  box.className = 'cue-' + (ev.cue || 'plain');
  cueSound(ev.cue, 'in');
  box.hidden = false;
  void box.offsetWidth;
  box.classList.add('show');
  if (reveal) { await sleep(D(1500)); sub.classList.remove('later'); cueSound(ev.cue, 'sub'); }
  await sleep(D(2400 + (ev.sub || '').length * 30));
  box.classList.remove('show');
  await sleep(D(500));
  box.hidden = true;
}

function cueSound(cue, step) {
  if (step === 'sub') { sfx(cue); return; }
  switch (cue) {
    case 'start': sfx('start'); break;
    case 'night': sfx('whoosh'); sfx('night'); break; // no cricket loop at night (VreKi 2026-10-18: too annoying)
    case 'morning': loopStop('night_amb'); sfx('morning'); break;
    case 'death': loopStop('night_amb'); sfx('morning'); setTimeout(() => sfx('death'), 700); break;
    case 'vote': sfx('vote'); loopStart('tick_loop'); break;
    case 'tie': loopStop('tick_loop'); sfx('tie'); break;
    case 'eliminate': loopStop('tick_loop'); sfx('eliminate'); break;
    default: sfx('whoosh');
  }
}

function clearBubbles() {
  document.querySelectorAll('.bgroup').forEach((g) => g.remove());
  document.querySelectorAll('.card.speaking').forEach((c) => c.classList.remove('speaking'));
}

function groupFor(seat) {
  let g = document.querySelector(`.bgroup[data-seat="${seat}"]`);
  // only the current speaker keeps bubbles on screen
  document.querySelectorAll('.bgroup').forEach((o) => { if (o !== g) o.remove(); });
  document.querySelectorAll('.card.speaking').forEach((c) => { if (Number(c.dataset.seat) !== seat) c.classList.remove('speaking'); });
  if (g) return g;
  const c = card(seat);
  const table = $('#table').getBoundingClientRect();
  const r = c.getBoundingClientRect();
  g = document.createElement('div');
  g.className = 'bgroup';
  g.dataset.seat = seat;
  g.style.setProperty('--c', seatData(seat).color);
  // comic look: the balloon sits inside the speaker's widened panel, left of the figure, and never leaves it:
  // its height is capped above the name label (app.css shrinks long text and the text scrolls as it types)
  const pad = window.innerHeight * 0.018;
  const w = Math.max(r.width * 0.6, window.innerWidth * 0.24);
  const gmax = r.height - pad - window.innerHeight * 0.1;
  g.style.width = w + 'px';
  g.style.maxHeight = gmax + 'px';
  g.style.setProperty('--gmax', gmax + 'px');
  g.style.left = Math.min(r.left - table.left + pad + window.innerWidth * 0.011, table.width - w - 8) + 'px';
  g.style.top = (r.top - table.top + pad) + 'px';
  $('#bubbles').appendChild(g);
  return g;
}

const PANEL_MS = 840; // speaker panel widening time (app.css detail-expand 820ms) before the balloon is placed
async function onBubble(ev, kind, instant) {
  const s = ev.seat;
  const who = nameOf(s);
  const label = kind === 'thought' && ev.kind === 'vote' ? 'เหตุผลที่โหวต' : { thought: 'คิดในใจ', whisper: 'กระซิบเพื่อนหมาป่า', last: 'คำสั่งเสีย', speech: '' }[kind];
  log(kind === 'thought' ? `<span class="n" style="--c:${seatData(s).color}">${esc(who)}</span> คิด: ${esc(ev.text)}` : `<span class="n" style="--c:${seatData(s).color}">${esc(who)}</span>${label ? ' (' + label + ')' : ''}: ${esc(ev.text)}`, kind === 'thought' ? 'thought' : kind === 'whisper' ? 'secret' : '', true);
  if (instant) return;
  if (kind === 'speech' || kind === 'last') {
    const since = performance.now() - (thinkStart[s] ?? -1e9);
    if (since < D(MIN_THINK)) await sleep(D(MIN_THINK) - since);
  }
  // comic look: widen the speaker's panel first (app.css .card.speaking, 820ms), then place the balloon in it
  const pc = card(s);
  if (pc && !pc.classList.contains('speaking')) {
    clearBubbles();
    pc.classList.add('speaking');
    await sleep(PANEL_MS);
  }
  const g = groupFor(s);
  card(s)?.classList.add('speaking');
  const b = document.createElement('div');
  b.className = `bubble ${kind === 'last' ? 'speech last' : kind}`;
  // long text: app.css shrinks the font by length and squares off the balloon
  const len = graphemes(ev.text).length;
  b.style.setProperty('--len', len);
  if (len > 220) b.classList.add('long');
  b.innerHTML = `<div class="who">${esc(who)}${label ? ' · ' + label : ''}</div><div class="txt"></div>`;
  if (kind !== 'thought') g.querySelectorAll('.bubble.thought .txt').forEach((t) => { t.classList.remove('scrolled'); t.scrollTop = 0; });
  if (kind === 'thought') g.prepend(b); else g.appendChild(b);
  // the character speaks: text types along with the voice, then holds a moment
  if (kind !== 'thought' && ev.audio && ev.audioSec && !muted) {
    const voice = new Audio(ev.audio);
    voice.playbackRate = Math.min(2, S.speed);
    const ended = new Promise((r) => { voice.onended = r; voice.onerror = r; setTimeout(r, D(ev.audioSec * 1000 + 1500)); });
    voice.play().catch(() => {});
    await typeInto(b.querySelector('.txt'), ev.text, graphemes(ev.text).length / Math.max(1, ev.audioSec * 0.85));
    await ended;
    await sleep(D(1200));
    return;
  }
  if (kind !== 'thought') sfx('pop');
  await typeInto(b.querySelector('.txt'), ev.text, kind === 'thought' ? 40 : 30);
  const hold = kind === 'thought' ? 1200 + ev.text.length * 35 : 2000 + ev.text.length * 55;
  await sleep(D(hold));
}

async function typeInto(el, text, gps) {
  const gs = graphemes(text);
  el.textContent = '';
  const step = Math.max(1, Math.round((gps * S.speed) / 40)); // ~40 frames per second
  for (let i = 0; i < gs.length; i += step) {
    el.textContent = gs.slice(0, i + step).join('');
    // a balloon taller than its panel scrolls along with the typing (app.css .bubble .txt)
    if (el.scrollHeight > el.clientHeight + 1) { el.scrollTop = el.scrollHeight; el.classList.add('scrolled'); }
    await sleep(1000 / Math.min(40, gps * S.speed));
    while (S.paused) await sleep(120);
  }
  el.textContent = text;
}

async function onNightAction(ev, instant) {
  const who = nameOf(ev.seat);
  const icon = { kill: ICON.claw, see: ICON.seer, protect: ICON.shield }[ev.action];
  const c = card(ev.target);
  if (c) {
    const m = document.createElement('div');
    m.className = 'mark ' + ev.action;
    m.innerHTML = icon;
    c.querySelector('.marks').appendChild(m);
  }
  const text = ev.action === 'kill' ? `${who} อยากกัด ${ev.targetName}`
    : ev.action === 'see' ? `${who} (หมอดู) ส่อง ${ev.targetName} → ${ev.result === 'wolf' ? 'หมาป่า!' : 'ไม่ใช่หมาป่า'}`
    : `${who} (หมอ) ปกป้อง ${ev.targetName}`;
  log(text, 'secret');
  // the human seer keeps what they learned on the card
  if (S.view === 'player' && ev.seat === S.seat && ev.action === 'see' && c && !c.classList.contains('dead')) {
    const r = c.querySelector('.role');
    r.className = 'role ' + (ev.result === 'wolf' ? 'wolf' : 'villager');
    r.querySelector('.ri').innerHTML = ev.result === 'wolf' ? ICON.wolf : ICON.seer;
    r.querySelector('.rt').textContent = ev.result === 'wolf' ? 'หมาป่า (ส่องแล้ว)' : 'ไม่ใช่หมาป่า';
  }
  if (!instant) await sleep(D(900));
}

async function onDeath(ev, instant) {
  const c = card(ev.seat);
  if (c) { c.classList.add('dead'); c.classList.remove('thinking', 'speaking'); }
  setRole(ev.seat, ev.role);
  log(`${nameOf(ev.seat)} ตาย${ev.cause === 'vote' ? ' (ถูกโหวตออก)' : ''} · บท ${ev.roleTh}`, 'mod');
  if (!instant) await sleep(D(1100));
}

function clearVotes() { document.querySelectorAll('.votes').forEach((v) => (v.innerHTML = '')); document.querySelectorAll('.eliminated').forEach((c) => c.classList.remove('eliminated')); }

async function onVote(ev, instant) {
  const c = card(ev.target);
  if (c) {
    const chip = document.createElement('div');
    chip.className = 'vchip';
    chip.style.setProperty('--c', seatData(ev.seat).color);
    chip.title = nameOf(ev.seat);
    // the voter's small face in a ring of their colour (VreKi: a letter alone was hard to read)
    if (window.faceSVG) chip.innerHTML = faceSVG(seatData(ev.seat).id, seatData(ev.seat).color);
    else chip.textContent = graphemes(nameOf(ev.seat).replace(/^(ป้า|ลุง|น้อง|ครู|เจ๊)/, ''))[0];
    c.querySelector('.votes').appendChild(chip);
  }
  log(`${nameOf(ev.seat)} โหวต ${ev.targetName}`, 'vote');
  if (!instant) { sfx('vote_chip'); await sleep(D(900)); }
}

async function onVoteResult(ev, instant) {
  if (ev.eliminated != null) card(ev.eliminated)?.classList.add('eliminated');
  if (!instant) await sleep(D(1200));
}

// ---------------- end + company reveal ----------------
async function onGameOver(ev, instant) {
  S.gameOver = true;
  S.reveal = ev.reveal;
  clearBubbles();
  stopAllLoops();
  const w = $('#winnerText');
  w.textContent = ev.winner === 'wolves' ? 'หมาป่าชนะ!' : ev.winner === 'village' ? 'ชาวบ้านชนะ!' : ev.text;
  w.className = 'winner ' + ev.winner;
  const wolves = ev.reveal.filter((r) => r.role === 'wolf').map((r) => r.name).join(' กับ ');
  $('#endSub').textContent = `หมาป่าคือ ${wolves} · เล่นไป ${Math.floor(ev.durationSec / 60)} นาที ${ev.durationSec % 60} วินาที`;
  $('#narration').textContent = ev.text;
  log(ev.text, 'phase');
  if (instant) { for (const r of ev.reveal) setRole(r.seat, r.role); $('#endBanner').hidden = false; return; }
  sfx(ev.winner === 'wolves' ? 'win_wolves' : 'win_village');
  $('#endBanner').hidden = false;
  await sleep(D(1500));
  // roles flip one by one — the audience checks their guesses
  for (const r of ev.reveal) {
    const known = card(r.seat).querySelector('.role').classList.contains(r.role);
    setRole(r.seat, r.role);
    if (!known) { sfx('role_card'); card(r.seat).classList.add('flip'); await sleep(D(700)); }
  }
}

async function revealCompanies() {
  if (!S.gameOver || S.revealed || !S.reveal) return;
  S.revealed = true;
  $('#revealBtn').disabled = true;
  document.body.classList.add('revealed');
  if (!S.preShown) { sfx('drumroll'); await sleep(D(2600)); }
  for (const r of S.preShown ? [] : S.reveal) {
    sfx('reveal_card');
    const c = card(r.seat).querySelector('.company');
    c.style.color = r.companyColor;
    c.innerHTML = `${esc(r.label)}<small>${esc(r.modelLabel)}${r.replacedProvider ? '' : ''}</small>`;
    c.classList.add('show');
    await sleep(D(900));
  }
  const groups = {};
  for (const r of S.reveal) (groups[r.label] ||= { color: r.companyColor, model: r.modelLabel, list: [] }).list.push(`${r.name} (${r.roleTh}${r.alive ? '' : ' · ตาย'})`);
  const box = $('#companySummary');
  box.innerHTML = Object.entries(groups).map(([label, g]) => `<div class="csum" style="--cc:${g.color}"><b>${esc(label)}</b>${g.list.map(esc).join('<br>')}</div>`).join('');
  box.style.gridTemplateColumns = `repeat(${Object.keys(groups).length}, 1fr)`;
  for (const el of box.children) { el.classList.add('show'); await sleep(D(400)); }
}

// ---------------- human dock ----------------
let dockState = null;
function showDock(ev) {
  dockState = { token: ev.token, kind: ev.kind, target: null, needText: ev.needText, options: ev.options };
  $('#dockPrompt').textContent = ev.prompt;
  $('#dockHint').textContent = ev.hint || '';
  $('#dockError').textContent = '';
  const opt = $('#dockOptions');
  opt.innerHTML = ev.options.map((o) => `<button data-seat="${o.seat}" style="--c:${seatData(o.seat).color}">${esc(o.name)}</button>`).join('');
  opt.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    dockState.target = Number(b.dataset.seat);
    opt.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
    if (!dockState.needText) sendDock();
  };
  const ta = $('#dockText');
  ta.value = '';
  ta.parentElement.hidden = !ev.needText;
  ta.placeholder = ev.kind === 'wolf' ? 'กระซิบเพื่อนหมาป่า (ไม่บังคับ) แล้วเลือกเหยื่อ' : 'พิมพ์ภาษาไทยได้เลย · Enter = ส่ง · Shift+Enter = ขึ้นบรรทัด';
  $('#humanDock').hidden = false;
  sfx('human_turn');
  if (ev.needText) setTimeout(() => ta.focus(), 50);
}
function hideDock() { $('#humanDock').hidden = true; dockState = null; }
async function sendDock() {
  if (!dockState) return;
  const text = $('#dockText').value.trim();
  if ((dockState.kind === 'speak' || dockState.kind === 'last') && !text) { $('#dockError').textContent = 'พิมพ์อะไรสักหน่อยก่อนส่ง'; return; }
  if (dockState.options.length && dockState.target == null) { $('#dockError').textContent = 'เลือกชื่อก่อน'; return; }
  const r = await fetch('/api/human', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: dockState.token, text, target: dockState.target }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#dockError').textContent = j.error || 'ส่งไม่ได้'; return; }
  hideDock();
}
$('#dockSend').addEventListener('click', sendDock);
$('#dockText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendDock(); }
});

// ---------------- log ----------------
function log(html, cls = '', isHtml = false) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  if (isHtml) li.innerHTML = html; else li.textContent = html;
  const list = $('#logList');
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}

// ---------------- keys ----------------
function toast(t, ms = 1200) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), ms); }
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'f' || e.key === 'F') { if (document.fullscreenElement) document.exitFullscreen(); else goFullscreen(); }
  if (e.key === ' ') { e.preventDefault(); S.paused = !S.paused; toast(S.paused ? 'หยุดชั่วคราว' : 'เล่นต่อ'); }
  if (e.key === ']') { S.speed = Math.min(4, +(S.speed + 0.25).toFixed(2)); toast(`ความเร็ว ${S.speed}x`); }
  if (e.key === '[') { S.speed = Math.max(0.5, +(S.speed - 0.25).toFixed(2)); toast(`ความเร็ว ${S.speed}x`); }
  if (e.key === 'h' || e.key === 'H') $('#stage').classList.toggle('nolog');
  if (e.key === 'r' || e.key === 'R') revealCompanies();
  if (e.key === 'm' || e.key === 'M') { muted = !muted; if (muted) stopAllLoops(); toast(muted ? 'ปิดเสียง' : 'เปิดเสียง'); }
});
$('#revealBtn').addEventListener('click', revealCompanies);
$('#lobbyBtn').addEventListener('click', () => { location.href = '/'; });

// ---------------- boot ----------------
if (params.get('view') || params.get('replay')) {
  enterRoom({ view: params.get('view') || 'god', seat: params.has('seat') ? Number(params.get('seat')) : undefined, replay: params.get('replay') });
} else {
  initLobby();
}
