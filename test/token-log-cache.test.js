const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createTokenLogCache } = require('../src/lib/token-log-cache');

function totals(value = {}) {
  return { totalTokens: Number(value.total_tokens) || 0 };
}

function createCache() {
  return createTokenLogCache({
    emptyTokenTotals: () => ({ totalTokens: 0 }),
    normalizeTokenModel: (value) => value || 'unknown',
    parseTokenTotals: (value) => value ? totals(value) : null,
    subtractTokenTotals: (current, previous) => ({ totalTokens: Math.max(0, current.totalTokens - previous.totalTokens) }),
    hasTokenTotals: (value) => value.totalTokens > 0,
    rateLimitFingerprint: (value) => value ? String(value) : null,
    identityKey: (value) => value ? `hash:${value}` : null
  });
}

function event(total, timestamp) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: total } },
      rate_limits: { account_id: 'account-a', secondary: { resets_at: 'reset-a' } }
    }
  });
}

test('reads only appended JSONL data without duplicating cached events', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const now = new Date().toISOString();
  await fs.writeFile(file, `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test' } })}\n${event(10, now)}\n`);

  const cache = createCache();
  const first = await cache.loadTokenLogs([file]);
  assert.equal(first.logs[0].events.length, 1);
  assert.equal(first.logs[0].events[0].delta.totalTokens, 10);
  assert.equal(first.logs[0].events[0].model, 'gpt-test');

  await fs.appendFile(file, `${event(25, new Date(Date.now() + 1000).toISOString())}\n`);
  const second = await cache.loadTokenLogs([file]);
  assert.equal(second.logs[0].events.length, 2);
  assert.deepEqual(second.logs[0].events.map((item) => item.delta.totalTokens), [10, 15]);
  assert.equal(second.logs[0].events[1].eventAccountKey, 'hash:account-a');
});
