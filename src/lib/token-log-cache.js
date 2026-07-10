const fs = require('fs/promises');
const { mapWithConcurrency } = require('./async-utils');

async function readUtf8Range(file, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return '';
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

function createTokenLogCache({
  emptyTokenTotals,
  normalizeTokenModel,
  parseTokenTotals,
  subtractTokenTotals,
  hasTokenTotals,
  rateLimitFingerprint,
  identityKey,
  maxAgeMs = 31 * 24 * 60 * 60 * 1000,
  concurrency = 4
}) {
  const fileCache = new Map();
  let readQueue = Promise.resolve();

  function createEntry(stat) {
    return {
      birthtimeMs: stat.birthtimeMs,
      offset: 0,
      mtimeMs: 0,
      tail: '',
      previousTotal: emptyTokenTotals(),
      previousFingerprint: null,
      currentModel: null,
      events: [],
      duplicateEventCount: 0
    };
  }

  function parseLines(entry, text) {
    const combined = `${entry.tail}${text}`;
    const lines = combined.split(/\r?\n/);
    entry.tail = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim() || (!line.includes('"token_count"') && !line.includes('"turn_context"'))) continue;
      let root;
      try {
        root = JSON.parse(line);
      } catch {
        continue;
      }
      if (root?.type === 'turn_context' && root?.payload?.model) {
        entry.currentModel = normalizeTokenModel(root.payload.model);
        continue;
      }
      if (root?.type !== 'event_msg' || root?.payload?.type !== 'token_count') continue;
      const timestamp = Date.parse(root.timestamp);
      const cumulative = parseTokenTotals(root.payload?.info?.total_token_usage);
      const last = parseTokenTotals(root.payload?.info?.last_token_usage);
      if (!Number.isFinite(timestamp) || (!cumulative && !last)) continue;
      const delta = cumulative ? subtractTokenTotals(cumulative, entry.previousTotal) : last;
      if (cumulative) entry.previousTotal = cumulative;
      if (!hasTokenTotals(delta)) entry.duplicateEventCount += 1;
      const rateLimits = root.payload?.rate_limits;
      const fingerprint = rateLimitFingerprint(rateLimits?.secondary?.resets_at);
      entry.events.push({
        timestamp,
        timestampText: root.timestamp,
        delta,
        model: entry.currentModel,
        fingerprint,
        previousFingerprint: entry.previousFingerprint,
        eventAccountKey: identityKey(rateLimits?.account_id),
        eventUserKey: identityKey(rateLimits?.user_id)
      });
      if (fingerprint) entry.previousFingerprint = fingerprint;
    }
    const cutoff = Date.now() - maxAgeMs;
    entry.events = entry.events.filter((event) => event.timestamp >= cutoff);
  }

  async function loadFile(file) {
    const stat = await fs.stat(file);
    let entry = fileCache.get(file);
    const canAppend = Boolean(
      entry && entry.birthtimeMs === stat.birthtimeMs && stat.size >= entry.offset &&
      (stat.size > entry.offset || stat.mtimeMs === entry.mtimeMs)
    );
    if (!canAppend) entry = createEntry(stat);
    if (stat.size > entry.offset) {
      const text = await readUtf8Range(file, entry.offset, stat.size);
      parseLines(entry, text);
    }
    entry.offset = stat.size;
    entry.mtimeMs = stat.mtimeMs;
    fileCache.set(file, entry);
    return { file, ...entry };
  }

  async function loadManyNow(files) {
    const activeFiles = new Set(files);
    for (const file of fileCache.keys()) {
      if (!activeFiles.has(file)) fileCache.delete(file);
    }
    const results = await mapWithConcurrency(files, concurrency, async (file) => {
      try {
        return { ok: true, value: await loadFile(file) };
      } catch (error) {
        return { ok: false, file, error };
      }
    });
    return {
      logs: results.filter((result) => result.ok).map((result) => result.value),
      failedFileCount: results.filter((result) => !result.ok).length
    };
  }

  function loadTokenLogs(files) {
    const next = readQueue.catch(() => {}).then(() => loadManyNow(files));
    readQueue = next;
    return next;
  }

  return {
    loadTokenLogs,
    clear: () => fileCache.clear()
  };
}

module.exports = { createTokenLogCache, readUtf8Range };
