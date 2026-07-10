const STORE_VERSION = 2;
const AUTH_FORMAT = 'electron-safe-storage-v1';

class AccountVaultError extends Error {
  constructor(message, code = 'ACCOUNT_VAULT_ERROR', cause = null) {
    super(message, { cause });
    this.name = 'AccountVaultError';
    this.code = code;
  }
}

function createAccountVault(safeStorage) {
  function assertAvailable() {
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new AccountVaultError(
        '当前系统无法使用安全凭据存储，请确认 Windows 用户配置可用后重试',
        'ENCRYPTION_UNAVAILABLE'
      );
    }
  }

  function encryptAuth(authJson) {
    if (!authJson || typeof authJson !== 'object') return null;
    assertAvailable();
    const encrypted = safeStorage.encryptString(JSON.stringify(authJson));
    return {
      format: AUTH_FORMAT,
      payload: Buffer.from(encrypted).toString('base64')
    };
  }

  function decryptAuth(encryptedAuth) {
    if (!encryptedAuth) return null;
    if (encryptedAuth.format !== AUTH_FORMAT || typeof encryptedAuth.payload !== 'string') {
      throw new AccountVaultError('账号凭据格式不受支持', 'UNSUPPORTED_AUTH_FORMAT');
    }
    assertAvailable();
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(encryptedAuth.payload, 'base64')));
    } catch (error) {
      throw new AccountVaultError('账号凭据无法解密，可能来自其他 Windows 用户或设备', 'DECRYPT_FAILED', error);
    }
  }

  function openStore(rawStore) {
    const sourceAccounts = Array.isArray(rawStore?.accounts) ? rawStore.accounts : [];
    let migrated = Number(rawStore?.version) !== STORE_VERSION;
    const accounts = sourceAccounts.map((source) => {
      const account = { ...source };
      if (account.authJson) {
        account.auth = encryptAuth(account.authJson);
        migrated = true;
      }
      try {
        account.authJson = account.authJson || decryptAuth(account.auth);
        account.authStorageError = null;
      } catch (error) {
        account.authJson = null;
        account.authStorageError = error?.message || '账号凭据无法读取';
        account.authStatus = 'needs_reauth';
      }
      return account;
    });
    return { store: { version: STORE_VERSION, accounts }, migrated };
  }

  function sealStore(store) {
    const accounts = (Array.isArray(store?.accounts) ? store.accounts : []).map((source) => {
      const account = { ...source };
      if (account.authJson) account.auth = encryptAuth(account.authJson);
      delete account.authJson;
      delete account.authStorageError;
      return account;
    });
    return { version: STORE_VERSION, accounts };
  }

  return {
    version: STORE_VERSION,
    encryptAuth,
    decryptAuth,
    openStore,
    sealStore
  };
}

module.exports = {
  AUTH_FORMAT,
  STORE_VERSION,
  AccountVaultError,
  createAccountVault
};
