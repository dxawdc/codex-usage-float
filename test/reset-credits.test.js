const test = require('node:test');
const assert = require('node:assert/strict');
const { createResetCreditRedeemer, reconcileResetCredit, requestIdForCredit } = require('../src/lib/reset-credits');

const local = { accountKey: 'account-a', accountId: 'account-id', accessToken: 'test-only' };
const request = { accountKey: 'account-a', creditId: 'credit-1' };
function harness({ readLocalAuth = async () => local, status = 'available', expiresAt, post } = {}) {
  const calls = [];
  const redeem = createResetCreditRedeemer({
    readLocalAuth,
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') return post ? post() : { ok: true, json: { code: 'reset' } };
      return { ok: true, json: { credits: [{ id: 'credit-1', status, expires_at: expiresAt }] } };
    }
  });
  return { redeem, calls };
}

test('uses verified card ID and account headers with a stable redemption request', async () => {
  const { redeem, calls } = harness();
  assert.equal((await redeem(request)).code, 'reset');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
  assert.equal(calls[1].options.headers['ChatGPT-Account-Id'], local.accountId);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    credit_id: request.creditId, redeem_request_id: requestIdForCredit(request.accountKey, request.creditId)
  });
  assert.match(requestIdForCredit('account-a', 'credit-1'), /^[a-f0-9-]{36}$/);
  assert.notEqual(requestIdForCredit('account-a', 'credit-1'), requestIdForCredit('account-b', 'credit-1'));
  assert.notEqual(requestIdForCredit('account-a', 'credit-1'), requestIdForCredit('account-a', 'credit-2'));
});

test('rejects invalid identifiers, stale accounts, unavailable and expired cards before posting', async () => {
  const invalid = harness();
  await assert.rejects(invalid.redeem({ ...request, creditId: '../card' }), /标识无效/);
  assert.equal(invalid.calls.length, 0);
  for (const options of [
    { readLocalAuth: async () => ({ ...local, accountKey: 'account-b' }) },
    { status: 'expired' },
    { expiresAt: '2020-01-01T00:00:00Z' }
  ]) {
    const { redeem, calls } = harness(options);
    await assert.rejects(redeem(request));
    assert.equal(calls.filter((item) => item.options.method === 'POST').length, 0);
  }
  let reads = 0;
  const changed = harness({ readLocalAuth: async () => ++reads === 1 ? local : { ...local, accountKey: 'account-b' } });
  await assert.rejects(changed.redeem(request), /账号已变化/);
  assert.equal(changed.calls.length, 1);
});

test('concurrent clicks cannot submit two consumptions', async () => {
  let finish;
  const { redeem, calls } = harness({ post: () => new Promise((resolve) => { finish = resolve; }) });
  const first = redeem(request);
  await assert.rejects(redeem(request), /重复提交/);
  await new Promise((resolve) => setImmediate(resolve));
  finish({ ok: true, json: { code: 'reset' } });
  await first;
  assert.equal(calls.filter((item) => item.options.method === 'POST').length, 1);
});

test('timeout and restarted-app retries retain the same idempotency key', async () => {
  const first = harness({ post: () => { throw new Error('timeout'); } });
  await assert.rejects(first.redeem(request), /无法确认/);
  const restarted = harness();
  await restarted.redeem(request);
  assert.equal(first.calls[1].options.body, restarted.calls[1].options.body);
  await assert.rejects(first.redeem(request), /无法确认/);
  assert.equal(first.calls[1].options.body, first.calls[3].options.body);
});

test('already redeemed responses do not claim a new reset and unknown outcomes fail closed', async () => {
  const redeemed = harness({ status: 'redeemed' });
  assert.equal((await redeemed.redeem(request)).code, 'already_redeemed');
  assert.equal(redeemed.calls.length, 1);
  const replay = harness({ post: () => ({ ok: true, json: { code: 'already_redeemed' } }) });
  assert.equal((await replay.redeem(request)).code, 'already_redeemed');
  for (const response of [
    { ok: true, json: { code: 'no_reset_needed' } },
    { ok: true, json: null },
    { ok: false, status: 500, json: { code: 'reset' } },
    { ok: false, status: 401, json: { error: 'token_revoked' } }
  ]) {
    await assert.rejects(harness({ post: () => response }).redeem(request));
  }
});

test('uses freshly rotated credentials for the same account after card validation', async () => {
  let reads = 0;
  const { redeem, calls } = harness({ readLocalAuth: async () => ++reads === 1 ? local : { ...local, accessToken: 'rotated-test-token' } });
  await redeem(request);
  assert.equal(calls[1].options.headers.authorization, 'Bearer rotated-test-token');
});

test('a confirmed redemption stays successful when reading auth or refreshing state fails', async () => {
  for (const code of ['reset', 'already_redeemed']) {
    const result = await reconcileResetCredit({ code, ...request }, async () => { throw new Error('refresh failed'); });
    assert.equal(result.code, code);
    assert.equal(result.refreshPending, true);
    assert.match(result.message, /已使用|使用成功/);
    assert.match(result.message, /手动刷新/);
  }
  const result = await reconcileResetCredit({ code: 'reset', ...request }, async (value, message) => ({ ...value, message, snapshot: { resetCards: [] } }));
  assert.deepEqual(result.snapshot.resetCards, []);
});
