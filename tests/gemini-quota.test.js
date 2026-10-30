'use strict';
// A new free Gemini key (AQ. format, 2026-10-30) on a paid-only model gets HTTP 429 with
// "limit: 0" far down a long message. The "Test" button must say "switch to Flash",
// not "quota full, wait for the reset" — waiting never helps a limit of 0.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.VREKI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-gq-'));
const P = require('../app/paths');
const { testProvider } = require('../app/detect');

// Google's reply, 2026-10-30, free-tier key + gemini-4-argon (shape kept, links shortened)
const GOOGLE_429 = {
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota, please check your plan and billing details. '
      + 'For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. '
      + 'To monitor your current usage, head to: https://ai.dev/rate-limit. \n'
      + '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, '
      + 'limit: 0, model: gemini-4-argon, description: Generate content requests per day limit exceeded on Free Tier.',
  },
};

test('free key on a paid-only model: the test button says switch to Flash', async (t) => {
  P.ensureDataDirs();
  fs.writeFileSync(P.GEMINI_KEY_FILE, 'AQ.test-key-not-real');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(GOOGLE_429), { status: 429, headers: { 'Content-Type': 'application/json' } });
  t.after(() => { globalThis.fetch = realFetch; });

  const config = JSON.parse(fs.readFileSync(path.join(P.APP, 'config.default.json'), 'utf8'));
  const r = await testProvider('gemini', config, {});

  assert.equal(r.ok, false);
  assert.match(r.message, /คีย์ฟรี.*Flash/);
});
