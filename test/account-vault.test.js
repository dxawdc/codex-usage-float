const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountVault, AccountVaultError, STORE_VERSION } = require('../src/lib/account-vault');

function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value) => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('invalid ciphertext');
      return text.slice('sealed:'.length);
    }
  };
}

const authJson = {
  auth_mode: 'chatgpt',
  tokens: { access_token: 'access', refresh_token: 'refresh', account_id: 'account' }
};

test('migrates plaintext v1 stores and never seals authJson as plaintext', () => {
  const vault = createAccountVault(fakeSafeStorage());
  const opened = vault.openStore({ version: 1, accounts: [{ id: 'a', authJson }] });
  assert.equal(opened.migrated, true);
  assert.deepEqual(opened.store.accounts[0].authJson, authJson);
  const sealed = vault.sealStore(opened.store);
  assert.equal(sealed.version, STORE_VERSION);
  assert.equal('authJson' in sealed.accounts[0], false);
  assert.match(sealed.accounts[0].auth.payload, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(vault.openStore(sealed).store.accounts[0].authJson, authJson);
});

test('refuses plaintext migration when OS encryption is unavailable', () => {
  const vault = createAccountVault(fakeSafeStorage({ available: false }));
  assert.throws(
    () => vault.openStore({ version: 1, accounts: [{ id: 'a', authJson }] }),
    (error) => error instanceof AccountVaultError && error.code === 'ENCRYPTION_UNAVAILABLE'
  );
});

test('preserves unreadable encrypted entries but marks them for reauthentication', () => {
  const vault = createAccountVault(fakeSafeStorage());
  const encrypted = { format: 'electron-safe-storage-v1', payload: Buffer.from('bad').toString('base64') };
  const opened = vault.openStore({ version: STORE_VERSION, accounts: [{ id: 'a', auth: encrypted }] });
  assert.equal(opened.store.accounts[0].authJson, null);
  assert.equal(opened.store.accounts[0].authStatus, 'needs_reauth');
  assert.deepEqual(vault.sealStore(opened.store).accounts[0].auth, encrypted);
});
