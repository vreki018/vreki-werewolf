'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { explainError } = require('../app/detect');

const cases = [
  ['claude', 'not found', /ยังไม่ได้ติดตั้ง Claude Code/],
  ['claude', 'Invalid API key · Please run /login', /ยังไม่ได้ล็อกอิน Claude Code.*claude/],
  ['claude', 'OAuth token has expired. Please obtain a new token or run /login', /ยังไม่ได้ล็อกอิน/],
  ['codex', '{"type":"error","message":"unexpected status 401 Unauthorized"}', /ยังไม่ได้ล็อกอิน Codex.*codex login/],
  ['codex', 'model gpt-6.1-sol is not supported when using Codex with a ChatGPT account', /ใช้รุ่น.*ไม่ได้/],
  ['claude', 'There\'s an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it.', /ใช้รุ่น.*ไม่ได้/],
  ['codex', 'You\'ve hit your usage limit. Try again in 3 hours.', /โควต้าเต็ม/],
  ['gemini', 'HTTP 429: Resource has been exhausted (e.g. check quota).', /โควต้าเต็ม/],
  ['gemini', 'HTTP 400: API key not valid. Please pass a valid API key.', /คีย์ Gemini ใช้ไม่ได้/],
  ['gemini', 'no key file', /ยังไม่มีคีย์ Gemini/],
  ['claude', 'timeout', /ตอบช้าเกินไป/],
  // seen 2026-10-28 with an npm install from before Opus 5.5
  ['claude', "API Error: 400 Claude Code 2.1.136 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.", /เวอร์ชันเก่า.*claude update/],
];

for (const [prov, err, re] of cases) {
  test(`explainError ${prov}: ${err.slice(0, 40)}`, () => assert.match(explainError(prov, err), re));
}

test('explainError keeps an unknown error short', () => {
  const out = explainError('claude', 'x'.repeat(500));
  assert.ok(out.length <= 160, out.length);
});
