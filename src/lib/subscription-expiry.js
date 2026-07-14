const DEFAULT_SUBSCRIPTION_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SUBSCRIPTION_NEAR_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_SUBSCRIPTION_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const CHATGPT_SUBSCRIPTIONS_URL = 'https://chatgpt.com/backend-api/subscriptions';
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function normalizeIsoDate(value) {
  if (!value) return null;
  const date = typeof value === 'number' && value < 100000000000 ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isPaidPlan(planTier) {
  return /plus|pro|team|enterprise|business/i.test(String(planTier || ''));
}

function isStaleMembershipExpiresAt(planTier, value, now = new Date()) {
  const normalized = normalizeIsoDate(value);
  return Boolean(normalized && isPaidPlan(planTier) && new Date(normalized).getTime() <= now.getTime());
}

function firstFreshMembershipExpiresAt(planTier, ...values) {
  let now = new Date();
  const lastValue = values[values.length - 1];
  if (lastValue && typeof lastValue === 'object' && !(lastValue instanceof Date) && lastValue.now) {
    values.pop();
    now = lastValue.now instanceof Date ? lastValue.now : new Date(lastValue.now);
  }
  for (const value of values) {
    const normalized = normalizeIsoDate(value);
    if (!normalized) continue;
    if (!isStaleMembershipExpiresAt(planTier, normalized, now)) return normalized;
  }
  return null;
}

function resolveSubscriptionAccountId(local) {
  const value = String(local?.accountId || '').trim();
  if (!value || /^user-/i.test(value)) return null;
  return value;
}

function shouldProbeSubscription(local, previous = {}, now = new Date(), options = {}) {
  const planTier = previous.planTier || local?.planTier || null;
  if (!local?.accessToken || !resolveSubscriptionAccountId(local) || !isPaidPlan(planTier)) return false;

  const probeIntervalMs = options.probeIntervalMs ?? DEFAULT_SUBSCRIPTION_PROBE_INTERVAL_MS;
  const nearExpiryMs = options.nearExpiryMs ?? DEFAULT_SUBSCRIPTION_NEAR_EXPIRY_MS;
  const rawExpiresAt = normalizeIsoDate(previous.membershipExpiresAt || local.membershipExpiresAt);
  if (rawExpiresAt && isStaleMembershipExpiresAt(planTier, rawExpiresAt, now)) return true;

  const lastCheckedAt = normalizeIsoDate(previous.subscriptionLastCheckedAt || local.subscriptionLastCheckedAt);
  if (lastCheckedAt && now.getTime() - new Date(lastCheckedAt).getTime() < probeIntervalMs) return false;

  const freshExpiresAt = firstFreshMembershipExpiresAt(planTier, previous.membershipExpiresAt, local.membershipExpiresAt, { now });
  if (!freshExpiresAt) return true;
  return new Date(freshExpiresAt).getTime() - now.getTime() <= nearExpiryMs;
}

function requestSubscriptionJson(electronNet, url, headers, timeoutMs, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    const request = electronNet.request({ method: 'GET', url, redirect: 'follow' });
    let settled = false;
    const chunks = [];
    let totalBytes = 0;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        // Ignore abort races; the rejection below is the user-facing outcome.
      }
      finish(reject, new Error('subscriptions request timed out'));
    }, timeoutMs);

    for (const [key, value] of Object.entries(headers)) {
      if (value) request.setHeader(key, value);
    }

    request.on('response', (response) => {
      response.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes <= maxResponseBytes) chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        finish(resolve, {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          statusCode: response.statusCode,
          json
        });
      });
      response.on('error', (error) => finish(reject, error));
    });
    request.on('error', (error) => finish(reject, error));
    request.end();
  });
}

async function fetchSubscriptionSnapshot(electronNet, local, options = {}) {
  const accountId = resolveSubscriptionAccountId(local);
  if (!electronNet?.request || !local?.accessToken || !accountId) return null;
  const url = `${options.url || CHATGPT_SUBSCRIPTIONS_URL}?account_id=${encodeURIComponent(accountId)}`;
  const response = await requestSubscriptionJson(
    electronNet,
    url,
    {
      authorization: `Bearer ${local.accessToken}`,
      accept: 'application/json',
      origin: 'https://chatgpt.com',
      referer: 'https://chatgpt.com/',
      'user-agent': options.userAgent || CHROME_USER_AGENT
    },
    options.timeoutMs ?? DEFAULT_SUBSCRIPTION_TIMEOUT_MS,
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  );
  if (!response.ok || !response.json || typeof response.json !== 'object') return null;
  return {
    planTier: typeof response.json.plan_type === 'string' ? response.json.plan_type : null,
    membershipExpiresAt: normalizeIsoDate(response.json.active_until),
    subscriptionWillRenew: typeof response.json.will_renew === 'boolean' ? response.json.will_renew : null
  };
}

async function maybeFetchSubscriptionSnapshot(electronNet, local, previous = {}, options = {}) {
  const now = options.now || new Date();
  if (!shouldProbeSubscription(local, previous, now, options)) return null;
  const checkedAt = now.toISOString();
  try {
    const snapshot = await fetchSubscriptionSnapshot(electronNet, local, options);
    return {
      ...(snapshot || {}),
      subscriptionLastCheckedAt: checkedAt
    };
  } catch {
    return { subscriptionLastCheckedAt: checkedAt };
  }
}

module.exports = {
  firstFreshMembershipExpiresAt,
  isPaidPlan,
  isStaleMembershipExpiresAt,
  maybeFetchSubscriptionSnapshot,
  normalizeIsoDate,
  resolveSubscriptionAccountId,
  shouldProbeSubscription
};
