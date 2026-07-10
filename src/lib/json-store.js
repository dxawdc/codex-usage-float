const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');

class JsonStoreError extends Error {
  constructor(message, { file, cause } = {}) {
    super(message, { cause });
    this.name = 'JsonStoreError';
    this.code = 'JSON_STORE_ERROR';
    this.file = file || null;
  }
}

const writeQueues = new Map();

async function parseJsonFile(file) {
  const contents = await fs.readFile(file, 'utf8');
  return JSON.parse(contents);
}

async function readJson(file, fallback, { recoverFromBackup = true } = {}) {
  try {
    return await parseJsonFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (recoverFromBackup) {
      try {
        return await parseJsonFile(`${file}.bak`);
      } catch (backupError) {
        if (backupError?.code !== 'ENOENT') {
          throw new JsonStoreError(`JSON 文件及其备份均无法读取：${path.basename(file)}`, {
            file,
            cause: backupError
          });
        }
      }
    }
    throw new JsonStoreError(`JSON 文件无法读取：${path.basename(file)}`, { file, cause: error });
  }
}

async function writeJsonNow(file, value, { backup = true } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const backupFile = `${file}.bak`;
  let handle;
  try {
    handle = await fs.open(tempFile, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    if (backup) {
      try {
        await parseJsonFile(file);
        await fs.copyFile(file, backupFile);
      } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    await fs.rename(tempFile, file);
    await fs.chmod(file, 0o600).catch(() => {});
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempFile, { force: true }).catch(() => {});
  }
}

async function writeJson(file, value, options = {}) {
  const key = path.resolve(file).toLowerCase();
  const previous = writeQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeJsonNow(file, value, options));
  writeQueues.set(key, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  }
}

module.exports = {
  JsonStoreError,
  readJson,
  writeJson
};
