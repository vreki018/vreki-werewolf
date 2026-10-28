// stt.js — push-to-talk transcription for the human seat. Keeps one `stt.py --serve`
// worker (faster-whisper large-v3 on the GPU, model loaded once) and turns one WAV clip
// into Thai text. Started on first need (a game with a human seat, or the player page
// asking), then stays loaded so every later clip is fast.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

class Stt {
  // cfg: { python, script, model, timeoutSec }
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.w = null;
    this.nextId = 0;
  }

  start() {
    if (this.w && !this.w.dead) return this.w;
    const w = { pending: new Map(), buf: '', dead: false, ready: false, error: null, t0: Date.now(), loadMs: null };
    const args = ['-I', this.cfg.script, '--serve'];
    if (this.cfg.model) args.push('--model', this.cfg.model);
    w.proc = spawn(this.cfg.python, args, {
      cwd: path.dirname(this.cfg.script), windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    w.proc.stdout.on('data', (d) => {
      w.buf += d.toString('utf8');
      let k;
      while ((k = w.buf.indexOf('\n')) >= 0) {
        const line = w.buf.slice(0, k).trim();
        w.buf = w.buf.slice(k + 1);
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch (_) { continue; }
        if ('ready' in r) {
          w.ready = !!r.ready; w.error = r.error || null; w.loadMs = Date.now() - w.t0;
          this.log(`stt worker ${r.ready ? 'ready' : 'FAILED'} ${r.model || ''} load ${r.load_ms} ms warm ${r.warm_ms} ms (total ${w.loadMs} ms) ${r.error || ''}`);
          continue;
        }
        const p = w.pending.get(r.id);
        if (p) { w.pending.delete(r.id); p(r); }
      }
    });
    // faster-whisper / ctranslate2 print warnings on stderr; keep them short in the log
    w.proc.stderr.on('data', (d) => { const t = String(d).trim(); if (t && !/Warning|warn\(/.test(t)) this.log(`stt worker: ${t.slice(0, 200)}`); });
    const die = (why) => {
      if (w.dead) return;
      w.dead = true;
      if (!w.error) w.error = why;
      for (const p of w.pending.values()) p({ ok: false, error: why });
      w.pending.clear();
      this.log(`stt worker gone: ${why}`);
    };
    w.proc.on('exit', (code) => die(`worker exited ${code}`));
    w.proc.on('error', (e) => die(String(e)));
    this.w = w;
    this.log(`stt worker starting (${this.cfg.model || 'large-v3'})`);
    return w;
  }

  status() {
    const w = this.w;
    if (!w) return { state: 'off' };
    if (w.dead) return { state: 'error', error: w.error };
    if (!w.ready) return { state: w.error ? 'error' : 'loading', error: w.error, sinceMs: Date.now() - w.t0 };
    return { state: 'ready', loadMs: w.loadMs, model: this.cfg.model || 'large-v3' };
  }

  // → { ok, text, stt_ms, audio_sec, ..., ms } ; never rejects
  transcribe(wav) {
    const w = this.start();
    const id = `s${++this.nextId}`;
    // a clip sent while the model is still loading waits for it (first load ~10 s)
    const timeoutMs = ((this.cfg.timeoutSec || 40) + (w.ready ? 0 : 60)) * 1000;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setTimeout(() => { w.pending.delete(id); resolve({ ok: false, error: 'timeout', ms: Date.now() - t0 }); }, timeoutMs);
      w.pending.set(id, (r) => { clearTimeout(timer); resolve({ ...r, ms: Date.now() - t0 }); });
      try {
        w.proc.stdin.write(JSON.stringify({ id, wav }) + '\n');
      } catch (e) {
        clearTimeout(timer); w.pending.delete(id); resolve({ ok: false, error: String(e) });
      }
    });
  }

  close() { if (this.w) try { this.w.proc.kill(); } catch (_) {} }
}

module.exports = { Stt };
