import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function collect(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collect(file));
    else if (/\.[cm]?js$/.test(entry.name)) files.push(file);
  }
  return files;
}

const files = [...await collect('src'), ...await collect('scripts'), ...await collect('test')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} files`);
