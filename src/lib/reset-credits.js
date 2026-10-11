const crypto = require('node:crypto');
const { throwForAuthFailure } = require('./usage-http');

const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

function validIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
}

function requestIdForCredit(accountKey, creditId) {
  // A credit can be consumed once. Keep its request ID stable even after a
  // timeout, dialog reopen, or application restart.
  const bytes = crypto.createHash('sha1')
    .update('codex-usage-float/reset-credit/v1\0').update(accountKey).update('\0').update(creditId)
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createResetCreditRedeemer({ fetchJson, readLocalAuth }) {
  let busy = false;
  return async function redeem({ accountKey, creditId } = {}) {
    if (!validIdentifier(accountKey) || !validIdentifier(creditId)) throw new Error('账号或重置卡标识无效，请刷新后重试');
    if (busy) throw new Error('正在使用重置卡，请勿重复提交');
    busy = true;
    try {
      const local = await readLocalAuth();
      if (local.accountKey !== accountKey) throw new Error('当前账号已变化，请关闭确认框并刷新');
      if (!local.accessToken || !local.accountId) throw new Error('请先登录 Codex 账号');
      const headers = {
        authorization: `Bearer ${local.accessToken}`,
        'ChatGPT-Account-Id': local.accountId,
        'OpenAI-Beta': 'codex-1',
        originator: 'Codex Desktop',
        accept: 'application/json'
      };
      const details = await fetchJson(RESET_CREDITS_URL, { headers }, 12000);
      throwForAuthFailure(details);
      if (!details.ok || !Array.isArray(details.json?.credits)) throw new Error('无法核实重置卡状态，请稍后重试');
      const card = details.json.credits.find((item) => item.id === creditId);
      if (card?.status === 'redeemed') return { code: 'already_redeemed', creditId, accountKey };
      if (card?.status !== 'available') throw new Error('该重置卡已失效或不可用，请刷新卡片列表');
      if (card.expires_at && Date.parse(card.expires_at) <= Date.now()) throw new Error('该重置卡已过期');
      const latest = await readLocalAuth();
      if (latest.accountKey !== accountKey || latest.accountId !== local.accountId) throw new Error('当前账号已变化，未使用重置卡');
      if (!latest.accessToken) throw new Error('登录凭据已变化，请刷新后重试');
      headers.authorization = `Bearer ${latest.accessToken}`;
      let response;
      try {
        response = await fetchJson(`${RESET_CREDITS_URL}/consume`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ credit_id: creditId, redeem_request_id: requestIdForCredit(accountKey, creditId) })
        }, 15000);
      } catch {
        throw new Error('暂时无法确认使用结果，请刷新或重试此卡；重试会沿用同一次请求');
      }
      throwForAuthFailure(response);
      const code = response.json?.code;
      if (!response.ok || !['reset', 'already_redeemed'].includes(code)) {
        throw new Error('未确认重置成功，请刷新卡片与额度后重试');
      }
      return { code, creditId, accountKey };
    } finally {
      busy = false;
    }
  };
}

async function reconcileResetCredit(result, refresh) {
  const message = result.code === 'reset' ? '重置卡使用成功' : '该重置卡已使用，无需重复操作';
  try {
    return await refresh(result, message);
  } catch {
    // Redemption has already succeeded. A local/network refresh failure must
    // never turn it into a failed redemption or invite another consumption.
    return { ...result, refreshPending: true, message: `${message}；数据暂未刷新，请稍后手动刷新` };
  }
}

module.exports = { createResetCreditRedeemer, reconcileResetCredit, validIdentifier, requestIdForCredit };
