// voice.js — character voices. Keeps `tts.py --serve` workers running (Edge neural
// TTS, see tts_voices.json) and turns one spoken line into an mp3 next to the game log.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

class Voice {
  // cfg: { python, script, workers, timeoutSec, env } — env: key file / usage log / ffmpeg for tts.py
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.workers = [];
    this.nextId = 0;
    for (let i = 0; i < (cfg.workers || 2); i++) this.workers.push(this.spawnWorker(i));
  }

  spawnWorker(i) {
    const w = { i, pending: new Map(), buf: '', dead: false };
    w.proc = spawn(this.cfg.python, [this.cfg.script, '--serve'], {
      cwd: path.dirname(this.cfg.script), windowsHide: true,
      env: { ...process.env, ...(this.cfg.env || {}), PYTHONIOENCODING: 'utf-8' },
    });
    w.proc.stdout.on('data', (d) => {
      w.buf += d.toString('utf8');
      let k;
      while ((k = w.buf.indexOf('\n')) >= 0) {
        const line = w.buf.slice(0, k).trim();
        w.buf = w.buf.slice(k + 1);
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        const p = w.pending.get(r.id);
        if (p) { w.pending.delete(r.id); p(r); }
      }
    });
    w.proc.stderr.on('data', (d) => this.log(`tts worker ${i}: ${String(d).trim().slice(0, 200)}`));
    const die = () => {
      if (w.dead) return;
      w.dead = true;
      for (const p of w.pending.values()) p({ ok: false, error: 'worker exited' });
      w.pending.clear();
    };
    w.proc.on('exit', die);
    w.proc.on('error', (e) => { this.log(`tts worker ${i} error ${e}`); die(); });
    return w;
  }

  pick() {
    this.workers = this.workers.map((w) => (w.dead ? this.spawnWorker(w.i) : w));
    return this.workers.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
  }

  // overrides: tts.py per-call keys, e.g. { engine: 'edge' } for the free voice
  // → { ok, out, duration_sec, synth_ms, ... } ; never rejects
  say(char, text, out, overrides = {}) {
    const w = this.pick();
    const id = `v${++this.nextId}`;
    const split = text.length > 60;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setTimeout(() => { w.pending.delete(id); resolve({ ok: false, error: 'timeout', ms: Date.now() - t0 }); }, (this.cfg.timeoutSec || 20) * 1000);
      w.pending.set(id, (r) => { clearTimeout(timer); resolve({ ...r, ms: Date.now() - t0 }); });
      try {
        w.proc.stdin.write(JSON.stringify({ ...overrides, id, char, text, out, split }) + '\n');
      } catch (e) {
        clearTimeout(timer); w.pending.delete(id); resolve({ ok: false, error: String(e) });
      }
    });
  }

  close() { for (const w of this.workers) try { w.proc.kill(); } catch (_) {} }
}

module.exports = { Voice };
