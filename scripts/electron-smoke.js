const assert = require('node:assert/strict');
const { app, safeStorage } = require('electron');
const { createAccountVault } = require('../src/lib/account-vault');

app.whenReady().then(() => {
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'OS credential encryption is unavailable');
  const vault = createAccountVault(safeStorage);
  const authJson = {
    auth_mode: 'chatgpt',
    tokens: { access_token: 'smoke-access', refresh_token: 'smoke-refresh', account_id: 'smoke-account' }
  };
  const migrated = vault.openStore({ version: 1, accounts: [{ id: 'smoke', authJson }] });
  assert.equal(migrated.migrated, true);
  const sealed = vault.sealStore(migrated.store);
  const serialized = JSON.stringify(sealed);
  assert.equal(serialized.includes('smoke-access'), false, 'sealed store contains plaintext credentials');
  assert.deepEqual(vault.openStore(sealed).store.accounts[0].authJson, authJson);
  console.log('Electron safeStorage smoke test passed');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
