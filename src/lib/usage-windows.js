const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function unixSecondsToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const date = new Date(number * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeUsageWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const usedPercent = numberOrNull(value.used_percent);
  const windowSeconds = numberOrNull(value.limit_window_seconds);
  if (!Number.isFinite(usedPercent) || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  return {
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    windowSeconds,
    resetAt: unixSecondsToIso(value.reset_at)
  };
}

function collectAggregateUsageWindows(payload) {
  const rateLimit = payload?.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object') return [];
  return ['primary_window', 'secondary_window']
    .map((key) => normalizeUsageWindow(rateLimit[key]))
    .filter(Boolean);
}

function findUsageWindow(windows, targetSeconds) {
  return windows.find((window) => window.windowSeconds === targetSeconds) || null;
}

function mapAggregateUsageWindows(payload) {
  const windows = collectAggregateUsageWindows(payload);
  return {
    fiveHour: findUsageWindow(windows, FIVE_HOURS_SECONDS),
    oneWeek: findUsageWindow(windows, ONE_WEEK_SECONDS)
  };
}

module.exports = {
  FIVE_HOURS_SECONDS,
  ONE_WEEK_SECONDS,
  normalizeUsageWindow,
  collectAggregateUsageWindows,
  mapAggregateUsageWindows
};
