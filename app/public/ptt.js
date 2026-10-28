// ptt.js — push-to-talk for the human seat (player view). Hold Space (a short tap still
// types a space), hold the mic button, or hold a mouse side button → the mic clip goes to
// /api/stt (faster-whisper large-v3 on this PC) → the Thai text lands in the dock's text
// box to glance at, fix, and send with Enter. Typing keeps working as before.
// Loaded after app.js; reads its globals S and dockState, and watches #humanDock instead
// of changing app.js. The mic stays open while in player view so a press starts at once,
// and the last PRE_ROLL seconds before the press are kept (the first syllable is not lost).
'use strict';
(() => {
  const PRE_ROLL = 0.35;   // s of audio kept from just before the press
  const POST_ROLL = 220;   // ms still recorded after the release (end of the last word)
  const HOLD_MS = 220;     // Space held this long = talk; a shorter tap types a space
  const MIN_SEC = 0.45;    // shorter clips are dropped (an accidental press)
  const MAX_SEC = 90;

  const dock = document.getElementById('humanDock');
  const ta = document.getElementById('dockText');
  const row = ta.parentElement;
  const sendBtn = document.getElementById('dockSend');

  // ---- UI: mic button next to "ส่ง" + one status line under the row ----
  const mic = document.createElement('button');
  mic.type = 'button';
  mic.id = 'dockMic';
  mic.className = 'btn mic';
  mic.hidden = true; // shown once /api/stt/status says the mic is on for this game
  mic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="2.5" width="7" height="12" rx="3.5"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5v3.5M8.5 22h7"/></svg><span class="mic-lbl">กดค้างพูด</span><i class="mic-lvl"></i>';
  row.insertBefore(mic, sendBtn);
  const status = document.createElement('div');
  status.id = 'dockMicStatus';
  status.className = 'mic-status';
  row.insertAdjacentElement('afterend', status);

  const IDLE_TEXT = 'กดค้าง Space หรือปุ่มไมค์ แล้วพูด · ปล่อย = แปลงเป็นข้อความ · แก้ได้ แล้ว Enter ส่ง';
  function setState(state, text) {
    dock.classList.toggle('ptt-rec', state === 'rec');
    dock.classList.toggle('ptt-busy', state === 'busy');
    status.dataset.state = state;
    status.textContent = text ?? (state === 'idle' ? IDLE_TEXT : '');
  }

  // ---- mic: getUserMedia → AudioWorklet tap → Float32 frames on this thread ----
  let ctx = null, stream = null, rate = 16000, micErr = null, starting = null;
  let ring = [], ringLen = 0;          // pre-roll while not recording
  let rec = null;                      // { frames, len, t0, via, token, gameId }
  let level = 0;
  const WORKLET = `class PttTap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
      return true;
    }
  }
  registerProcessor('ptt-tap', PttTap);`;

  function onFrame(f) {
    let s = 0;
    for (let i = 0; i < f.length; i += 4) s += f[i] * f[i];
    level = Math.min(1, Math.sqrt(s / (f.length / 4)) * 6);
    if (rec) {
      rec.frames.push(f); rec.len += f.length;
      mic.style.setProperty('--lvl', level.toFixed(2));
      if (rec.len > MAX_SEC * rate) stopRec('max');
    } else {
      ring.push(f); ringLen += f.length;
      while (ring.length > 1 && ringLen - ring[0].length >= PRE_ROLL * rate) ringLen -= ring.shift().length;
    }
  }

  function initMic() {
    if (ctx && ctx.state !== 'closed') return Promise.resolve(true);
    if (starting) return starting;
    starting = (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        try { ctx = new AudioContext({ sampleRate: 16000 }); } catch (_) { ctx = new AudioContext(); }
        rate = ctx.sampleRate;
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        const src = ctx.createMediaStreamSource(stream);
        const tap = new AudioWorkletNode(ctx, 'ptt-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        tap.port.onmessage = (m) => onFrame(m.data);
        const mute = ctx.createGain(); mute.gain.value = 0;
        src.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
        stream.getAudioTracks()[0].addEventListener('ended', () => { micErr = 'ไมค์หลุด (ถอดสาย?) — เสียบใหม่แล้วรีเฟรชหน้า'; setState('error', micErr); });
        micErr = null;
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        return true;
      } catch (e) {
        micErr = e && e.name === 'NotAllowedError' ? 'เบราว์เซอร์ยังไม่อนุญาตไมค์ — กดไอคอนไมค์ที่แถบที่อยู่ แล้วเลือกอนุญาต (หรือพิมพ์แทน)'
          : e && e.name === 'NotFoundError' ? 'ไม่เจอไมค์ในเครื่อง' : 'เปิดไมค์ไม่ได้: ' + (e && e.message || e);
        ctx = null;
        return false;
      } finally { starting = null; }
    })();
    return starting;
  }

  // ---- record / stop / send ----
  const active = () => !dock.hidden && !row.hidden && typeof dockState !== 'undefined' && dockState && S.view === 'player' && !S.replay;

  async function startRec(via) {
    if (rec || !active()) return;
    const ok = await initMic();
    if (!ok) { setState('error', micErr); return; }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    rec = { frames: ring.slice(), len: ringLen, t0: performance.now(), via, token: dockState.token, stopping: false };
    if (turn && turn.token === rec.token && turn.firstPress == null) turn.firstPress = Math.round(rec.t0 - turn.shownAt);
    ring = []; ringLen = 0;
    mic.querySelector('.mic-lbl').textContent = 'ปล่อย = หยุด';
    setState('rec', '● กำลังฟัง… ปล่อยเพื่อหยุด (Esc = ยกเลิก)');
  }

  let chain = Promise.resolve();   // results land in the box in the order they were spoken
  function stopRec(why) {
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    const tRelease = performance.now();
    setTimeout(() => {
      const r = rec; rec = null;
      mic.style.setProperty('--lvl', 0);
      mic.querySelector('.mic-lbl').textContent = 'กดค้างพูด';
      if (!r) return;
      const heldMs = Math.round(tRelease - r.t0);
      const pcm = concat(r.frames, r.len);
      if (why === 'cancel') { setState('idle'); return; }
      if (pcm.length < MIN_SEC * rate) { setState('idle', 'สั้นไป ไม่ได้ส่ง — กดค้างไว้ตลอดตอนพูด'); return; }
      const wav = toWav(pcm, rate);
      setState('busy', 'กำลังแปลงเสียง…');
      const job = fetch('/api/stt?token=' + encodeURIComponent(r.token), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav })
        .then((res) => res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status })))
        .catch((e) => ({ ok: false, error: String(e) }));
      chain = chain.then(() => job).then((j) => {
        if (!dockState || dockState.token !== r.token) return; // turn already over
        if (!j.ok) { setState('error', 'แปลงเสียงไม่ได้ (' + (j.error || '?') + ') — พิมพ์แทนได้ หรือกดพูดใหม่'); return; }
        if (!j.text) { setState('idle', 'ไม่ได้ยินคำพูด — ลองพูดใกล้ไมค์ขึ้น หรือกดค้างนานขึ้น'); return; }
        insertText(j.text);
        if (turn && turn.token === r.token) turn.clips++;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const ms = Math.round(performance.now() - tRelease);
          setState('done', `ได้ข้อความแล้ว ${(ms / 1000).toFixed(1)} วิ · แก้ได้ · Enter = ส่ง · กดค้างพูดต่อได้`);
          window.__pttLast = { n: j.n, releaseToScreenMs: ms, heldMs, sttMs: j.stt_ms, serverMs: j.server_ms, audioSec: j.audio_sec, text: j.text };
        }));
      });
    }, why === 'cancel' ? 0 : POST_ROLL);
  }

  function concat(frames, len) {
    const out = new Float32Array(len); let o = 0;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  }
  function toWav(f, sr) {
    const buf = new ArrayBuffer(44 + f.length * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + f.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, f.length * 2, true);
    for (let i = 0; i < f.length; i++) { const x = Math.max(-1, Math.min(1, f[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }
  function insertText(t) {
    const cur = ta.value;
    ta.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + t;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.scrollTop = ta.scrollHeight;
  }
  // the box grows with the text (up to ~8 lines) so a whole spoken turn can be read at a glance
  function fit() {
    ta.style.height = '';
    if (!ta.value) return;
    const cs = getComputedStyle(ta);
    const pad = cs.boxSizing === 'border-box' ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) : -(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
    const h = Math.min(ta.scrollHeight + pad, innerHeight * 0.26);
    if (h > ta.getBoundingClientRect().height) ta.style.height = h + 'px';
  }
  ta.addEventListener('input', fit);
  function typeSpace() {
    if (document.activeElement !== ta) return;
    if (!document.execCommand('insertText', false, ' ')) ta.setRangeText(' ', ta.selectionStart, ta.selectionEnd, 'end');
  }

  // ---- keys: Space hold = talk, tap = space. Capture phase, so app.js never sees it (no pause toggle) ----
  let spaceDown = false, holdTimer = null;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') {
      // another key while Space is still down (fast typing): it was a tap → type the space first
      if (spaceDown && holdTimer) { clearTimeout(holdTimer); holdTimer = null; typeSpace(); spaceDown = 'typed'; }
      if (e.key === 'Escape' && rec) { e.preventDefault(); stopRec('cancel'); }
      return;
    }
    if (!active() || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat || spaceDown) return;
    spaceDown = true;
    initMic();
    holdTimer = setTimeout(() => { holdTimer = null; startRec('space'); }, HOLD_MS);
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !spaceDown) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const was = spaceDown; spaceDown = false;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; typeSpace(); } else if (was === true) stopRec('key');
  }, true);

  // ---- mic button (hold) + mouse side buttons (hold; their back/forward navigation is blocked here) ----
  mic.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); mic.setPointerCapture(e.pointerId); startRec('button'); });
  mic.addEventListener('pointerup', () => stopRec('button'));
  mic.addEventListener('pointercancel', () => stopRec('button'));
  const side = (e) => e.button === 3 || e.button === 4;
  window.addEventListener('mousedown', (e) => { if (side(e) && active()) { e.preventDefault(); startRec('side'); } }, true);
  window.addEventListener('mouseup', (e) => { if (side(e) && (active() || rec)) { e.preventDefault(); stopRec('side'); } }, true);
  window.addEventListener('auxclick', (e) => { if (side(e) && active()) e.preventDefault(); }, true);
  window.addEventListener('blur', () => { if (rec) stopRec('blur'); spaceDown = false; if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } });

  // ---- follow the dock (app.js shows/hides it) and the view ----
  // the current text turn (counts how many clips went into it)
  let turn = null;
  function endTurn() { turn = null; }
  new MutationObserver(() => {
    if (dock.hidden) { if (rec) stopRec('cancel'); ta.style.height = ''; endTurn(); return; }
    if (row.hidden) return;
    ta.style.height = '';
    endTurn();
    if (dockState) turn = { token: dockState.token, kind: dockState.kind, shownAt: performance.now(), firstPress: null, clips: 0 };
    ta.placeholder = (dockState && dockState.kind === 'wolf' ? 'กระซิบเพื่อนหมาป่า (ไม่บังคับ) แล้วเลือกเหยื่อ' : 'พูด (กดค้าง Space) หรือพิมพ์ภาษาไทย')
      + ' · Enter = ส่ง · Shift+Enter = ขึ้นบรรทัด';
    initMic().then((ok) => setState(ok ? 'idle' : 'error', ok ? undefined : micErr));
    sttStatus();
  }).observe(dock, { attributes: true, attributeFilter: ['hidden'] });

  // entering player view: open the mic (first time = Chrome asks once) and load whisper on the server
  let warmed = false;
  setInterval(() => {
    if (warmed || S.view !== 'player' || S.replay || document.getElementById('room').hidden) return;
    warmed = true;
    initMic();
    sttStatus(true);
  }, 500);
  async function sttStatus(warm) {
    const st = await fetch('/api/stt/status' + (warm ? '?warm=1' : '')).then((r) => r.json()).catch(() => null);
    if (!st || dock.hidden || rec) return;
    mic.hidden = st.state === 'disabled';
    if (st.state === 'disabled') {
      // mic off in the setup card, or this PC cannot run it (NVIDIA only): typing only
      setState('off', '');
      ta.placeholder = 'พิมพ์ภาษาไทยได้เลย · Enter = ส่ง · Shift+Enter = ขึ้นบรรทัด';
    } else if (st.state === 'loading' && status.dataset.state === 'idle') setState('idle', 'กำลังโหลดตัวแปลงเสียง (ครั้งแรก ~10 วิ) — กดพูดได้เลย จะรอให้');
    else if (st.state === 'error') setState('error', 'ตัวแปลงเสียงเปิดไม่ได้ — พิมพ์แทนได้ (' + (st.error || '') + ')');
  }
  // close and reopen the mic (a replugged mic; tests use it to restart Chrome's fake-mic file at 0 s)
  async function reopen() {
    if (rec) stopRec('cancel');
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { ctx && await ctx.close(); } catch (_) {}
    ctx = null; stream = null; ring = []; ringLen = 0;
    return initMic();
  }
  window.__ptt = { initMic, reopen, state: () => ({ ctx: ctx && ctx.state, rate, micErr, rec: !!rec, level }) };
})();
