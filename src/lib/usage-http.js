class AuthRequestError extends Error {
  constructor(message, { status = null, code = null, authStatus = 'stale' } = {}) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = status;
    this.code = code;
    this.authStatus = authStatus;
  }
}

function throwForAuthFailure(response) {
  if (![401, 403].includes(Number(response?.status))) return;
  const body = JSON.stringify(response?.json || response?.text || '').toLowerCase();
  const revoked = /token_revoked|revoked|invalidated oauth token|refresh token was revoked/.test(body);
  const code = revoked ? 'token_revoked' : `http_${response.status}`;
  throw new AuthRequestError(
    revoked ? '登录凭据已失效，需要重新登录' : '账号访问令牌暂时不可用，请切换后由 Codex 尝试刷新',
    { status: response.status, code, authStatus: revoked ? 'needs_reauth' : 'stale' }
  );
}

function createJsonFetcher(net) {
  return async function fetchJson(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await net.fetch(url, {
        ...options,
        signal: controller.signal
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { ok: response.ok, status: response.status, json, text };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  AuthRequestError,
  createJsonFetcher,
  throwForAuthFailure
};
