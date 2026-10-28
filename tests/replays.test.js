'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.VREKI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-rep-'));
const { start } = require('../app/server');

let base, srv;
test.before(async () => { srv = await start(0); base = `http://127.0.0.1:${srv.port}`; });
test.after(() => srv.close());

// read an SSE stream until replay_end (or a timeout) → list of events
async function sse(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  const r = await fetch(base + url, { signal: ctl.signal });
  const evs = [];
  let buf = '';
  const dec = new TextDecoder();
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        evs.push(ev);
        if (ev.type === 'replay_end' || ev.type === 'error') { ctl.abort(); clearTimeout(t); return evs; }
      }
    }
  } catch (_) {}
  clearTimeout(t);
  return evs;
}

test('a fresh install lists the two games from the clip', async () => {
  const games = await fetch(base + '/api/games').then((r) => r.json());
  const clip = games.filter((g) => g.fromClip);
  assert.deepStrictEqual(clip.map((g) => g.id).sort(), ['g_20261019_172136', 'g_20261019_173400']);
  for (const g of clip) assert.match(g.label, /^จากคลิป VreKi_ · /);
});

test('a clip game replays to the end in audience view, with its voice files', async () => {
  const evs = await sse('/events?replay=g_20261019_172136&view=audience');
  assert.ok(evs.some((e) => e.type === 'game_over'));
  const withAudio = evs.find((e) => e.audio);
  assert.ok(withAudio, 'some speech has a voice file');
  const r = await fetch(base + withAudio.audio);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'audio/mpeg');
  assert.ok((await r.arrayBuffer()).byteLength > 1000);
});

test('a bad replay id is refused', async () => {
  const evs = await sse('/events?replay=..%2F..%2Fx&view=audience');
  assert.strictEqual(evs.find((e) => e.type === 'error')?.message, 'bad id');
});
