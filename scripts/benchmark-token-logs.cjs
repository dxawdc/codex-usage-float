const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createTokenLogCache } = require('../src/lib/token-log-cache');
const { writeJson } = require('../src/lib/json-store');

async function filesUnder(root) {
  const files = [];
  for (const item of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) files.push(...await filesUnder(file));
    else if (item.name.endsWith('.jsonl')) files.push(file);
  }
  return files;
}

async function main() {
  const files = [
    ...await filesUnder(path.join(os.homedir(), '.codex', 'sessions')),
    ...await filesUnder(path.join(os.homedir(), '.codex', 'archived_sessions'))
  ];
  const cache = createTokenLogCache({
    emptyTokenTotals: () => ({ totalTokens: 0 }),
    normalizeTokenModel: (value) => value,
    parseTokenTotals: (value) => value ? { totalTokens: Number(value.total_tokens) || 0 } : null,
    subtractTokenTotals: (current, previous) => ({ totalTokens: Math.max(0, current.totalTokens - previous.totalTokens) }),
    hasTokenTotals: (value) => value.totalTokens > 0,
    rateLimitFingerprint: (value) => value ? String(value) : null,
    identityKey: () => null
  });
  const started = Date.now();
  let peakRss = process.memoryUsage().rss;
  const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  try {
    const result = await cache.loadTokenLogs(files);
    const report = {
      sourceFileCount: result.logs.length,
      failedFileCount: result.failedFileCount,
      skippedLineCount: result.skippedLineCount,
      projectedLineCount: result.projectedLineCount,
      eventCount: result.logs.reduce((sum, log) => sum + log.events.length, 0),
      elapsedSeconds: (Date.now() - started) / 1000,
      peakRssMB: Math.round(peakRss / 1024 ** 2)
    };
    const incrementalStart = Date.now();
    const incremental = await cache.loadTokenLogs(files);
    report.incrementalSeconds = (Date.now() - incrementalStart) / 1000;
    report.incrementalFailedFiles = incremental.failedFileCount;
    await writeJson(path.resolve('dist/verification/log-scan-optimized.json'), report, { backup: false });
    console.log(JSON.stringify(report));
  } finally { clearInterval(timer); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
