const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createTokenLogCache, readLogRange } = require('../src/lib/token-log-cache');

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

test('retains historical events for lifetime totals', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-cache-lifetime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old-session.jsonl');
  const oldTimestamp = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(file, `${event(42, oldTimestamp)}\n`);

  const cache = createCache();
  const result = await cache.loadTokenLogs([file]);
  assert.equal(result.logs[0].events.length, 1);
  assert.equal(result.logs[0].events[0].delta.totalTokens, 42);
});

test('bounds native reads for ranges larger than 2 GiB and tracks short reads', async (t) => {
  let closed = false;
  let calls = 0;
  const positions = [];
  t.mock.method(fs, 'open', async () => ({
    async read(buffer, offset, length, position) {
      assert.ok(buffer.length <= 256 * 1024);
      assert.ok(length <= 256 * 1024);
      assert.equal(offset, 0);
      positions.push(position);
      calls += 1;
      if (calls > 2) return { bytesRead: 0 };
      buffer.write('abc');
      return { bytesRead: 3 };
    },
    async close() { closed = true; }
  }));
  const chunks = [];
  assert.equal(await readLogRange('virtual.jsonl', 0, 3 * 1024 ** 3, (chunk) => chunks.push(chunk.toString())), 6);
  assert.deepEqual(positions, [0, 3, 6]);
  assert.deepEqual(chunks, ['abc', 'abc']);
  assert.equal(closed, true);

  calls = 0;
  positions.length = 0;
  const start = 2 ** 31 + 100;
  assert.equal(await readLogRange('virtual.jsonl', start, start + 100, () => {}), start + 6);
  assert.deepEqual(positions, [start, start + 3, start + 6]);
});

test('preserves UTF-8 and CRLF across chunk boundaries and incomplete appends', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-chunks-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const model = '中文模型';
  const context = Buffer.from(JSON.stringify({ type: 'turn_context', payload: { model } }));
  const split = context.indexOf(Buffer.from(model)) + 1;
  const padding = Buffer.from(' '.repeat(256 * 1024 - split - 1) + '\n');
  const now = new Date().toISOString();
  const content = Buffer.concat([padding, context, Buffer.from(`\r\n${event(10, now)}\r\n`)]);
  await fs.writeFile(file, content);
  const cache = createCache();
  const first = await cache.loadTokenLogs([file]);
  assert.equal(first.logs[0].events[0].model, model);

  await fs.appendFile(file, context.subarray(0, split));
  const partial = await cache.loadTokenLogs([file]);
  assert.equal(partial.logs[0].events.length, 1);
  await fs.appendFile(file, Buffer.concat([context.subarray(split), Buffer.from(`\n${event(25, now)}\n`)]));
  const complete = await cache.loadTokenLogs([file]);
  assert.deepEqual(complete.logs[0].events.map((item) => item.delta.totalTokens), [10, 15]);
  assert.equal(complete.logs[0].events[1].model, model);
});

test('bounds unterminated oversized lines and resumes at the next newline', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-long-line-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const now = new Date().toISOString();
  await fs.writeFile(file, `${event(10, now)}\n`);
  await fs.appendFile(file, Buffer.alloc(9 * 1024 * 1024, 120));
  const cache = createCache();
  const first = await cache.loadTokenLogs([file]);
  assert.equal(first.skippedLineCount, 0, 'unfinished lines are not counted as corrupt');
  assert.equal(first.logs[0].offset, Buffer.byteLength(`${event(10, now)}\n`));
  assert.equal(first.logs[0].tail, undefined, 'large incomplete lines are not retained in memory');
  await fs.appendFile(file, `still too long\n${event(25, now)}\n`);
  const second = await cache.loadTokenLogs([file]);
  assert.equal(second.skippedLineCount, 1);
  assert.deepEqual(second.logs[0].events.map((item) => item.delta.totalTokens), [10, 15]);
  const unchanged = await cache.loadTokenLogs([file]);
  assert.equal(unchanged.logs[0].events.length, 2);
});

test('projects oversized context and usage records without losing late fields', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-projection-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const now = new Date().toISOString();
  const unrelated = '图片内容\\"🙂'.repeat(700000);
  const context = { payload: { developer_instructions: unrelated, model: '中文模型' }, type: 'turn_context' };
  const usage = JSON.parse(event(42, now));
  usage.payload.info.other = Array.from({ length: 120000 }, () => ({ text: 'ignored', total_tokens: 9999 }));
  await fs.writeFile(file, `${JSON.stringify(context)}\n${JSON.stringify(usage)}\n`);
  const result = await createCache().loadTokenLogs([file]);
  assert.equal(result.skippedLineCount, 0);
  assert.equal(result.projectedLineCount, 2);
  assert.equal(result.logs[0].events.length, 1);
  assert.equal(result.logs[0].events[0].model, '中文模型');
  assert.equal(result.logs[0].events[0].delta.totalTokens, 42);
  assert.equal(result.logs[0].events[0].eventAccountKey, 'hash:account-a');
});

test('oversized incomplete records and failed reads can resume without duplicate events', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-projection-append-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const now = new Date().toISOString();
  const record = JSON.stringify({ padding: 'x'.repeat(1024 * 1024), ...JSON.parse(event(25, now)) });
  await fs.writeFile(file, `${event(10, now)}\n${record.slice(0, -3)}`);
  const cache = createCache();
  assert.equal((await cache.loadTokenLogs([file])).logs[0].events.length, 1);
  await fs.appendFile(file, `${record.slice(-3)}\n`);
  const second = await cache.loadTokenLogs([file]);
  assert.deepEqual(second.logs[0].events.map((item) => item.delta.totalTokens), [10, 15]);
  assert.equal(second.projectedLineCount, 1);
  assert.equal((await cache.loadTokenLogs([file])).logs[0].events.length, 2);
});

test('oversized unrelated nested fields never masquerade as real usage', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-projection-nested-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const now = new Date().toISOString();
  const nested = JSON.parse(event(9999, now));
  await fs.writeFile(file, `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(300000), nested } })}\n${event(10, now)}\n`);
  const result = await createCache().loadTokenLogs([file]);
  assert.equal(result.skippedLineCount, 0);
  assert.equal(result.projectedLineCount, 1);
  assert.deepEqual(result.logs[0].events.map((item) => item.delta.totalTokens), [10]);
});

test('failed append reads retry atomically without losing or duplicating events', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-retry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const now = new Date().toISOString();
  await fs.writeFile(file, `${event(10, now)}\n`);
  const cache = createCache();
  await cache.loadTokenLogs([file]);
  await fs.appendFile(file, `${event(25, now)}\n${' '.repeat(256 * 1024)}\n${event(40, now)}\n`);
  const realOpen = fs.open;
  let closed = false;
  const mock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await realOpen(...args);
    let reads = 0;
    return {
      async read(...readArgs) {
        if (++reads === 2) throw new Error('simulated disk failure');
        return handle.read(...readArgs);
      },
      async close() { closed = true; await handle.close(); }
    };
  });
  const failed = await cache.loadTokenLogs([file]);
  assert.equal(failed.failedFileCount, 1);
  assert.equal(failed.logs[0].stale, true);
  assert.deepEqual(failed.logs[0].events.map((item) => item.delta.totalTokens), [10]);
  assert.equal(closed, true);
  mock.mock.restore();
  const retried = await cache.loadTokenLogs([file]);
  assert.deepEqual(retried.logs[0].events.map((item) => item.delta.totalTokens), [10, 15, 15]);
});

test('concurrent refreshes serialize and truncated files reset the cache', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-log-reset-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const now = new Date().toISOString();
  await fs.writeFile(file, `${event(10, now)}\n${event(25, now)}\n`);
  const cache = createCache();
  const results = await Promise.all([cache.loadTokenLogs([file]), cache.loadTokenLogs([file])]);
  for (const result of results) assert.equal(result.logs[0].events.length, 2);
  await fs.writeFile(file, `${event(5, now)}\n`);
  const reset = await cache.loadTokenLogs([file]);
  assert.deepEqual(reset.logs[0].events.map((item) => item.delta.totalTokens), [5]);
});
