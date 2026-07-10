const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthRequestError, createJsonFetcher, throwForAuthFailure } = require('../src/lib/usage-http');

test('classifies revoked tokens as requiring reauthentication', () => {
  assert.throws(
    () => throwForAuthFailure({ status: 401, json: { error: { code: 'token_revoked' } } }),
    (error) => error instanceof AuthRequestError && error.authStatus === 'needs_reauth'
  );
});

test('keeps generic authorization failures in stale state', () => {
  assert.throws(
    () => throwForAuthFailure({ status: 403, text: 'forbidden' }),
    (error) => error instanceof AuthRequestError && error.authStatus === 'stale'
  );
});

test('parses JSON responses through the injected Electron net API', async () => {
  const fetchJson = createJsonFetcher({
    fetch: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' })
  });
  assert.deepEqual(await fetchJson('https://example.test'), {
    ok: true,
    status: 200,
    json: { ok: true },
    text: '{"ok":true}'
  });
});
