const { app, BrowserWindow, ipcMain, screen, shell, safeStorage, net } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs/promises');
const { readJson, writeJson } = require('./lib/json-store');
const { createAccountVault } = require('./lib/account-vault');
const { mapWithConcurrency } = require('./lib/async-utils');
const { createCodexProcessManager } = require('./lib/codex-process-manager');
const { mergePatch, mergeSparse } = require('./lib/object-utils');
const { AuthRequestError, createJsonFetcher, throwForAuthFailure } = require('./lib/usage-http');
const { createTokenLogCache } = require('./lib/token-log-cache');

const APP_URL = 'https://chatgpt.com';
const GITHUB_REPO_URL = 'https://github.com/dxawdc/codex-usage-float';
const AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
const CODEX_SESSIONS_PATH = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_ARCHIVED_SESSIONS_PATH = path.join(os.homedir(), '.codex', 'archived_sessions');
const CODEX_LOGS_DB_PATH = path.join(os.homedir(), '.codex', 'logs_2.sqlite');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com';
const CODEX_USAGE_PATH = '/api/codex/usage';
const WHAM_USAGE_PATH = '/wham/usage';
const PROFILE_USAGE_PATH = '/wham/profiles/me';
const RESET_CREDITS_PATH = '/wham/rate-limit-reset-credits';
const BACKEND_API_PREFIX = '/backend-api';
const FLOAT_PADDING = 8;
const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 720;
const PANEL_GAP = 12;
const PANEL_EDGE_PADDING = 12;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 30;
const MIN_REFRESH_INTERVAL_MINUTES = 5;
const MAX_REFRESH_INTERVAL_MINUTES = 180;
const TOKEN_FINGERPRINT_VERSION = 4;
const STORED_ACCOUNT_REFRESH_CONCURRENCY = 3;
const REMOTE_HOST_SUFFIXES = ['chatgpt.com', 'openai.com'];
const SELF_TEST_MODE = process.argv.includes('--self-test');

const accountVault = createAccountVault(safeStorage);
const codexProcessManager = createCodexProcessManager();
const fetchJson = createJsonFetcher(net);
const { loadTokenLogs } = createTokenLogCache({
  emptyTokenTotals,
  normalizeTokenModel,
  parseTokenTotals,
  subtractTokenTotals,
  hasTokenTotals,
  rateLimitFingerprint,
  identityKey
});

let floatWindow;
let webWindow;
let webWindowAccountKey = null;
let refreshTimer;
let refreshInFlight = null;
let authTransitionInProgress = false;
let panelState = { open: false, side: 'right', orbX: 0, orbY: 0 };
let config = { windowSize: 116, refreshIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES, alwaysOnTop: true };
let state = createEmptyState();

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function statePath() {
  return path.join(app.getPath('userData'), 'usage-state.json');
}

function accountsPath() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function debugPath() {
  return path.join(app.getPath('userData'), 'last-capture.json');
}

function normalizeRefreshInterval(value, fallback = DEFAULT_REFRESH_INTERVAL_MINUTES) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(MIN_REFRESH_INTERVAL_MINUTES, Math.min(number, MAX_REFRESH_INTERVAL_MINUTES)));
}

function getSettingsSnapshot() {
  return {
    refreshIntervalMinutes: normalizeRefreshInterval(config.refreshIntervalMinutes),
    alwaysOnTop: config.alwaysOnTop !== false
  };
}

async function getCodexAppStatus() {
  return codexProcessManager.getStatus();
}

async function waitForFileStable(file, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    let signature = 'missing';
    try {
      const stat = await fs.stat(file);
      signature = `${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (signature === previous) stableChecks += 1;
    else stableChecks = 0;
    if (stableChecks >= 3) return true;
    previous = signature;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function stopCodexDesktopApp() {
  const result = await codexProcessManager.stop();
  if (!result.ok) return result;
  const authStable = await waitForFileStable(AUTH_PATH);
  return {
    ...result,
    ok: Boolean(result.ok && authStable),
    authStable,
    message: authStable ? result.message : 'Codex 已关闭，但认证文件仍在变化，请稍后重试'
  };
}

async function launchCodexDesktopApp() {
  return codexProcessManager.launch();
}

function createEmptyState() {
  return {
    snapshot: {
      planTier: null,
      membershipExpiresAt: null,
      usageRemainingPercent: null,
      usageResetAt: null,
      creditsBalance: null,
      resetCards: [],
      lastSyncedAt: null,
      sourceStatus: '等待同步 Codex 登录信息',
      sourceUrl: ''
    },
    settings: {
      lowUsageThresholdPercent: 20,
      criticalUsageThresholdPercent: 8
    },
    alertState: {}
  };
}

async function loadState() {
  const warnings = [];
  try {
    config = { ...config, ...(await readJson(configPath(), config)) };
    config.refreshIntervalMinutes = normalizeRefreshInterval(config.refreshIntervalMinutes);
    config.alwaysOnTop = config.alwaysOnTop !== false;
  } catch (error) {
    warnings.push(`配置文件损坏：${error?.message || error}`);
  }
  try {
    state = mergePatch(createEmptyState(), await readJson(statePath(), createEmptyState()));
  } catch (error) {
    state = createEmptyState();
    warnings.push(`状态文件损坏：${error?.message || error}`);
  }
  if (warnings.length) state.snapshot.sourceStatus = warnings.join('；').slice(0, 240);
}

async function saveState(patch, replaceSnapshotKeys = []) {
  state = mergePatch(state, patch);
  for (const key of replaceSnapshotKeys) {
    if (Object.prototype.hasOwnProperty.call(patch?.snapshot || {}, key)) {
      state.snapshot[key] = patch.snapshot[key];
    }
  }
  await writeJson(statePath(), state);
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.webContents.send('usage-data', getViewSnapshot());
  }
}

function getViewSnapshot() {
  const snapshot = state.snapshot || {};
  const fiveHourRemaining = snapshot.usageWindows?.fiveHour?.remainingPercent;
  const remainingPercent = isFiniteNumberValue(fiveHourRemaining)
    ? fiveHourRemaining
    : snapshot.usageRemainingPercent;
  return {
    ...snapshot,
    windowSize: Number(config.windowSize) || 116,
    statusLevel: statusLevel(remainingPercent),
    hasUsageData:
      isFiniteNumberValue(snapshot.usageRemainingPercent) ||
      Boolean(snapshot.usageWindows?.fiveHour) ||
      Boolean(snapshot.usageWindows?.oneWeek)
  };
}

function statusLevel(percent) {
  if (!isFiniteNumberValue(percent)) return 'unknown';
  const value = Number(percent);
  if (value <= Number(state.settings?.criticalUsageThresholdPercent || 8)) return 'critical';
  if (value <= Number(state.settings?.lowUsageThresholdPercent || 20)) return 'low';
  return 'ok';
}

function decodeJwtPayload(jwt) {
  try {
    const body = String(jwt || '').split('.')[1];
    if (!body) return null;
    const normalized = body.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    const millis = value < 10000000000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const parsedPercent = Number(value.replace('%', '').trim());
    return Number.isFinite(parsedPercent) ? parsedPercent : null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentOrNull(value) {
  const number = numberOrNull(value);
  if (!Number.isFinite(number)) return null;
  if (number >= 0 && number <= 1) return number * 100;
  if (number >= 0 && number <= 100) return number;
  return null;
}

function shortIdentity(value) {
  const text = String(value || '');
  return text ? text.slice(0, 6) : 'unknown';
}

function cleanText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function firstClean(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return null;
}

function getPathValue(source, pathName) {
  return String(pathName || '')
    .split('.')
    .reduce((value, key) => (value && typeof value === 'object' ? value[key] : null), source);
}

function deepPickByKey(source, keys, seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return null;
  seen.add(source);
  for (const [key, value] of Object.entries(source)) {
    if (keys.includes(key)) {
      const text = cleanText(value);
      if (text) return text;
    }
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      const text = deepPickByKey(value, keys, seen);
      if (text) return text;
    }
  }
  return null;
}

function normalizeProfileUsername(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (text.includes('@')) return text;
  return `@${text.replace(/^@+/, '')}`;
}

function extractProfileIdentity(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const nickname = firstClean(
    getPathValue(payload, 'display_name'),
    getPathValue(payload, 'displayName'),
    getPathValue(payload, 'profile.display_name'),
    getPathValue(payload, 'profile.displayName'),
    getPathValue(payload, 'profile.name'),
    getPathValue(payload, 'user.display_name'),
    getPathValue(payload, 'user.displayName'),
    getPathValue(payload, 'user.name'),
    getPathValue(payload, 'account.display_name'),
    getPathValue(payload, 'account.displayName'),
    getPathValue(payload, 'account.name'),
    getPathValue(payload, 'name'),
    getPathValue(payload, 'nickname'),
    deepPickByKey(payload, ['display_name', 'displayName', 'nickname', 'name'])
  );
  const username = normalizeProfileUsername(firstClean(
    getPathValue(payload, 'username'),
    getPathValue(payload, 'email'),
    getPathValue(payload, 'user_name'),
    getPathValue(payload, 'userName'),
    getPathValue(payload, 'handle'),
    getPathValue(payload, 'profile.username'),
    getPathValue(payload, 'profile.user_name'),
    getPathValue(payload, 'profile.userName'),
    getPathValue(payload, 'profile.handle'),
    getPathValue(payload, 'profile.email'),
    getPathValue(payload, 'user.username'),
    getPathValue(payload, 'user.user_name'),
    getPathValue(payload, 'user.userName'),
    getPathValue(payload, 'user.handle'),
    getPathValue(payload, 'user.email'),
    getPathValue(payload, 'account.username'),
    getPathValue(payload, 'account.user_name'),
    getPathValue(payload, 'account.userName'),
    getPathValue(payload, 'account.handle'),
    getPathValue(payload, 'account.email'),
    deepPickByKey(payload, ['username', 'user_name', 'userName', 'handle', 'email'])
  ));
  return {
    nickname,
    username,
    hasProfileIdentity: Boolean(nickname || username)
  };
}

function usernameFromAuth(idPayload, accessPayload, claim, accountId, userId) {
  return cleanText(
    idPayload?.preferred_username ||
    idPayload?.username ||
    accessPayload?.preferred_username ||
    accessPayload?.username ||
    idPayload?.email ||
    accessPayload?.email ||
    idPayload?.['https://api.openai.com/profile']?.email ||
    accessPayload?.['https://api.openai.com/profile']?.email ||
    claim.email ||
    (userId ? `user-${shortIdentity(userId)}` : null) ||
    (accountId ? `acct-${shortIdentity(accountId)}` : null)
  );
}

function defaultNickname(username, planTier, accountKey) {
  const name = cleanText(username);
  if (name?.includes('@')) return name.split('@')[0];
  return name || formatPlanName(planTier) || `Codex ${shortIdentity(accountKey)}`;
}

function formatPlanName(value) {
  const plan = String(value || '').toLowerCase();
  if (!plan) return null;
  if (plan.includes('enterprise')) return 'Enterprise';
  if (plan.includes('business')) return 'Business';
  if (plan.includes('team')) return 'Team';
  if (plan.includes('pro')) return 'Pro';
  if (plan.includes('plus')) return 'Plus';
  if (plan.includes('free')) return 'Free';
  return cleanText(value);
}

function accountLabel(account) {
  const nickname = cleanText(account?.nickname) || defaultNickname(account?.username, account?.planTier, account?.accountKey);
  const username = cleanText(account?.username) || `账号 ${shortIdentity(account?.accountKey || account?.accountId || account?.userId)}`;
  return `${nickname} ${username}`;
}

function parseCodexAuth(auth) {
  const idPayload = decodeJwtPayload(auth?.tokens?.id_token);
  const accessPayload = decodeJwtPayload(auth?.tokens?.access_token);
  const claim = idPayload?.['https://api.openai.com/auth'] || accessPayload?.['https://api.openai.com/auth'] || {};
  const accountId = auth?.tokens?.account_id || claim.chatgpt_account_id || null;
  const userId = claim.chatgpt_user_id || claim.user_id || idPayload?.sub || accessPayload?.sub || null;
  const accountKey = identityKey(userId || accountId);
  const username = usernameFromAuth(idPayload, accessPayload, claim, accountId, userId);
  const authNickname = firstClean(
    idPayload?.name,
    idPayload?.nickname,
    accessPayload?.name,
    accessPayload?.nickname
  );
  const planTier = claim.chatgpt_plan_type || claim.plan_type || null;
  return {
    accessToken: auth?.tokens?.access_token || null,
    accountId,
    userId,
    accountKey,
    username,
    nickname: authNickname || defaultNickname(username, planTier, accountKey),
    authIssuedAt: normalizeDate(accessPayload?.iat || idPayload?.iat),
    planTier,
    membershipExpiresAt: normalizeDate(claim.chatgpt_subscription_active_until),
    membershipStartedAt: normalizeDate(claim.chatgpt_subscription_active_start),
    subscriptionLastCheckedAt: normalizeDate(claim.chatgpt_subscription_last_checked)
  };
}

async function readLocalCodexAuth() {
  return parseCodexAuth(await readCodexAuthJson());
}

async function readCodexAuthJson() {
  return readJson(AUTH_PATH, null, { recoverFromBackup: false });
}

function identityKey(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

async function loadAccountsStore() {
  const rawStore = await readJson(accountsPath(), { version: accountVault.version, accounts: [] });
  const { store, migrated } = accountVault.openStore(rawStore);
  if (migrated) await saveAccountsStore(store, { backup: false });
  return store;
}

function isFiniteNumberValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

async function saveAccountsStore(store, options = {}) {
  await writeJson(accountsPath(), accountVault.sealStore(store), options);
}

function buildStoredAccount(authJson, local, previous = {}) {
  const now = new Date().toISOString();
  const accountKey = local.accountKey || identityKey(local.userId || local.accountId) || crypto.randomUUID();
  const profileIdentity = local.profileIdentity || previous.tokenUsage?.profileIdentity || {};
  return {
    id: previous.id || crypto.randomUUID(),
    nickname: cleanText(profileIdentity.nickname) || cleanText(previous.nickname) || cleanText(local.nickname) ||
      defaultNickname(local.username, local.planTier, accountKey),
    username: cleanText(profileIdentity.username) || cleanText(previous.username) || cleanText(local.username) ||
      `账号 ${shortIdentity(accountKey)}`,
    accountKey,
    accountId: local.accountId || previous.accountId || null,
    userId: local.userId || previous.userId || null,
    planTier: local.planTier || previous.planTier || null,
    membershipExpiresAt: local.membershipExpiresAt || previous.membershipExpiresAt || null,
    authJson,
    usage: previous.usage || null,
    tokenUsage: previous.tokenUsage || null,
    resetCards: previous.resetCards || [],
    usageError: previous.usageError || null,
    authStatus: previous.authStatus || 'active',
    lastValidatedAt: previous.lastValidatedAt || null,
    createdAt: previous.createdAt || now,
    updatedAt: now,
    lastSwitchedAt: previous.lastSwitchedAt || null,
    lastSyncedAt: previous.lastSyncedAt || null
  };
}

function accountView(account, currentAccountKey = null) {
  return {
    id: account.id,
    nickname: account.nickname,
    username: account.username,
    label: accountLabel(account),
    accountKey: account.accountKey,
    planTier: account.planTier,
    membershipExpiresAt: account.membershipExpiresAt,
    usageWindows: account.usage?.usageWindows || {},
    resetCards: account.resetCards || account.usage?.resetCards || [],
    tokenUsage: account.tokenUsage || null,
    isCurrent: Boolean(currentAccountKey && account.accountKey === currentAccountKey),
    usageError: account.usageError || null,
    authStatus: account.authStatus || (account.authStorageError ? 'needs_reauth' : 'unknown'),
    lastValidatedAt: account.lastValidatedAt || null,
    lastSyncedAt: account.lastSyncedAt || account.updatedAt || null,
    lastSwitchedAt: account.lastSwitchedAt || null
  };
}

function accountFromCurrent(local, usage, tokenUsage, resetCards, syncedAt, authStatus = 'active', usageError = null) {
  return {
    id: 'current',
    nickname: local.nickname,
    username: local.username,
    label: accountLabel(local),
    accountKey: local.accountKey,
    planTier: usage?.planTier || local.planTier,
    membershipExpiresAt: usage?.membershipExpiresAt || local.membershipExpiresAt,
    usage: { usageWindows: usage?.usageWindows || {}, resetCards },
    usageWindows: usage?.usageWindows || {},
    resetCards: resetCards || [],
    tokenUsage: tokenUsage || null,
    isCurrent: true,
    authStatus,
    usageError,
    lastValidatedAt: authStatus === 'active' ? syncedAt : null,
    lastSyncedAt: syncedAt
  };
}

function flattenValues(value, out = []) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenValues(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push({ key, value: child });
      flattenValues(child, out);
    }
  }
  return out;
}

function firstByKey(json, patterns, transform = (value) => value) {
  for (const { key, value } of flattenValues(json)) {
    if (!patterns.some((pattern) => pattern.test(key))) continue;
    const transformed = transform(value, key);
    if (transformed !== null && transformed !== undefined && transformed !== '') return transformed;
  }
  return null;
}

function extractResetCards(json) {
  const cards = [];
  for (const { key, value } of flattenValues(json)) {
    const keyMatch = /(reset|card|grant|boost)/i.test(key);
    if (!keyMatch || !Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const text = JSON.stringify(item).toLowerCase();
      if (!/(reset|card|grant|boost|expire|expiry|expires|valid_until)/.test(text)) continue;
      const count =
        firstByKey(item, [/count/i, /remaining/i, /quantity/i, /available/i], numberOrNull) ??
        numberOrNull(item.count);
      const expiresAt =
        firstByKey(item, [/expires?_at/i, /expiry/i, /expire/i, /valid_until/i, /ends?_at/i], normalizeDate) ??
        normalizeDate(item.expires_at);
      const resetAt = firstByKey(item, [/reset/i, /refresh/i, /renews?_at/i], normalizeDate);
      if (!Number.isFinite(Number(count)) || Number(count) <= 0 || (!expiresAt && !resetAt)) continue;
      cards.push({
        label: String(item.label || item.name || item.type || key).slice(0, 48),
        count,
        expiresAt,
        resetAt
      });
    }
  }
  return cards.slice(0, 12);
}

function extractUsageSnapshot(json, sourceUrl = '') {
  const planTier = firstByKey(json, [/plan.*type/i, /plan$/i, /tier/i, /sku/i], (value) =>
    typeof value === 'string' && /free|plus|pro|team|enterprise|business/i.test(value) ? value : null
  );
  const membershipExpiresAt = firstByKey(
    json,
    [/subscription.*until/i, /active_until/i, /expires?_at/i, /renewal/i, /next_billing/i, /period_end/i],
    normalizeDate
  );
  const usageRemainingPercent = firstByKey(
    json,
    [/usage.*remaining.*percent/i, /remaining.*percent/i, /percent.*remaining/i, /quota.*remaining/i],
    percentOrNull
  );
  const usageResetAt = firstByKey(
    json,
    [/usage.*reset/i, /reset.*at/i, /resets?_at/i, /next.*reset/i, /refresh.*at/i, /renews?_at/i],
    normalizeDate
  );
  const creditsBalance = firstByKey(json, [/credits?.*balance/i, /balance/i, /remaining.*credits/i], numberOrNull);
  const resetCards = extractResetCards(json);

  return {
    planTier,
    membershipExpiresAt,
    usageRemainingPercent,
    usageResetAt,
    creditsBalance,
    resetCards,
    sourceUrl
  };
}

async function readChatgptBaseUrlFromConfig() {
  try {
    const contents = await fs.readFile(CODEX_CONFIG_PATH, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('chatgpt_base_url')) continue;
      const [, rawValue] = trimmed.split('=', 2);
      const cleaned = String(rawValue || '').trim().replace(/^['"]|['"]$/g, '');
      if (cleaned) return cleaned;
    }
  } catch {
    // Codex works without this optional config file.
  }
  return DEFAULT_CHATGPT_BASE_URL;
}

async function resolveUsageUrls() {
  const baseUrl = (await readChatgptBaseUrlFromConfig()).trim().replace(/\/+$/, '') || DEFAULT_CHATGPT_BASE_URL;
  const candidates = [];

  if (baseUrl.endsWith(BACKEND_API_PREFIX)) {
    const origin = baseUrl.slice(0, -BACKEND_API_PREFIX.length);
    candidates.push(`${baseUrl}${WHAM_USAGE_PATH}`);
    candidates.push(`${origin}${BACKEND_API_PREFIX}${WHAM_USAGE_PATH}`);
    candidates.push(`${origin}${CODEX_USAGE_PATH}`);
  } else {
    candidates.push(`${baseUrl}${BACKEND_API_PREFIX}${WHAM_USAGE_PATH}`);
    candidates.push(`${baseUrl}${WHAM_USAGE_PATH}`);
    candidates.push(`${baseUrl}${CODEX_USAGE_PATH}`);
  }

  candidates.push(`https://chatgpt.com${BACKEND_API_PREFIX}${WHAM_USAGE_PATH}`);
  candidates.push(`https://chatgpt.com${CODEX_USAGE_PATH}`);
  return [...new Set(candidates)];
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
  if (!Number.isFinite(usedPercent) || !Number.isFinite(windowSeconds)) return null;
  return {
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(100 - usedPercent),
    windowSeconds,
    resetAt: unixSecondsToIso(value.reset_at)
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function collectUsageWindows(payload) {
  const windows = [];
  const pushRateLimit = (rateLimit) => {
    if (!rateLimit || typeof rateLimit !== 'object') return;
    for (const key of ['primary_window', 'secondary_window']) {
      const window = normalizeUsageWindow(rateLimit[key]);
      if (window) windows.push(window);
    }
  };

  pushRateLimit(payload?.rate_limit);
  for (const item of payload?.additional_rate_limits || []) {
    pushRateLimit(item?.rate_limit);
  }
  return windows;
}

function pickNearestUsageWindow(windows, targetSeconds) {
  return windows
    .filter((window) => isFiniteNumberValue(window.windowSeconds))
    .sort((a, b) => Math.abs(a.windowSeconds - targetSeconds) - Math.abs(b.windowSeconds - targetSeconds))[0] || null;
}

function mapResetCredits(payload) {
  const resetCredits = payload?.rate_limit_reset_credits;
  const count = numberOrNull(resetCredits?.available_count);
  if (!Number.isFinite(count) || count <= 0) return [];
  return [{
    label: 'Codex \u91cd\u7f6e\u5361',
    count,
    expiresAt: normalizeDate(resetCredits.expires_at || resetCredits.valid_until || resetCredits.expiry),
    resetAt: normalizeDate(resetCredits.reset_at)
  }];
}

function resetCreditLabel(title) {
  if (/full reset/i.test(title || '')) return '完整重置卡（周 + 5 小时）';
  return String(title || 'Codex 重置卡').slice(0, 64);
}

function mapResetCreditDetails(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.credits)) return null;
  const available = payload.credits
    .filter((credit) => credit?.status === 'available')
    .map((credit) => ({
      label: resetCreditLabel(credit.title),
      count: 1,
      acquiredAt: normalizeDate(credit.granted_at),
      expiresAt: normalizeDate(credit.expires_at),
      resetAt: null,
      expiryInferred: false
    }));
  const reportedCount = numberOrNull(payload.available_count);
  if (Number.isFinite(reportedCount) && reportedCount > available.length) {
    available.push({
      label: '其他可用重置卡',
      count: reportedCount - available.length,
      expiresAt: null,
      resetAt: null
    });
  }
  return available;
}

function inferResetCardExpiry(cards = [], previousCards = []) {
  const previous = Array.isArray(previousCards) ? previousCards : [];
  return cards.map((card) => {
    const prior = previous.find((item) =>
      item?.label === card.label && Number(item?.count) === Number(card.count)
    );
    const acquiredAt = card.acquiredAt || prior?.acquiredAt || null;
    const expiresAt = card.expiresAt || (prior?.expiryInferred ? null : prior?.expiresAt) || null;
    return {
      ...card,
      acquiredAt,
      expiresAt,
      expiryInferred: false
    };
  });
}

function mapOfficialUsagePayload(payload, sourceUrl) {
  const windows = collectUsageWindows(payload);
  const fiveHour = pickNearestUsageWindow(windows, 5 * 60 * 60);
  const oneWeek = pickNearestUsageWindow(windows, 7 * 24 * 60 * 60);
  const primary = fiveHour || oneWeek;

  return {
    planTier: typeof payload?.plan_type === 'string' ? payload.plan_type : null,
    usageRemainingPercent: primary?.remainingPercent ?? null,
    usageResetAt: primary?.resetAt ?? null,
    usageWindows: {
      fiveHour,
      oneWeek
    },
    resetCards: mapResetCredits(payload),
    sourceUrl
  };
}

function hasOfficialUsageData(snapshot) {
  return (
    isFiniteNumberValue(snapshot?.usageRemainingPercent) ||
    Boolean(snapshot?.usageWindows?.fiveHour) ||
    Boolean(snapshot?.usageWindows?.oneWeek)
  );
}

function emptyTokenTotals() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function totalOnlyTokenTotals(value) {
  return {
    ...emptyTokenTotals(),
    totalTokens: Math.max(0, Number(value) || 0)
  };
}

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sumDailyTokenBuckets(buckets, days, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const startKey = localDateKey(start);
  return buckets.reduce((total, bucket) => {
    const dateKey = String(bucket?.start_date || bucket?.startDate || '').slice(0, 10);
    if (!dateKey || dateKey < startKey) return total;
    return total + Math.max(0, Number(bucket?.tokens) || 0);
  }, 0);
}

function mapAccountTokenUsagePayload(payload, accountKey, previous = null) {
  const profileIdentity = extractProfileIdentity(payload);
  const buckets = payload?.daily_usage_buckets || payload?.dailyUsageBuckets ||
    payload?.stats?.daily_usage_buckets || payload?.stats?.dailyUsageBuckets;
  if (!Array.isArray(buckets)) {
    return profileIdentity.hasProfileIdentity
      ? {
          source: 'account-profile',
          sourceLabel: '\u8d26\u53f7\u6570\u636e',
          updatedAt: new Date().toISOString(),
          accountKey,
          profileIdentity
        }
      : null;
  }

  const summary = payload?.stats || payload?.summary || payload || {};
  const today = sumDailyTokenBuckets(buckets, 1);
  const latestBucketDate = buckets
    .map((bucket) => String(bucket?.start_date || bucket?.startDate || '').slice(0, 10))
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    source: 'account-profile',
    sourceLabel: '\u8d26\u53f7\u6570\u636e',
    updatedAt: new Date().toISOString(),
    accountKey,
    profileIdentity,
    accountAssignments: previous?.accountAssignments || {},
    fingerprintAssignments: previous?.fingerprintAssignments || {},
    fingerprintVersion: TOKEN_FINGERPRINT_VERSION,
    bucketCount: buckets.length,
    latestBucketDate,
    mayBeDelayed: latestBucketDate !== localDateKey(),
    lifetime: totalOnlyTokenTotals(
      summary?.lifetime_tokens ?? summary?.lifetimeTokens ?? payload?.lifetime_tokens ?? payload?.lifetimeTokens
    ),
    today: totalOnlyTokenTotals(today),
    last24h: totalOnlyTokenTotals(today),
    last7d: totalOnlyTokenTotals(sumDailyTokenBuckets(buckets, 7)),
    last30d: totalOnlyTokenTotals(sumDailyTokenBuckets(buckets, 30))
  };
}

function addTokenTotals(target, source) {
  if (!source) return;
  target.inputTokens += Number(source.inputTokens || 0);
  target.cachedInputTokens += Number(source.cachedInputTokens || 0);
  target.outputTokens += Number(source.outputTokens || 0);
  target.reasoningOutputTokens += Number(source.reasoningOutputTokens || 0);
  target.totalTokens += Number(source.totalTokens || 0);
}

function normalizeTokenModel(value) {
  const model = String(value || '').trim();
  return model ? model.toLowerCase() : 'unknown';
}

function addModelTokenTotals(models, model, source) {
  const key = normalizeTokenModel(model);
  if (!models[key]) {
    models[key] = {
      total: emptyTokenTotals(),
      eventCount: 0
    };
  }
  addTokenTotals(models[key].total, source);
  models[key].eventCount += 1;
}

function subtractTokenTotals(current, previous) {
  const delta = emptyTokenTotals();
  for (const key of Object.keys(delta)) {
    const difference = Number(current?.[key] || 0) - Number(previous?.[key] || 0);
    delta[key] = difference >= 0 ? difference : Number(current?.[key] || 0);
  }
  return delta;
}

function hasTokenTotals(value) {
  return Object.values(value || {}).some((item) => Number(item) > 0);
}

function parseTokenTotals(value) {
  if (!value || typeof value !== 'object') return null;
  const inputTokens = Number(value.input_tokens || 0);
  const cachedInputTokens = Number(value.cached_input_tokens || 0);
  const outputTokens = Number(value.output_tokens || 0);
  const reasoningOutputTokens = Number(value.reasoning_output_tokens || 0);
  const explicitTotal = Number(value.total_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: Number.isFinite(explicitTotal) && explicitTotal > 0
      ? explicitTotal
      : inputTokens + outputTokens
  };
}

async function collectJsonlFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function sessionIdFromPath(file) {
  return path.basename(file, '.jsonl').match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i)?.[1] || null;
}

function rateLimitFingerprint(value) {
  let milliseconds;
  if (typeof value === 'number') {
    milliseconds = value < 10000000000 ? value * 1000 : value;
  } else {
    milliseconds = Date.parse(value);
  }
  if (!Number.isFinite(milliseconds)) return null;
  const bucketMs = 5 * 60 * 1000;
  return new Date(Math.round(milliseconds / bucketMs) * bucketMs).toISOString();
}

function addFingerprintEdge(edges, left, right) {
  if (!left || !right || left === right) return;
  const leftEdges = edges.get(left) || new Set();
  const rightEdges = edges.get(right) || new Set();
  leftEdges.add(right);
  rightEdges.add(left);
  edges.set(left, leftEdges);
  edges.set(right, rightEdges);
}

function registerFingerprint(assignments, fingerprint, accountKey, source, observedAt) {
  if (!fingerprint || !accountKey) return;
  const existing = assignments[fingerprint];
  if (!existing) {
    assignments[fingerprint] = {
      accountKey,
      ambiguous: false,
      sources: [source],
      firstObservedAt: observedAt || null,
      lastObservedAt: observedAt || null
    };
    return;
  }
  const sources = new Set(existing.sources || []);
  sources.add(source);
  if (existing.accountKey && existing.accountKey !== accountKey) {
    existing.accountKeys = [...new Set([...(existing.accountKeys || []), existing.accountKey, accountKey])];
    existing.accountKey = null;
    existing.ambiguous = true;
  }
  existing.sources = [...sources];
  if (observedAt) {
    existing.firstObservedAt = existing.firstObservedAt && existing.firstObservedAt < observedAt
      ? existing.firstObservedAt
      : observedAt;
    existing.lastObservedAt = existing.lastObservedAt && existing.lastObservedAt > observedAt
      ? existing.lastObservedAt
      : observedAt;
  }
}

function isNearEvidence(timestamp, assignment, toleranceMs = 15 * 60 * 1000) {
  return (assignment?.observedAt || []).some((value) => {
    const evidenceAt = Date.parse(value);
    return Number.isFinite(evidenceAt) && Math.abs(timestamp - evidenceAt) <= toleranceMs;
  });
}

function propagateFingerprintAssignments(assignments, edges, observedAt) {
  const visited = new Set();
  const nodes = new Set([...Object.keys(assignments), ...edges.keys()]);
  for (const start of nodes) {
    if (visited.has(start)) continue;
    const component = [];
    const stack = [start];
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of edges.get(current) || []) stack.push(neighbor);
    }
    const accountKeys = new Set(component
      .map((fingerprint) => assignments[fingerprint])
      .filter((item) => item?.accountKey && !item?.ambiguous)
      .map((item) => item.accountKey));
    if (accountKeys.size === 1) {
      const [accountKey] = accountKeys;
      for (const fingerprint of component) {
        if (!assignments[fingerprint]) {
          registerFingerprint(assignments, fingerprint, accountKey, 'natural-rollover', observedAt);
        }
      }
    } else if (accountKeys.size > 1) {
      for (const fingerprint of component) {
        const existing = assignments[fingerprint] || {};
        assignments[fingerprint] = {
          ...existing,
          accountKey: null,
          accountKeys: [...accountKeys],
          ambiguous: true,
          sources: [...new Set([...(existing.sources || []), 'rollover-conflict'])]
        };
      }
    }
  }
}

function readThreadAccountEvidence(previousAssignments = {}, previousLastRowId = 0) {
  const assignments = { ...(previousAssignments || {}) };
  let lastRowId = Math.max(0, Number(previousLastRowId) || 0);
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { assignments, lastRowId };
  }

  let database;
  try {
    database = new DatabaseSync(CODEX_LOGS_DB_PATH, { readOnly: true });
    const latest = database.prepare('select coalesce(max(rowid), 0) as max_row_id from logs').get();
    const maxRowId = Math.max(lastRowId, Number(latest?.max_row_id) || 0);
    const rows = database.prepare(`
      select rowid, thread_id, ts, feedback_log_body
      from logs
      where rowid > ? and rowid <= ?
        and thread_id is not null
        and target = 'codex_client::transport'
        and feedback_log_body like '%chatgpt_account_id%'
      order by rowid asc
    `).all(lastRowId, maxRowId);
    const candidates = new Map();
    for (const row of rows) {
      const normalized = String(row.feedback_log_body || '').replace(/\\\"/g, '"').replace(/\\n/g, ' ');
      const matches = [...normalized.matchAll(/"chatgpt_account_id"\s*:\s*"([A-Za-z0-9_-]{8,})"/gi)];
      if (!matches.length) continue;
      const candidate = candidates.get(row.thread_id) || { keys: new Set(), observedAt: new Set() };
      if (assignments[row.thread_id]?.accountKey) candidate.keys.add(assignments[row.thread_id].accountKey);
      for (const match of matches) candidate.keys.add(identityKey(match[1]));
      if (isFiniteNumberValue(row.ts)) candidate.observedAt.add(new Date(Number(row.ts) * 1000).toISOString());
      candidates.set(row.thread_id, candidate);
    }
    for (const [threadId, candidate] of candidates) {
      if (candidate.keys.size === 1) {
        assignments[threadId] = {
          accountKey: [...candidate.keys][0],
          source: 'local-log',
          observedAt: [...candidate.observedAt].sort()
        };
      } else if (candidate.keys.size > 1) {
        assignments[threadId] = {
          accountKey: null,
          ambiguous: true,
          source: 'local-log',
          observedAt: [...candidate.observedAt].sort()
        };
      }
    }
    lastRowId = maxRowId;
  } catch {
    return { assignments, lastRowId };
  } finally {
    database?.close();
  }
  return { assignments, lastRowId };
}

async function collectTokenUsageSnapshot({
  accountKey = null,
  userId = null,
  accountId = null,
  scopeStartedAt = null,
  previousAssignments = {},
  previousEvidenceLastRowId = 0,
  previousFingerprints = {},
  previousFingerprintVersion = null,
  currentWeeklyResetAt = null
} = {}) {
  const now = Date.now();
  const scopeStart = Date.parse(scopeStartedAt);
  const currentUserKey = identityKey(userId);
  const currentAccountKey = identityKey(accountId) || accountKey;
  const evidence = readThreadAccountEvidence(previousAssignments, previousEvidenceLastRowId);
  const accountAssignments = evidence.assignments;
  const fingerprintAssignments = previousFingerprintVersion === TOKEN_FINGERPRINT_VERSION
    ? JSON.parse(JSON.stringify(previousFingerprints || {}))
    : {};
  const fingerprintEdges = new Map();
  registerFingerprint(
    fingerprintAssignments,
    rateLimitFingerprint(currentWeeklyResetAt),
    currentAccountKey,
    'current-api',
    new Date(now).toISOString()
  );
  const windows = {
    last24h: { start: now - 24 * 60 * 60 * 1000, total: emptyTokenTotals() },
    last7d: { start: now - 7 * 24 * 60 * 60 * 1000, total: emptyTokenTotals() },
    last30d: { start: now - 30 * 24 * 60 * 60 * 1000, total: emptyTokenTotals() }
  };
  let eventCount = 0;
  let duplicateEventCount = 0;
  let unassignedEventCount = 0;
  let fingerprintMatchedEventCount = 0;
  let sessionMatchedEventCount = 0;
  let explicitIdentityEventCount = 0;
  let latestEventAt = null;
  const files = [
    ...(await collectJsonlFiles(CODEX_SESSIONS_PATH)),
    ...(await collectJsonlFiles(CODEX_ARCHIVED_SESSIONS_PATH))
  ];

  const loadedLogs = await loadTokenLogs(files);
  const events = [];
  for (const log of loadedLogs.logs) {
    const sessionId = sessionIdFromPath(log.file);
    const sessionAssignment = sessionId ? accountAssignments[sessionId] : null;
    duplicateEventCount += log.duplicateEventCount;
    for (const normalizedEvent of log.events) {
      const { timestamp, delta, fingerprint, previousFingerprint, eventAccountKey, eventUserKey } = normalizedEvent;
      if (fingerprint && previousFingerprint && fingerprint !== previousFingerprint) {
        const previousResetAt = Date.parse(previousFingerprint);
        if (Number.isFinite(previousResetAt) && previousResetAt <= timestamp + 10 * 60 * 1000) {
          addFingerprintEdge(fingerprintEdges, previousFingerprint, fingerprint);
        }
      }
      events.push({
        timestamp,
        delta,
        fingerprint,
        eventAccountKey,
        eventUserKey,
        sessionAssignment
      });

      if (fingerprint && sessionAssignment?.accountKey && isNearEvidence(timestamp, sessionAssignment)) {
        registerFingerprint(
          fingerprintAssignments,
          fingerprint,
          sessionAssignment.accountKey,
          'local-log',
          normalizedEvent.timestampText
        );
      }
    }
  }

  propagateFingerprintAssignments(fingerprintAssignments, fingerprintEdges, new Date(now).toISOString());

  for (const event of events) {
      const { timestamp, delta, fingerprint, eventAccountKey, eventUserKey, sessionAssignment } = event;
      let belongsToCurrentAccount = null;
      if (eventAccountKey || eventUserKey) {
        belongsToCurrentAccount = Boolean(
          (eventAccountKey && eventAccountKey === currentAccountKey) ||
          (eventUserKey && eventUserKey === currentUserKey)
        );
        if (belongsToCurrentAccount) explicitIdentityEventCount += 1;
      } else if (fingerprint && fingerprintAssignments[fingerprint]) {
        const fingerprintAssignment = fingerprintAssignments[fingerprint];
        belongsToCurrentAccount = fingerprintAssignment.ambiguous
          ? null
          : fingerprintAssignment.accountKey === currentAccountKey;
        if (belongsToCurrentAccount) fingerprintMatchedEventCount += 1;
      } else if (sessionAssignment?.accountKey && isNearEvidence(timestamp, sessionAssignment)) {
        belongsToCurrentAccount = sessionAssignment.accountKey === currentAccountKey;
        if (belongsToCurrentAccount) sessionMatchedEventCount += 1;
      }
      if (belongsToCurrentAccount !== true) {
        if (belongsToCurrentAccount === null) unassignedEventCount += 1;
        continue;
      }

      eventCount += 1;
      latestEventAt = latestEventAt ? Math.max(latestEventAt, timestamp) : timestamp;
      for (const window of Object.values(windows)) {
        if (timestamp >= window.start) addTokenTotals(window.total, delta);
      }
  }

  return {
    updatedAt: new Date(now).toISOString(),
    accountKey,
    scopeStartedAt: Number.isFinite(scopeStart) ? new Date(scopeStart).toISOString() : null,
    accountAssignments,
    evidenceLastRowId: evidence.lastRowId,
    fingerprintAssignments,
    fingerprintVersion: TOKEN_FINGERPRINT_VERSION,
    trackedAccountCount: new Set([
      currentAccountKey,
      ...Object.values(accountAssignments).map((item) => item?.accountKey),
      ...Object.values(fingerprintAssignments).map((item) => item?.accountKey)
    ].filter(Boolean)).size,
    fingerprintCount: Object.values(fingerprintAssignments).filter((item) => !item?.ambiguous).length,
    conflictingFingerprintCount: Object.values(fingerprintAssignments).filter((item) => item?.ambiguous).length,
    sourceFileCount: loadedLogs.logs.length,
    failedFileCount: loadedLogs.failedFileCount,
    eventCount,
    duplicateEventCount,
    unassignedEventCount,
    fingerprintMatchedEventCount,
    loginScopeMatchedEventCount: 0,
    sessionMatchedEventCount,
    explicitIdentityEventCount,
    attributionConfidence: explicitIdentityEventCount > 0
      ? 'high'
      : fingerprintMatchedEventCount + sessionMatchedEventCount > 0
        ? 'medium'
        : unassignedEventCount > 0
          ? 'low'
          : 'unknown',
    latestEventAt: latestEventAt ? new Date(latestEventAt).toISOString() : null,
    last24h: windows.last24h.total,
    last7d: windows.last7d.total,
    last30d: windows.last30d.total
  };
}

async function collectLocalTokenSummary() {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const windows = {
    today: { start: new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate()).getTime(), total: emptyTokenTotals(), models: {}, eventCount: 0 },
    last7d: { start: nowMs - 7 * 24 * 60 * 60 * 1000, total: emptyTokenTotals(), models: {}, eventCount: 0 },
    last30d: { start: nowMs - 30 * 24 * 60 * 60 * 1000, total: emptyTokenTotals(), models: {}, eventCount: 0 }
  };
  let scannedEventCount = 0;
  let duplicateEventCount = 0;
  let latestEventAt = null;
  const files = [
    ...(await collectJsonlFiles(CODEX_SESSIONS_PATH)),
    ...(await collectJsonlFiles(CODEX_ARCHIVED_SESSIONS_PATH))
  ];

  const loadedLogs = await loadTokenLogs(files);
  for (const log of loadedLogs.logs) {
    duplicateEventCount += log.duplicateEventCount;
    for (const event of log.events) {
      const { timestamp, delta, model } = event;
      if (!hasTokenTotals(delta)) {
        continue;
      }
      scannedEventCount += 1;
      for (const window of Object.values(windows)) {
        if (timestamp >= window.start) {
          addTokenTotals(window.total, delta);
          addModelTokenTotals(window.models, model, delta);
          window.eventCount += 1;
        }
      }
      latestEventAt = latestEventAt ? Math.max(latestEventAt, timestamp) : timestamp;
    }
  }

  const mapWindow = (window) => {
    const inputTokens = Number(window.total.inputTokens || 0);
    const cachedInputTokens = Number(window.total.cachedInputTokens || 0);
    return {
      ...window.total,
      cacheRate: inputTokens > 0 ? cachedInputTokens / inputTokens * 100 : null,
      eventCount: window.eventCount,
      modelBreakdown: Object.entries(window.models)
        .map(([model, value]) => {
          const modelInputTokens = Number(value.total.inputTokens || 0);
          const modelCachedInputTokens = Number(value.total.cachedInputTokens || 0);
          return {
            model,
            ...value.total,
            cacheRate: modelInputTokens > 0 ? modelCachedInputTokens / modelInputTokens * 100 : null,
            eventCount: value.eventCount
          };
        })
        .sort((left, right) => right.totalTokens - left.totalTokens)
    };
  };
  return {
    updatedAt: now,
    windows: {
      today: mapWindow(windows.today),
      last7d: mapWindow(windows.last7d),
      last30d: mapWindow(windows.last30d)
    },
    sourceFileCount: loadedLogs.logs.length,
    failedFileCount: loadedLogs.failedFileCount,
    eventCount: scannedEventCount,
    duplicateEventCount,
    latestEventAt: latestEventAt ? new Date(latestEventAt).toISOString() : null
  };
}

async function fetchResetCreditDetails(local) {
  try {
    const response = await fetchJson(`https://chatgpt.com${BACKEND_API_PREFIX}${RESET_CREDITS_PATH}`, {
      headers: {
        authorization: `Bearer ${local.accessToken}`,
        'ChatGPT-Account-Id': local.accountId,
        'OpenAI-Beta': 'codex-1',
        originator: 'Codex Desktop',
        accept: 'application/json'
      }
    }, 12000);
    throwForAuthFailure(response);
    if (!response.ok || !response.json) return null;
    return mapResetCreditDetails(response.json);
  } catch (error) {
    if (error instanceof AuthRequestError) throw error;
    return null;
  }
}

async function fetchAccountTokenUsage(local, previous = null) {
  if (!local?.accessToken || !local?.accountId) return null;
  try {
    const response = await fetchJson(
      `https://chatgpt.com${BACKEND_API_PREFIX}${PROFILE_USAGE_PATH}`,
      {
        headers: {
          authorization: `Bearer ${local.accessToken}`,
          'ChatGPT-Account-Id': local.accountId,
          'OpenAI-Beta': 'codex-1',
          originator: 'Codex Desktop',
          accept: 'application/json'
        }
      },
      12000
    );
    throwForAuthFailure(response);
    if (!response.ok || !response.json) return null;
    return mapAccountTokenUsagePayload(response.json, local.accountKey, previous);
  } catch (error) {
    if (error instanceof AuthRequestError) throw error;
    return null;
  }
}

async function refreshStoredAccount(account) {
  const local = parseCodexAuth(account.authJson);
  const now = new Date().toISOString();
  try {
    if (!hasSwitchableAccountAuth(account)) {
      throw new AuthRequestError(account.authStorageError || '账号凭据不完整，需要重新登录', {
        code: 'missing_credentials',
        authStatus: 'needs_reauth'
      });
    }
    const [usageResult, tokenResult] = await Promise.allSettled([
      fetchUsageForLocalAuth(local),
      fetchAccountTokenUsage(local, account.tokenUsage || null)
    ]);
    const failures = [usageResult, tokenResult]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    const revokedFailure = failures.find((error) => error?.authStatus === 'needs_reauth') || null;
    if (revokedFailure || failures.length === 2) throw revokedFailure || failures[0];
    const fetchedUsage = usageResult.status === 'fulfilled' ? usageResult.value : {};
    const fetchedTokenUsage = tokenResult.status === 'fulfilled' ? tokenResult.value : null;
    const { __authValidated, ...fetchedUsageSnapshot } = fetchedUsage;
    const hasFreshUsage = hasOfficialUsageData(fetchedUsageSnapshot);
    const usage = hasFreshUsage ? fetchedUsageSnapshot : account.usage || fetchedUsageSnapshot;
    const tokenUsage = fetchedTokenUsage || account.tokenUsage || null;
    const profileIdentity = fetchedTokenUsage?.profileIdentity || account.tokenUsage?.profileIdentity || {};
    const resetCards = hasFreshUsage
      ? inferResetCardExpiry(fetchedUsageSnapshot.resetCards || account.resetCards || [], account.resetCards)
      : account.resetCards || account.usage?.resetCards || [];
    const validated = Boolean(__authValidated || fetchedTokenUsage);
    return {
      ...account,
      nickname: profileIdentity.nickname || account.nickname || local.nickname,
      username: profileIdentity.username || account.username || local.username,
      accountKey: local.accountKey || account.accountKey,
      accountId: local.accountId || account.accountId,
      userId: local.userId || account.userId,
      planTier: fetchedUsageSnapshot.planTier || account.planTier || local.planTier,
      membershipExpiresAt: fetchedUsageSnapshot.membershipExpiresAt || account.membershipExpiresAt || local.membershipExpiresAt,
      usage,
      tokenUsage,
      resetCards,
      usageError: failures.length ? '部分账号数据暂时无法刷新，正在显示最近一次结果' : null,
      authStatus: validated ? 'active' : account.authStatus || 'unknown',
      lastValidatedAt: validated ? now : account.lastValidatedAt,
      updatedAt: now,
      lastSyncedAt: hasFreshUsage || fetchedTokenUsage ? now : account.lastSyncedAt
    };
  } catch (error) {
    return {
      ...account,
      usageError: String(error?.message || error || '刷新失败').slice(0, 160),
      authStatus: error?.authStatus || 'stale',
      updatedAt: now
    };
  }
}

async function refreshAccountsStore({
  currentAuthJson = null,
  currentLocal = null,
  currentUsage = null,
  currentTokenUsage = null,
  currentResetCards = [],
  currentAuthStatus = 'active',
  currentUsageError = null,
  syncedAt = null
} = {}) {
  const store = await loadAccountsStore();
  const currentAccountKey = currentLocal?.accountKey || null;
  let currentAccountWasStored = false;
  const nextAccounts = await mapWithConcurrency(
    store.accounts,
    STORED_ACCOUNT_REFRESH_CONCURRENCY,
    async (account) => {
    if (currentAccountKey && account.accountKey === currentAccountKey && currentAuthJson) {
      currentAccountWasStored = true;
      return buildStoredAccount(currentAuthJson, {
        ...currentLocal,
        planTier: currentUsage?.planTier || currentLocal.planTier,
        membershipExpiresAt: currentUsage?.membershipExpiresAt || currentLocal.membershipExpiresAt
      }, {
        ...account,
        usage: hasOfficialUsageData(currentUsage) ? currentUsage : account.usage,
        tokenUsage: currentTokenUsage || account.tokenUsage,
        resetCards: Object.prototype.hasOwnProperty.call(currentUsage || {}, 'resetCards')
          ? currentResetCards
          : account.resetCards,
        usageError: currentUsageError,
        authStatus: currentAuthStatus,
        lastValidatedAt: currentAuthStatus === 'active' ? syncedAt || account.lastValidatedAt : account.lastValidatedAt,
        lastSyncedAt: syncedAt || account.lastSyncedAt
      });
    }
    return refreshStoredAccount(account);
  });
  if (currentAccountKey && currentAuthJson && !currentAccountWasStored) {
    nextAccounts.unshift(buildStoredAccount(currentAuthJson, {
      ...currentLocal,
      planTier: currentUsage?.planTier || currentLocal.planTier,
      membershipExpiresAt: currentUsage?.membershipExpiresAt || currentLocal.membershipExpiresAt
    }, {
      usage: currentUsage || null,
      tokenUsage: currentTokenUsage || null,
      resetCards: currentResetCards || [],
      usageError: currentUsageError,
      authStatus: currentAuthStatus,
      lastValidatedAt: currentAuthStatus === 'active' ? syncedAt || null : null,
      lastSyncedAt: syncedAt || null
    }));
  }
  const uniqueAccounts = [];
  const seen = new Set();
  for (const account of nextAccounts) {
    const key = account.accountKey || account.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueAccounts.push(account);
  }
  const nextStore = { version: accountVault.version, accounts: uniqueAccounts };
  await saveAccountsStore(nextStore);
  return nextStore;
}

function hasSwitchableAccountAuth(account) {
  const auth = account?.authJson;
  return Boolean(
    auth?.auth_mode === 'chatgpt' &&
    auth?.tokens?.access_token &&
    auth?.tokens?.refresh_token
  );
}

async function syncCurrentAuthToStore() {
  const authJson = await readCodexAuthJson();
  const local = parseCodexAuth(authJson);
  const store = await loadAccountsStore();
  if (!authJson || !local.accessToken || !local.accountKey) {
    return { store, currentAccount: null, authJson, local };
  }

  const existingIndex = store.accounts.findIndex((account) => account.accountKey === local.accountKey);
  const existing = existingIndex >= 0 ? store.accounts[existingIndex] : {};
  const account = buildStoredAccount(authJson, local, { ...existing, authStatus: 'active', usageError: null });
  if (existingIndex >= 0) {
    store.accounts[existingIndex] = account;
  } else {
    store.accounts.unshift(account);
  }
  await saveAccountsStore(store);
  return { store, currentAccount: account, authJson, local };
}

async function importCurrentAccount() {
  if (authTransitionInProgress) throw new Error('账号认证正在切换，请稍后再导入');
  authTransitionInProgress = true;
  let result;
  try {
    if (refreshInFlight) await refreshInFlight;
    const authJson = await readCodexAuthJson();
    const local = parseCodexAuth(authJson);
    if (!local.accessToken || !local.accountKey) throw new Error('当前 auth.json 未包含可导入的 Codex ChatGPT 账号');
    const store = await loadAccountsStore();
    const existingIndex = store.accounts.findIndex((account) => account.accountKey === local.accountKey);
    const existing = existingIndex >= 0 ? store.accounts[existingIndex] : {};
    const account = buildStoredAccount(authJson, local, { ...existing, authStatus: 'active', usageError: null });
    if (existingIndex >= 0) store.accounts[existingIndex] = account;
    else store.accounts.unshift(account);
    await saveAccountsStore(store);
    result = {
      account,
      accountKey: local.accountKey,
      status: existingIndex >= 0 ? 'updated' : 'created'
    };
  } finally {
    authTransitionInProgress = false;
  }
  await refreshUsage('import-account');
  return {
    snapshot: getViewSnapshot(),
    account: accountView(result.account, result.accountKey),
    status: result.status
  };
}

async function switchAccount(id, strategy = 'manual') {
  if (authTransitionInProgress) throw new Error('已有账号认证流程正在进行');
  if (typeof id !== 'string' || !id || id.length > 100) throw new Error('账号标识无效');
  authTransitionInProgress = true;
  const normalizedStrategy = strategy === 'auto' ? 'auto' : 'manual';
  let stopped = null;
  let restart = null;
  try {
    if (refreshInFlight) await refreshInFlight;
    const initialStore = await loadAccountsStore();
    const initialTarget = initialStore.accounts.find((item) => item.id === id);
    if (!hasSwitchableAccountAuth(initialTarget)) {
      throw new Error('该账号授权已不完整，请使用“添加账号”流程重新登录');
    }

    if (normalizedStrategy === 'auto') {
      stopped = await stopCodexDesktopApp();
      if (!stopped.ok) throw new Error(stopped.message || '无法安全关闭 Codex 桌面端');
    } else {
      const status = await getCodexAppStatus();
      if (status.running) {
        throw new Error('手动切换前请先完全退出 Codex 桌面端，或改用自动切换');
      }
    }

    const synced = await syncCurrentAuthToStore();
    const account = synced.store.accounts.find((item) => item.id === id);
    if (!hasSwitchableAccountAuth(account)) {
      throw new Error('未找到可切换的有效账号授权');
    }
    const now = new Date().toISOString();
    destroyWebWindow();
    await writeJson(AUTH_PATH, account.authJson, { backup: false });
    account.lastSwitchedAt = now;
    account.updatedAt = now;
    await saveAccountsStore(synced.store);

    if (normalizedStrategy === 'auto') {
      restart = await launchCodexDesktopApp();
    }
    await refreshUsage('switch-account');
    return {
      snapshot: getViewSnapshot(),
      account: accountView(account, account.accountKey),
      switchedAt: now,
      strategy: normalizedStrategy,
      restart: restart
        ? {
            ...restart,
            runningBefore: stopped?.runningBefore || false,
            stopped: stopped?.stopped || false,
            graceful: stopped?.graceful ?? null
          }
        : null
    };
  } catch (error) {
    if (normalizedStrategy === 'auto' && stopped?.runningBefore && (!restart || !restart.ok)) {
      await launchCodexDesktopApp();
    }
    throw error;
  } finally {
    authTransitionInProgress = false;
  }
}

async function prepareAddAccount() {
  if (authTransitionInProgress) throw new Error('已有账号认证流程正在进行');
  authTransitionInProgress = true;
  const authJson = await readCodexAuthJson();
  const local = parseCodexAuth(authJson);
  if (!authJson || !local.accessToken || !local.accountKey) {
    authTransitionInProgress = false;
    throw new Error('当前没有可保存的 Codex ChatGPT 登录，请先完成一次官方登录');
  }

  let stopped = null;
  let authCleared = false;
  try {
    if (refreshInFlight) await refreshInFlight;
    stopped = await stopCodexDesktopApp();
    if (!stopped.ok) throw new Error(stopped.message || '无法安全关闭 Codex 桌面端');
    const synced = await syncCurrentAuthToStore();
    if (!synced.currentAccount) {
      throw new Error('保存当前账号认证失败，未清除现有登录');
    }

    destroyWebWindow();
    await fs.rm(AUTH_PATH, { force: true });
    authCleared = true;
    const launched = await launchCodexDesktopApp();
    return {
      ok: launched.ok,
      account: accountView(synced.currentAccount, synced.currentAccount.accountKey),
      stopped,
      launched,
      message: launched.ok
        ? '已保存当前账号并重新打开 Codex，请登录要添加的新账号，然后返回本工具导入'
        : '已保存当前账号并清除活动登录，请手动打开 Codex 登录新账号'
    };
  } catch (error) {
    if (stopped?.runningBefore && !authCleared) {
      await launchCodexDesktopApp();
    }
    throw error;
  } finally {
    authTransitionInProgress = false;
  }
}

async function deleteAccount(id) {
  if (authTransitionInProgress) throw new Error('账号认证正在切换，请稍后再删除');
  if (typeof id !== 'string' || !id || id.length > 100) throw new Error('账号标识无效');
  authTransitionInProgress = true;
  try {
    if (refreshInFlight) await refreshInFlight;
    const store = await loadAccountsStore();
    const local = await readLocalCodexAuth();
    const target = store.accounts.find((account) => account.id === id);
    if (target?.accountKey && target.accountKey === local.accountKey) {
      throw new Error('不能删除当前正在使用的账号，请先切换到其他账号');
    }
    const nextAccounts = store.accounts.filter((account) => account.id !== id);
    await saveAccountsStore({ version: accountVault.version, accounts: nextAccounts });
  } finally {
    authTransitionInProgress = false;
  }
  await refreshUsage('delete-account');
  return getViewSnapshot();
}

async function fetchUsageForLocalAuth(local) {
  if (!local.accessToken || !local.accountId) return {};
  const resetCardsPromise = fetchResetCreditDetails(local).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error })
  );
  let authValidated = false;
  for (const url of await resolveUsageUrls()) {
    try {
      const response = await fetchJson(url, {
        headers: {
          authorization: `Bearer ${local.accessToken}`,
          'ChatGPT-Account-Id': local.accountId,
          accept: 'application/json'
        }
      }, 12000);
      throwForAuthFailure(response);
      if (!response.ok || !response.json) continue;
      authValidated = true;
      const snapshot = mapOfficialUsagePayload(response.json, url);
      if (hasOfficialUsageData(snapshot)) {
        const resetCardsResult = await resetCardsPromise;
        if (resetCardsResult.error) throw resetCardsResult.error;
        if (resetCardsResult.value) snapshot.resetCards = resetCardsResult.value;
        return { ...snapshot, __authValidated: true };
      }
    } catch (error) {
      if (error instanceof AuthRequestError) throw error;
      // Candidate endpoints can differ across ChatGPT/Codex versions.
    }
  }

  const fallbackEndpoints = [
    'https://chatgpt.com/backend-api/me',
    'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'
  ];
  let merged = {};
  for (const url of fallbackEndpoints) {
    try {
      const response = await fetchJson(url, {
        headers: {
          authorization: `Bearer ${local.accessToken}`,
          'ChatGPT-Account-Id': local.accountId,
          accept: 'application/json'
        }
      }, 6000);
      throwForAuthFailure(response);
      if (!response.ok || !response.json) continue;
      authValidated = true;
      merged = mergeSparse(merged, extractUsageSnapshot(response.json, url));
    } catch (error) {
      if (error instanceof AuthRequestError) throw error;
      // Unpublished endpoints may not exist for all accounts or app versions.
    }
  }
  const resetCardsResult = await resetCardsPromise;
  if (resetCardsResult.error instanceof AuthRequestError) throw resetCardsResult.error;
  return { ...merged, __authValidated: authValidated };
}

function shouldCapture(url) {
  return isAllowedRemoteUrl(url) && /(codex|usage|quota|limit|subscription|account|billing|reset|credit|cap|model)/i.test(url);
}

function isAllowedRemoteUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && REMOTE_HOST_SUFFIXES.some((suffix) =>
      parsed.hostname === suffix || parsed.hostname.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

function responseIdentityMatchesLocal(payload, local) {
  if (!payload || !local?.accountKey) return false;
  const candidateAccount = deepPickByKey(payload, ['chatgpt_account_id', 'account_id', 'accountId']);
  const candidateUser = deepPickByKey(payload, ['chatgpt_user_id', 'user_id', 'userId', 'sub']);
  const profile = extractProfileIdentity(payload);
  const idMatches = [candidateAccount, candidateUser]
    .filter(Boolean)
    .some((value) => {
      const key = identityKey(value);
      return key === local.accountKey || key === identityKey(local.accountId) || key === identityKey(local.userId);
    });
  const emailMatches = Boolean(
    profile.username && local.username &&
    normalizeProfileUsername(profile.username) === normalizeProfileUsername(local.username)
  );
  return idMatches || emailMatches;
}

function rememberRequestId(seen, requestId, maxSize = 500) {
  if (!requestId || seen.has(requestId)) return false;
  seen.add(requestId);
  while (seen.size > maxSize) seen.delete(seen.values().next().value);
  return true;
}

function setupNetworkCapture(win, expectedAccountKey) {
  const seenRequestIds = new Set();
  try {
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.sendCommand('Network.enable');
  } catch {
    return;
  }

  win.webContents.debugger.on('message', async (_event, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const url = params?.response?.url || '';
    if (!shouldCapture(url) || !rememberRequestId(seenRequestIds, params.requestId)) return;
    try {
      const body = await win.webContents.debugger.sendCommand('Network.getResponseBody', {
        requestId: params.requestId
      });
      const text = body?.body || '';
      if (!text || !/[{[]/.test(text[0])) return;
      const json = JSON.parse(text);
      const activeLocal = await readLocalCodexAuth();
      if (activeLocal.accountKey !== expectedAccountKey || !responseIdentityMatchesLocal(json, activeLocal)) return;
      const extracted = extractUsageSnapshot(json, url);
      const hasUsefulData =
        isFiniteNumberValue(extracted.usageRemainingPercent) ||
        Boolean(extracted.usageResetAt) ||
        Boolean(extracted.resetCards?.length);
      if (!hasUsefulData) return;
      await writeJson(debugPath(), {
        url,
        accountKey: expectedAccountKey,
        extracted,
        keys: Object.keys(json || {}),
        capturedAt: new Date().toISOString()
      });
      const capturePatch = { ...extracted };
      if (!extracted.resetCards?.length) delete capturePatch.resetCards;
      const stillActive = await readLocalCodexAuth();
      if (stillActive.accountKey !== expectedAccountKey) return;
      await saveState({
        snapshot: {
          ...capturePatch,
          captureAccountKey: expectedAccountKey,
          lastSyncedAt: new Date().toISOString(),
          sourceStatus: '已同步'
        }
      });
    } catch {
      // Ignore non-JSON, streamed, or protected responses.
    }
  });
}

async function scrapeVisiblePage(local) {
  if (!webWindow || webWindow.isDestroyed() || webWindowAccountKey !== local?.accountKey) return {};
  try {
    const payload = await webWindow.webContents.executeJavaScript(
      `(async () => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const bodyText = clean(document.body ? document.body.innerText : '').slice(0, 200000);
        let sessionIdentity = null;
        try {
          const response = await fetch('/api/auth/session', { credentials: 'include' });
          const data = response.ok ? await response.json() : null;
          sessionIdentity = data ? {
            email: data.user?.email || data.email || null,
            userId: data.user?.id || data.user_id || data.sub || null,
            accountId: data.account?.id || data.account_id || null
          } : null;
        } catch {}
        return { url: location.href, title: document.title, bodyText, sessionIdentity };
      })()`,
      true
    );
    if (!responseIdentityMatchesLocal(payload.sessionIdentity, local)) return {};
    const extracted = {};
    const text = `${payload.title} ${payload.bodyText}`;
    const percentMatch = text.match(/(?:remaining|剩余|可用|usage|用量)[^0-9%]{0,30}(\\d+(?:\\.\\d+)?)\\s*%/i);
    if (percentMatch) extracted.usageRemainingPercent = percentOrNull(percentMatch[1]);
    const planMatch = text.match(/\\b(plus|pro|team|enterprise|business|free)\\b/i);
    if (planMatch) extracted.planTier = planMatch[1].toLowerCase();
    extracted.sourceUrl = payload.url;
    extracted.pageIdentityVerified = true;
    return extracted;
  } catch {
    return {};
  }
}

function createFloatWindow() {
  const size = Math.round((Number(config.windowSize) || 116) + FLOAT_PADDING * 2);
  floatWindow = new BrowserWindow({
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: config.alwaysOnTop !== false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  applyAlwaysOnTop();
  floatWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  floatWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
  floatWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function destroyWebWindow() {
  if (!webWindow || webWindow.isDestroyed()) {
    webWindow = null;
    webWindowAccountKey = null;
    return;
  }
  try {
    if (webWindow.webContents.debugger.isAttached()) webWindow.webContents.debugger.detach();
  } catch {}
  webWindow.destroy();
  webWindow = null;
  webWindowAccountKey = null;
}

function createWebWindow(accountKey) {
  if (!accountKey) return null;
  const partition = `persist:official-openai-usage-${accountKey}`;
  webWindowAccountKey = accountKey;
  webWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    show: false,
    title: 'Codex 工具同步',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  webWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRemoteUrl(url)) event.preventDefault();
  });
  webWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedRemoteUrl(url)) event.preventDefault();
  });
  webWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  webWindow.webContents.session.setPermissionCheckHandler(() => false);
  setupNetworkCapture(webWindow, accountKey);
  webWindow.loadURL(APP_URL);
  webWindow.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      const local = await readLocalCodexAuth();
      if (local.accountKey === accountKey) refreshUsage('page-load');
    }, 1200);
  });
  webWindow.on('closed', () => {
    webWindow = null;
    webWindowAccountKey = null;
  });
  return webWindow;
}

function ensureWebWindowForAccount(accountKey) {
  if (!accountKey) {
    destroyWebWindow();
    return null;
  }
  if (webWindow && !webWindow.isDestroyed() && webWindowAccountKey === accountKey) return webWindow;
  destroyWebWindow();
  return createWebWindow(accountKey);
}

async function refreshUsage(reason = 'manual') {
  if (authTransitionInProgress && reason !== 'switch-account') return getViewSnapshot();
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshUsageInternal(reason).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshUsageInternal(reason = 'manual') {
  const currentAuthJson = await readCodexAuthJson();
  const local = parseCodexAuth(currentAuthJson);
  if (!local.accountKey || !local.accessToken) {
    ensureWebWindowForAccount(null);
    const [accountsStore, localTokenSummary] = await Promise.all([
      refreshAccountsStore(),
      collectLocalTokenSummary()
    ]);
    const syncedAt = new Date().toISOString();
    await saveState({
      snapshot: {
        planTier: null,
        membershipExpiresAt: null,
        usageRemainingPercent: null,
        usageResetAt: null,
        usageWindows: {},
        creditsBalance: null,
        credits: null,
        resetCards: [],
        tokenUsage: null,
        currentAccount: null,
        accounts: accountsStore.accounts.map((account) => accountView(account, null)),
        resetCardsAccountLabel: '--',
        localTokenSummary,
        lastSyncedAt: syncedAt,
        sourceStatus: '等待登录 Codex',
        sourceUrl: '',
        captureAccountKey: null,
        obsoleteStatus: null
      }
    }, ['usageWindows', 'tokenUsage', 'accounts', 'currentAccount', 'localTokenSummary', 'resetCards']);
    return getViewSnapshot();
  }

  ensureWebWindowForAccount(local.accountKey);
  const previousTokenUsage = state.snapshot?.tokenUsage;
  const sameAccount = Boolean(local.accountKey && previousTokenUsage?.accountKey === local.accountKey);
  const tokenScopeStartedAt = sameAccount
    ? previousTokenUsage.scopeStartedAt || local.authIssuedAt
    : local.authIssuedAt || new Date().toISOString();
  const [directResult, pageResult, accountTokenResult] = await Promise.allSettled([
    fetchUsageForLocalAuth(local),
    scrapeVisiblePage(local),
    fetchAccountTokenUsage(local, sameAccount ? previousTokenUsage : null)
  ]);
  const failures = [directResult, accountTokenResult]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  const authFailure = failures.find((error) => error instanceof AuthRequestError) || null;
  const directResultValue = directResult.status === 'fulfilled' ? directResult.value : {};
  const { __authValidated = false, ...direct } = directResultValue;
  const page = pageResult.status === 'fulfilled' ? pageResult.value : {};
  const accountTokenUsage = accountTokenResult.status === 'fulfilled' ? accountTokenResult.value : null;
  const currentAuthStatus = authFailure?.authStatus === 'needs_reauth'
    ? 'needs_reauth'
    : __authValidated || accountTokenUsage
      ? 'active'
      : authFailure?.authStatus || 'stale';
  const currentUsageError = authFailure
    ? String(authFailure.message || '账号凭据暂时不可用').slice(0, 160)
    : failures.length
      ? '部分账号数据暂时无法刷新，正在显示最近一次结果'
      : null;
  const fallback = mergeSparse(
    {
      planTier: local.planTier,
      membershipExpiresAt: local.membershipExpiresAt
    },
    page
  );
  const merged = mergeSparse(fallback, direct);
  const currentWeeklyResetAt = direct.usageWindows?.oneWeek?.resetAt || (
    sameAccount ? state.snapshot?.usageWindows?.oneWeek?.resetAt : null
  );
  let tokenUsage = accountTokenUsage;
  if (!tokenUsage?.today && !tokenUsage?.last7d && !tokenUsage?.last30d) {
    const localEstimate = await collectTokenUsageSnapshot({
      accountKey: local.accountKey,
      userId: local.userId,
      accountId: local.accountId,
      scopeStartedAt: tokenScopeStartedAt,
      previousAssignments: previousTokenUsage?.accountAssignments,
      previousEvidenceLastRowId: previousTokenUsage?.evidenceLastRowId,
      previousFingerprints: previousTokenUsage?.fingerprintAssignments,
      previousFingerprintVersion: previousTokenUsage?.fingerprintVersion,
      currentWeeklyResetAt
    });
    tokenUsage = {
      ...localEstimate,
      profileIdentity: accountTokenUsage?.profileIdentity || localEstimate.profileIdentity
    };
  }
  if (!tokenUsage.source) {
    tokenUsage.source = 'local-estimate';
    tokenUsage.sourceLabel = '\u672c\u5730\u4f30\u7b97';
  }
  const profileIdentity = tokenUsage.profileIdentity || {};
  const currentLocal = {
    ...local,
    profileIdentity,
    nickname: profileIdentity.nickname || local.nickname,
    username: profileIdentity.username || local.username
  };
  const localTokenSummary = await collectLocalTokenSummary();
  const hasUsage =
    isFiniteNumberValue(merged.usageRemainingPercent) ||
    Boolean(merged.usageWindows?.fiveHour) ||
    Boolean(merged.usageWindows?.oneWeek) ||
    Boolean(merged.resetCards?.length);
  const statusText = currentAuthStatus === 'needs_reauth'
    ? '账号登录已失效，请使用“添加账号”流程重新登录'
    : currentUsageError
      ? currentUsageError
    : hasUsage
    ? '\u5df2\u540c\u6b65'
    : reason === 'manual'
      ? '\u5df2\u5237\u65b0\u4f1a\u5458\u4fe1\u606f\uff1b\u8bf7\u6253\u5f00\u7f51\u9875\u767b\u5f55\u6216\u8fdb\u5165 Codex \u76f8\u5173\u9875\u9762\u4ee5\u6355\u83b7\u7528\u91cf'
      : state.snapshot?.sourceStatus || '\u7b49\u5f85\u6355\u83b7\u5b9e\u65f6\u7528\u91cf';
  const syncedAt = new Date().toISOString();
  const resetCards = Object.prototype.hasOwnProperty.call(merged, 'resetCards')
    ? inferResetCardExpiry(merged.resetCards || [], sameAccount ? state.snapshot?.resetCards : [])
    : sameAccount
      ? state.snapshot?.resetCards || []
      : [];
  const accountsStore = await refreshAccountsStore({
    currentAuthJson,
    currentLocal,
    currentUsage: merged,
    currentTokenUsage: tokenUsage,
    currentResetCards: resetCards,
    currentAuthStatus,
    currentUsageError,
    syncedAt
  });
  const currentAccount = accountFromCurrent(
    currentLocal,
    merged,
    tokenUsage,
    resetCards,
    syncedAt,
    currentAuthStatus,
    currentUsageError
  );
  const storedAccountViews = accountsStore.accounts.map((account) => accountView(account, currentLocal.accountKey));
  const accountViews = storedAccountViews.some((account) => account.accountKey === currentLocal.accountKey)
    ? storedAccountViews
    : [currentAccount, ...storedAccountViews];

  await saveState({
    snapshot: {
      ...merged,
      creditsBalance: null,
      credits: null,
      resetCards,
      tokenUsage,
      currentAccount,
      accounts: accountViews,
      resetCardsAccountLabel: accountLabel(currentAccount),
      localTokenSummary,
      lastSyncedAt: syncedAt,
      sourceStatus: statusText,
      obsoleteStatus: null
    }
  }, ['tokenUsage', 'accounts', 'currentAccount', 'localTokenSummary', 'resetCards']);
  return getViewSnapshot();
}

async function openWebWindow() {
  const local = await readLocalCodexAuth();
  if (!local.accountKey) throw new Error('请先登录 Codex 账号');
  const win = ensureWebWindowForAccount(local.accountKey);
  win.show();
  win.focus();
  if (!win.webContents.getURL()) win.loadURL(APP_URL);
}

function positionPanel(open) {
  if (!floatWindow) return null;
  const [x, y] = floatWindow.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  const workArea = display.workArea;
  const orbOuter = Math.round((Number(config.windowSize) || 116) + FLOAT_PADDING * 2);
  const openWidth = PANEL_WIDTH + PANEL_GAP + orbOuter + PANEL_EDGE_PADDING;
  const openHeight = Math.max(PANEL_HEIGHT, orbOuter);

  if (open) {
    const orbX = panelState.open ? panelState.orbX : x;
    const orbY = panelState.open ? panelState.orbY : y;
    const openLeft = orbX + orbOuter + PANEL_GAP + PANEL_WIDTH + PANEL_EDGE_PADDING <= workArea.x + workArea.width;
    const side = openLeft ? 'right' : 'left';
    const idealX = side === 'right' ? orbX : orbX - PANEL_WIDTH - PANEL_GAP;
    const nextX = Math.max(workArea.x, Math.min(idealX, workArea.x + workArea.width - openWidth));
    const nextY = Math.max(workArea.y, Math.min(orbY, workArea.y + workArea.height - openHeight));
    const orbCssX = Math.max(FLOAT_PADDING, Math.min(orbX - nextX + FLOAT_PADDING, openWidth - orbOuter + FLOAT_PADDING));
    const orbCssY = Math.max(FLOAT_PADDING, Math.min(orbY - nextY + FLOAT_PADDING, openHeight - orbOuter + FLOAT_PADDING));
    const panelCssX = side === 'right' ? orbCssX + orbOuter + PANEL_GAP : Math.max(FLOAT_PADDING, orbCssX - PANEL_WIDTH - PANEL_GAP);
    panelState = { open: true, side, orbX, orbY };
    floatWindow.setBounds({ x: nextX, y: nextY, width: openWidth, height: openHeight });
    return { side, orbX: orbCssX, panelX: panelCssX, orbY: orbCssY };
  }

  const nextPosition = clampWindowPosition(
    panelState.open ? panelState.orbX : x,
    panelState.open ? panelState.orbY : y,
    orbOuter,
    orbOuter,
    display
  );
  const nextX = nextPosition.x;
  const nextY = nextPosition.y;
  panelState = { ...panelState, open: false };
  floatWindow.setBounds({ x: nextX, y: nextY, width: orbOuter, height: orbOuter });
  return { side: panelState.side, orbX: FLOAT_PADDING, panelX: FLOAT_PADDING, orbY: FLOAT_PADDING };
}

function applyAlwaysOnTop() {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  const enabled = config.alwaysOnTop !== false;
  if (enabled) floatWindow.setAlwaysOnTop(true, 'screen-saver');
  else floatWindow.setAlwaysOnTop(false);
}

function clampWindowPosition(x, y, width, height, preferredDisplay = null) {
  const display = preferredDisplay || screen.getDisplayNearestPoint({ x: x + width / 2, y: y + height / 2 });
  const workArea = display.workArea;
  return {
    x: Math.max(workArea.x, Math.min(Math.round(x), workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(Math.round(y), workArea.y + workArea.height - height))
  };
}

function resizeOpenPanelHeight(contentHeight) {
  if (!floatWindow || !panelState.open) return null;
  const [x, y] = floatWindow.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  const workArea = display.workArea;
  const orbOuter = Math.round((Number(config.windowSize) || 116) + FLOAT_PADDING * 2);
  const openWidth = PANEL_WIDTH + PANEL_GAP + orbOuter + PANEL_EDGE_PADDING;
  const desiredHeight = Math.max(
    orbOuter,
    Math.min(Math.ceil(Number(contentHeight) || PANEL_HEIGHT), workArea.height - PANEL_EDGE_PADDING * 2)
  );
  const nextY = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - desiredHeight));
  floatWindow.setBounds({ x, y: nextY, width: openWidth, height: desiredHeight });
  if (nextY !== y) panelState.orbY = Math.round(panelState.orbY + (nextY - y));
  const orbCssX = Math.max(FLOAT_PADDING, Math.min(panelState.orbX - x + FLOAT_PADDING, openWidth - orbOuter + FLOAT_PADDING));
  const orbCssY = Math.max(FLOAT_PADDING, Math.min(panelState.orbY - nextY + FLOAT_PADDING, desiredHeight - orbOuter + FLOAT_PADDING));
  const panelCssX = panelState.side === 'right'
    ? orbCssX + orbOuter + PANEL_GAP
    : Math.max(FLOAT_PADDING, orbCssX - PANEL_WIDTH - PANEL_GAP);
  return {
    side: panelState.side,
    orbX: orbCssX,
    panelX: panelCssX,
    orbY: orbCssY
  };
}

function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  const minutes = normalizeRefreshInterval(config.refreshIntervalMinutes);
  refreshTimer = setInterval(() => {
    refreshUsage('timer').catch(() => {});
  }, minutes * 60 * 1000);
}

app.whenReady().then(async () => {
  if (SELF_TEST_MODE) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage is unavailable');
    const status = await getCodexAppStatus();
    if (process.platform === 'win32' && !status.appId) throw new Error('Codex app id was not detected');
    app.exit(0);
    return;
  }
  app.setAppUserModelId('com.codexusage.float');
  await loadState();
  createFloatWindow();
  try {
    await refreshUsage('startup');
  } catch (error) {
    await saveState({
      snapshot: {
        sourceStatus: `初始化失败：${String(error?.message || error || '未知错误').slice(0, 160)}`,
        lastSyncedAt: new Date().toISOString()
      }
    });
  }
  startRefreshTimer();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
    if (!senderUrl.startsWith('file:')) throw new Error('拒绝来自非本地页面的操作');
    return handler(...args);
  });
}

handleTrusted('usage:get', () => getViewSnapshot());
handleTrusted('settings:get', () => getSettingsSnapshot());
handleTrusted('settings:save', async (patch = {}) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的设置');
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'refreshIntervalMinutes')) {
    config.refreshIntervalMinutes = normalizeRefreshInterval(patch.refreshIntervalMinutes, config.refreshIntervalMinutes);
    startRefreshTimer();
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'alwaysOnTop')) {
    if (typeof patch.alwaysOnTop !== 'boolean') throw new Error('显示模式设置无效');
    config.alwaysOnTop = patch.alwaysOnTop;
    applyAlwaysOnTop();
    changed = true;
  }
  if (changed) await writeJson(configPath(), config);
  return getSettingsSnapshot();
});
handleTrusted('usage:refresh', () => refreshUsage('manual'));
handleTrusted('usage:open-web', () => openWebWindow());
handleTrusted('accounts:prepare-add', () => prepareAddAccount());
handleTrusted('accounts:import-current', () => importCurrentAccount());
handleTrusted('accounts:switch', (id, strategy) => switchAccount(id, strategy));
handleTrusted('accounts:delete', (id) => deleteAccount(id));
handleTrusted('local-token-summary:refresh', async () => {
  const localTokenSummary = await collectLocalTokenSummary();
  await saveState({ snapshot: { localTokenSummary } }, ['localTokenSummary']);
  return getViewSnapshot();
});
handleTrusted('window:set-size', async (size) => {
  const next = Math.max(86, Math.min(Number(size) || config.windowSize, 220));
  config.windowSize = next;
  let layout = null;
  if (panelState.open) {
    layout = positionPanel(true);
  } else {
    const outer = Math.round(next + FLOAT_PADDING * 2);
    floatWindow.setSize(outer, outer);
    const [x, y] = floatWindow.getPosition();
    const clamped = clampWindowPosition(x, y, outer, outer);
    floatWindow.setPosition(clamped.x, clamped.y, false);
  }
  await writeJson(configPath(), config);
  return { size: next, layout };
});
handleTrusted('window:move-by', (delta) => {
  if (!floatWindow || !delta) return null;
  const moveX = Math.max(-200, Math.min(Number(delta.x) || 0, 200));
  const moveY = Math.max(-200, Math.min(Number(delta.y) || 0, 200));
  const [x, y] = floatWindow.getPosition();
  const [width, height] = floatWindow.getSize();
  const display = screen.getDisplayNearestPoint({ x: x + moveX + width / 2, y: y + moveY + height / 2 });
  const next = clampWindowPosition(x + moveX, y + moveY, width, height, display);
  floatWindow.setPosition(next.x, next.y, false);
  const appliedX = next.x - x;
  const appliedY = next.y - y;
  if (panelState.open) {
    panelState.orbX = Math.round(panelState.orbX + appliedX);
    panelState.orbY = Math.round(panelState.orbY + appliedY);
  }
  return null;
});
handleTrusted('window:set-panel-height', (height) => resizeOpenPanelHeight(height));
handleTrusted('window:set-detail-open', (open) => positionPanel(Boolean(open)));
handleTrusted('external:open-repo', () => shell.openExternal(GITHUB_REPO_URL));
handleTrusted('app:quit', () => app.quit());

app.on('before-quit', () => {
  try {
    webWindow?.webContents.session.flushStorageData();
  } catch {
    // Best effort only.
  }
  destroyWebWindow();
});
