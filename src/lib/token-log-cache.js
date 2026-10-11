const fs = require('fs/promises');
const { mapWithConcurrency } = require('./async-utils');
const { createTokenLogProjection } = require('./token-log-projection');

const READ_CHUNK_BYTES = 256 * 1024;
const INLINE_LINE_BYTES = 256 * 1024;

async function readLogRange(file, start, end, consume) {
  if (end <= start) return start;
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - start));
    let offset = start;
    while (offset < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (!bytesRead) break;
      await consume(buffer.subarray(0, bytesRead), offset);
      offset += bytesRead;
    }
    return offset;
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
  maxAgeMs = Number.POSITIVE_INFINITY,
  concurrency = 4
}) {
  const fileCache = new Map();
  let readQueue = Promise.resolve();

  function createEntry(stat) {
    return {
      birthtimeMs: stat.birthtimeMs,
      offset: 0,
      mtimeMs: 0,
      skippedLineCount: 0,
      projectedLineCount: 0,
      previousTotal: emptyTokenTotals(),
      previousFingerprint: null,
      currentModel: null,
      events: [],
      duplicateEventCount: 0
    };
  }

  function parseRecord(entry, root) {
    if (root?.type === 'turn_context' && root?.payload?.model) {
      entry.currentModel = normalizeTokenModel(root.payload.model);
      return;
    }
    if (root?.type !== 'event_msg' || root?.payload?.type !== 'token_count') return;
    const timestamp = Date.parse(root.timestamp);
    const cumulative = parseTokenTotals(root.payload?.info?.total_token_usage);
    const last = parseTokenTotals(root.payload?.info?.last_token_usage);
    if (!Number.isFinite(timestamp) || (!cumulative && !last)) return;
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

  async function readRecords(file, entry, endOffset) {
    let tail = Buffer.alloc(0);
    let projection = null;
    let invalid = false;
    try {
      await readLogRange(file, entry.offset, endOffset, async (chunk, offset) => {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.subarray(start, end);
          if (!invalid) {
            try {
              if (!projection && tail.length + part.length > INLINE_LINE_BYTES) {
                projection = createTokenLogProjection();
                await projection.write(tail);
                tail = Buffer.alloc(0);
              }
              if (projection) {
                await projection.write(part);
                if (newline >= 0) {
                  parseRecord(entry, await projection.finish());
                  entry.projectedLineCount += 1;
                }
              } else {
                tail = tail.length ? Buffer.concat([tail, part]) : Buffer.from(part);
                if (newline >= 0) {
                  const text = tail.toString('utf8');
                  if (text.includes('"token_count"') || text.includes('"turn_context"')) {
                    parseRecord(entry, JSON.parse(text));
                  }
                }
              }
            } catch {
              invalid = true;
              projection?.destroy();
              tail = Buffer.alloc(0);
            }
          }
          if (newline < 0) break;
          if (invalid) entry.skippedLineCount += 1;
          // Only completed lines advance the committed cursor. An incomplete
          // line is reread on append without caching its unbounded contents.
          entry.offset = offset + newline + 1;
          tail = Buffer.alloc(0);
          projection = null;
          invalid = false;
          start = newline + 1;
        }
      });
    } finally {
      projection?.destroy();
    }
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
      // Commit the cursor and parsed events together; a failed read can retry
      // without counting already parsed events twice.
      entry = { ...entry, events: entry.events.slice() };
      await readRecords(file, entry, stat.size);
    }
    if (Number.isFinite(maxAgeMs)) {
      const cutoff = Date.now() - maxAgeMs;
      entry.events = entry.events.filter((event) => event.timestamp >= cutoff);
    }
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
        const cached = fileCache.get(file);
        return { ok: false, file, error, value: cached ? { file, ...cached, stale: true } : null };
      }
    });
    return {
      logs: results.filter((result) => result.value).map((result) => result.value),
      failedFileCount: results.filter((result) => !result.ok).length,
      skippedLineCount: results.reduce((count, result) => count + (result.value?.skippedLineCount || 0), 0),
      projectedLineCount: results.reduce((count, result) => count + (result.value?.projectedLineCount || 0), 0)
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

module.exports = { createTokenLogCache, readLogRange };
