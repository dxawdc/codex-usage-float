const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { readJson, writeJson, JsonStoreError } = require('../src/lib/json-store');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-float-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('serializes concurrent writes and keeps valid JSON', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  await Promise.all(Array.from({ length: 20 }, (_, index) => writeJson(file, { index })));
  assert.deepEqual(await readJson(file, null), { index: 19 });
  assert.deepEqual(await readJson(`${file}.bak`, null, { recoverFromBackup: false }), { index: 18 });
});

test('recovers a corrupted primary file from its backup', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, '{broken', 'utf8');
  await fs.writeFile(`${file}.bak`, JSON.stringify({ recovered: true }), 'utf8');
  assert.deepEqual(await readJson(file, null), { recovered: true });
  await writeJson(file, { repaired: true });
  assert.deepEqual(await readJson(file, null), { repaired: true });
  assert.deepEqual(await readJson(`${file}.bak`, null, { recoverFromBackup: false }), { recovered: true });
});

test('reports corruption instead of silently returning an empty store', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'accounts.json');
  await fs.writeFile(file, '{broken', 'utf8');
  await assert.rejects(() => readJson(file, { accounts: [] }), JsonStoreError);
});

test('can disable backups for plaintext auth.json writes', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'auth.json');
  await writeJson(file, { token: 'first' }, { backup: false });
  await writeJson(file, { token: 'second' }, { backup: false });
  await assert.rejects(() => fs.stat(`${file}.bak`), { code: 'ENOENT' });
});
