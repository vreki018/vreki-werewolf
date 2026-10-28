// setup.js — the lobby's "ตั้งค่า AI และเสียง" card: which companies play, their models,
// connection tests, the Gemini key, the voice mode and the show-companies switch.
// Every change is saved to the server (data/settings.json); app.js reads SETUP.current()
// when a game starts.
'use strict';

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const IDS = ['claude', 'codex', 'gemini'];
  const NAME = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini' };
  const HOW = { claude: 'ผ่าน Claude Code (แพ็ก Claude)', codex: 'ผ่าน Codex (บัญชี ChatGPT)', gemini: 'ผ่านคีย์ API ของ Gemini' };
  const VOICE_TH = { off: 'ปิดเสียง', free: 'เสียงฟรี', gemini: 'เสียง Gemini' };

  let info = null;      // last /api/setup answer
  let settings = null;  // what is saved
  const tests = {};     // id → { ok, message } from the last "ทดสอบ"
  let saveTimer = null;
  let pending = {};

  function save(patch, now = false) {
    Object.assign(pending, patch);
    if (patch.models) pending.models = { ...(pending.models || {}), ...patch.models };
    clearTimeout(saveTimer);
    const go = async () => {
      const body = pending; pending = {};
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => null);
      if (r?.settings) settings = r.settings;
      renderStrip();
      return r;
    };
    if (now) return go();
    saveTimer = setTimeout(go, 400);
    return null;
  }

  async function load(refresh) {
    info = await fetch('/api/setup' + (refresh ? '?refresh=1' : '')).then((r) => r.json()).catch(() => null);
    if (!info) { $('#stripSeats').textContent = 'ติดต่อเกมไม่ได้ — ลองเปิด start.bat ใหม่'; return; }
    settings = info.settings;
    // first visit: tick every company that is ready
    if (!settings.providers.length) {
      const ready = IDS.filter((id) => info.detect[id].ready);
      if (ready.length) { settings.providers = ready; await save({ providers: ready }, true); }
    }
    $('#showCompanies').checked = !!settings.showCompanies;
    renderStrip();
    if (!$('#setup').hidden) renderCard();
  }

  function picked() { return (settings?.providers || []).filter((id) => info?.detect[id]?.ready); }

  function split(ids) {
    const out = {};
    ids.forEach((id, i) => { out[id] = Math.floor(6 / ids.length) + (i < 6 % ids.length ? 1 : 0); });
    return out;
  }
  function seatText(ids) {
    if (!ids.length) return 'ยังไม่ได้เลือกค่าย AI';
    return 'ที่นั่ง: ' + Object.entries(split(ids)).map(([id, n]) => `${NAME[id]} ${n}`).join(' · ');
  }
  function voiceNow() {
    const want = settings?.voice || 'free';
    const order = ['gemini', 'free', 'off'];
    for (const m of order.slice(order.indexOf(want))) if (info?.voiceModes?.[m]) return m;
    return 'off';
  }

  function renderStrip() {
    if (!info || !settings) return;
    const ids = picked();
    $('#stripSeats').textContent = seatText(ids);
    $('#stripSeats').classList.toggle('warn', !ids.length);
    const v = voiceNow();
    $('#stripVoice').textContent = `เสียง: ${VOICE_TH[v]}${v !== settings.voice ? ` (เลือก${VOICE_TH[settings.voice]}ไว้ แต่ยังใช้ไม่ได้)` : ''}`;
  }

  function chip(id) {
    const d = info.detect[id];
    const t = tests[id];
    if (!d.ready) return `<span class="chip bad">${id === 'gemini' ? 'ยังไม่มีคีย์' : 'ยังไม่ได้ติดตั้ง'}</span>`;
    if (t) return `<span class="chip ${t.ok ? 'good' : 'bad'}">${t.ok ? 'ใช้ได้' : 'มีปัญหา'}</span>`;
    return '<span class="chip">พร้อม</span>';
  }

  function renderCard() {
    const rows = IDS.map((id) => {
      const d = info.detect[id];
      const on = settings.providers.includes(id) && d.ready;
      const t = tests[id];
      const msg = t ? t.message : (d.ready ? '' : (id === 'gemini' ? 'ยังไม่มีคีย์ — วางคีย์ Gemini ด้านล่างแล้วกดบันทึก (ไม่บังคับ)' : d.reason || ''));
      const key = id === 'gemini' ? `
        <div class="key-row">
          <input type="password" id="geminiKey" placeholder="${d.ready ? 'มีคีย์แล้ว · วางคีย์ใหม่เพื่อเปลี่ยน' : 'วางคีย์ Gemini (aistudio.google.com)'}" autocomplete="off" spellcheck="false">
          <button class="btn" data-act="save-key">บันทึกคีย์</button>
          ${d.ready ? '<button class="link" data-act="del-key">ลบคีย์</button>' : ''}
        </div>` : '';
      return `
      <div class="prov-row ${d.ready ? '' : 'off'}" data-id="${id}" style="--cc:${esc(info.labels[id].color)}">
        <label class="check prov-pick"><input type="checkbox" data-pick="${id}" ${on ? 'checked' : ''} ${d.ready ? '' : 'disabled'}>
          <b>${NAME[id]}</b><small>${HOW[id]}</small></label>
        ${chip(id)}
        <label class="model">รุ่น <input type="text" data-model="${id}" value="${esc(settings.models[id])}" spellcheck="false"></label>
        <button class="btn" data-test="${id}" ${d.ready ? '' : 'disabled'}>ทดสอบ</button>
        <p class="prov-msg ${t && !t.ok ? 'bad' : ''}">${esc(msg)}</p>
        ${key}
      </div>`;
    }).join('');
    $('#provRows').innerHTML = rows;
    $('#seatLine').textContent = seatText(picked());
    const used = voiceNow(); // the mode a game would really get
    for (const r of document.querySelectorAll('input[name="voice"]')) {
      r.checked = r.value === used;
      r.disabled = !info.voiceModes[r.value];
    }
    const notes = [];
    if (!info.voiceModes.free) notes.push(info.detect.python.reason || 'เสียงฟรีต้องใช้ Python + edge-tts');
    if (!info.voiceModes.gemini) notes.push(!info.detect.gemini.ready ? 'เสียง Gemini ต้องใส่คีย์ Gemini ก่อน' : (!info.detect.ffmpeg.ready ? 'เสียง Gemini ต้องติดตั้ง ffmpeg' : ''));
    notes.push('เสียง Gemini มีปัญหาบรรทัดไหน จะใช้เสียงฟรีแทนบรรทัดนั้น');
    $('#voiceNote').textContent = notes.filter(Boolean).join(' · ');
  }

  function openSetup() { $('#setup').hidden = false; renderCard(); }
  function closeSetup() { $('#setup').hidden = true; renderStrip(); }

  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    const act = a?.dataset.act;
    if (act === 'open-setup') openSetup();
    if (act === 'close-setup') { await save({}, true); closeSetup(); }
    if (act === 'recheck') { a.disabled = true; await load(true); a.disabled = false; }
    if (act === 'save-key') {
      const k = $('#geminiKey').value.trim();
      if (!k) return;
      await save({ geminiKey: k }, true);
      delete tests.gemini;
      await load(true);
    }
    if (act === 'del-key') {
      if (!(await SETUP.confirm('ลบคีย์ Gemini ออกจากเครื่องนี้?'))) return;
      await save({ geminiKey: null }, true);
      delete tests.gemini;
      await load(true);
    }
    if (act === 'shutdown') {
      if (!(await SETUP.confirm('ปิดเกม? (เกมที่เล่นอยู่จะหยุด)'))) return;
      await fetch('/api/shutdown', { method: 'POST' }).catch(() => {});
      $('#closedNote').hidden = false;
    }
    const t = e.target.closest('[data-test]');
    if (t) {
      const id = t.dataset.test;
      t.disabled = true; t.textContent = 'กำลังทดสอบ…';
      await save({}, true);
      const r = await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id }) }).then((x) => x.json()).catch(() => ({ ok: false, message: 'ติดต่อเกมไม่ได้' }));
      tests[id] = r;
      renderCard();
    }
  });

  document.addEventListener('change', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const ids = IDS.filter((id) => document.querySelector(`[data-pick="${id}"]`)?.checked);
      settings.providers = ids;
      $('#seatLine').textContent = seatText(picked());
      save({ providers: ids });
    }
    const m = e.target.closest('[data-model]');
    if (m && m.value.trim()) { delete tests[m.dataset.model]; save({ models: { [m.dataset.model]: m.value.trim() } }); }
    if (e.target.name === 'voice') { settings.voice = e.target.value; save({ voice: e.target.value }); }
    if (e.target.id === 'showCompanies') { settings.showCompanies = e.target.checked; save({ showCompanies: e.target.checked }); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#setup').hidden) closeSetup();
    if (e.key === 'Enter' && e.target.id === 'geminiKey') document.querySelector('[data-act="save-key"]')?.click();
  });

  window.SETUP = {
    // what the next game uses
    current() {
      return { providers: picked(), voice: settings?.voice || 'free', showCompanies: $('#showCompanies').checked };
    },
    ready() { return picked().length > 0; },
    open: openSetup,
    // centred card on a dimmed page instead of the browser's confirm()
    confirm(text) {
      return new Promise((resolve) => {
        const box = $('#confirmBox');
        $('#confirmText').textContent = text;
        box.hidden = false;
        box.onclick = (e) => {
          const b = e.target.closest('[data-confirm]');
          if (!b) return;
          box.hidden = true;
          resolve(b.dataset.confirm === 'yes');
        };
      });
    },
  };

  if (!(new URLSearchParams(location.search).get('view') || new URLSearchParams(location.search).get('replay'))) load(false);
})();
