// launch.js — what start.bat runs. If the game is already open on this PC, just
// opens the browser on it; otherwise starts the server on the first free port
// (7766 … 7775) and opens the browser. Closing this window closes the game.
//   node app/launch.js            normal start
//   node app/launch.js --selftest plays one test-mode game (no AI calls) to the end, exit 0 = ok
//   VREKI_NO_BROWSER=1            do not open a browser (tests)
'use strict';
const { execFile } = require('child_process');

const BASE = Number(process.env.VREKI_PORT) || 7766;
const PORTS = Array.from({ length: 10 }, (_, i) => BASE + i);

async function probe(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j && j.app === 'vreki-werewolf';
  } catch (_) { return false; }
}

function openBrowser(url) {
  if (process.env.VREKI_NO_BROWSER) return;
  // explorer hands an http URL to the default browser; no cmd.exe involved
  execFile('explorer.exe', [url], { windowsHide: true }, () => {});
}

// one test-mode game on a free port, then exit (INSTALL-FOR-AI.md runs this)
async function selftest() {
  process.env.VREKI_QUIET = '1';
  const { start, portTaken } = require('./server');
  let s = null;
  for (const port of PORTS) {
    try { s = await start(port); break; } catch (e) { if (!portTaken(e)) throw e; }
  }
  if (!s) { console.log('เช็คไม่ผ่าน: ไม่มี port ว่าง'); return 1; }
  const base = `http://127.0.0.1:${s.port}`;
  const r = await fetch(`${base}/api/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mock: true, force: true, mockDelay: 10 }) });
  if (!r.ok) { console.log(`เช็คไม่ผ่าน: เริ่มเกมทดสอบไม่ได้ (${r.status})`); s.close(); return 1; }
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await new Promise((res) => setTimeout(res, 500));
    const st = await fetch(`${base}/api/status`).then((x) => x.json());
    if (st.summary?.winner) {
      console.log(`เช็คผ่าน: เกมทดสอบเล่นจนจบ (${st.summary.winner === 'wolves' ? 'หมาป่าชนะ' : 'ชาวบ้านชนะ'}) ใน ${Math.round((Date.now() - t0) / 1000)} วินาที`);
      s.close();
      return 0;
    }
  }
  console.log('เช็คไม่ผ่าน: เกมทดสอบไม่จบใน 2 นาที');
  s.close();
  return 1;
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  for (const port of PORTS) {
    if (await probe(port)) {
      const url = `http://localhost:${port}/`;
      console.log(`เกมเปิดอยู่แล้วที่ ${url} — เปิดหน้าเว็บให้แล้ว`);
      openBrowser(url);
      return 0;
    }
  }
  const { start, portTaken } = require('./server');
  for (const port of PORTS) {
    try {
      const s = await start(port);
      const url = `http://localhost:${s.port}/`;
      console.log('');
      console.log(`  หมู่บ้านหมาป่า เปิดอยู่ที่ ${url}`);
      console.log('  ปิดหน้าต่างนี้ = ปิดเกม');
      console.log('');
      openBrowser(url);
      return null; // keep running
    } catch (e) {
      if (!portTaken(e)) throw e;
    }
  }
  console.log(`เปิดเกมไม่ได้: port ${PORTS[0]}–${PORTS[PORTS.length - 1]} ถูกโปรแกรมอื่นใช้อยู่หมด`);
  return 1;
}

main().then((code) => { if (code != null) process.exit(code); }, (e) => { console.error(e); process.exit(1); });
