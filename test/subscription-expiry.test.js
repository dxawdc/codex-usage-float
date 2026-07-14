const test = require('node:test');
const assert = require('node:assert/strict');
const {
  firstFreshMembershipExpiresAt,
  isPaidPlan,
  resolveSubscriptionAccountId,
  shouldProbeSubscription
} = require('../src/lib/subscription-expiry');

test('paid plan stale membership expiry is not reused', () => {
  const now = new Date('2026-07-14T00:00:00.000Z');
  assert.equal(
    firstFreshMembershipExpiresAt('plus', '2026-07-10T13:37:34.000Z', { now }),
    null
  );
  assert.equal(
    firstFreshMembershipExpiresAt('plus', '2026-07-10T13:37:34.000Z', '2026-08-10T13:37:34.000Z', { now }),
    '2026-08-10T13:37:34.000Z'
  );
  assert.equal(
    shouldProbeSubscription(
      {
        accessToken: 'token',
        accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        planTier: 'plus',
        membershipExpiresAt: '2026-07-10T13:37:34.000Z',
        subscriptionLastCheckedAt: '2026-07-13T23:59:00.000Z'
      },
      {},
      now
    ),
    true
  );
});

test('subscription probe is limited to paid workspace accounts and throttled', () => {
  const now = new Date('2026-07-14T00:00:00.000Z');
  const paidAccount = {
    accessToken: 'token',
    accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    planTier: 'plus',
    membershipExpiresAt: '2026-08-10T13:37:34.000Z'
  };

  assert.equal(isPaidPlan('plus'), true);
  assert.equal(isPaidPlan('free'), false);
  assert.equal(resolveSubscriptionAccountId({ accountId: 'user-123' }), null);
  assert.equal(resolveSubscriptionAccountId(paidAccount), paidAccount.accountId);
  assert.equal(shouldProbeSubscription({ ...paidAccount, planTier: 'free' }, {}, now), false);
  assert.equal(shouldProbeSubscription(paidAccount, {}, now), false);
  assert.equal(
    shouldProbeSubscription(
      paidAccount,
      { subscriptionLastCheckedAt: '2026-07-13T23:00:00.000Z' },
      now,
      { nearExpiryMs: 365 * 24 * 60 * 60 * 1000 }
    ),
    false
  );
});

test('subscription probe only watches normal future expiry inside three days', () => {
  const now = new Date('2026-07-14T00:00:00.000Z');
  const paidAccount = {
    accessToken: 'token',
    accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    planTier: 'plus'
  };

  assert.equal(
    shouldProbeSubscription(
      { ...paidAccount, membershipExpiresAt: '2026-07-18T00:00:00.000Z' },
      {},
      now
    ),
    false
  );
  assert.equal(
    shouldProbeSubscription(
      { ...paidAccount, membershipExpiresAt: '2026-07-17T00:00:00.000Z' },
      {},
      now
    ),
    true
  );
});
