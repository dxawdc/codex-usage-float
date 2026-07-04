const { app, BrowserWindow, ipcMain, screen, shell, session, net } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs/promises');
const { execFile } = require('child_process');

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
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const TOKEN_FINGERPRINT_VERSION = 4;

let floatWindow;
let webWindow;
let refreshTimer;
let panelState = { open: false, side: 'right', orbX: 0, orbY: 0 };
let config = { windowSize: 116 };
let state = createEmptyState();
const seenRequestIds = new Set();

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

function runPowerShell(script, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error).trim()));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function codexProcessFilterScript() {
  const currentPid = Number(process.pid) || 0;
  return `
    $currentPid = ${currentPid}
    Get-CimInstance Win32_Process | Where-Object {
      $_.ProcessId -ne $currentPid -and
      $_.Name -notmatch 'CodexUsageFloat|electron' -and
      ($_.ExecutablePath -notmatch 'codex-usage-float|codex用量|CodexUsageFloat') -and
      (
        $_.Name -match '^(Codex|OpenAI Codex)(\\.exe)?$' -or
        $_.ExecutablePath -match '\\\\(Codex|OpenAI Codex)\\\\.*Codex.*\\.exe$'
      )
    }
  `;
}

function normalizeProcessList(jsonText) {
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter(Boolean)
      .map((item) => ({
        processId: Number(item.ProcessId || item.processId),
        name: item.Name || item.name || '',
        executablePath: item.ExecutablePath || item.executablePath || ''
      }))
      .filter((item) => Number.isFinite(item.processId));
  } catch {
    return [];
  }
}

async function getCodexAppStatus() {
  if (process.platform !== 'win32') {
    return { platform: process.platform, running: false, count: 0, processes: [], canAutoRestart: false };
  }
  const stdout = await runPowerShell(`
    $items = @(${codexProcessFilterScript()})
    $items | Select-Object ProcessId, Name, ExecutablePath | ConvertTo-Json -Compress
  `, 8000);
  const processes = normalizeProcessList(stdout);
  return {
    platform: process.platform,
    running: processes.length > 0,
    count: processes.length,
    canAutoRestart: processes.some((item) => item.executablePath),
    processes
  };
}

async function restartCodexApp() {
  if (process.platform !== 'win32') {
    return { ok: false, message: '当前平台暂不支持自动重启 Codex' };
  }
  const status = await getCodexAppStatus();
  if (!status.running) {
    return { ok: true, runningBefore: false, restarted: false, message: '未检测到正在运行的 Codex，下次启动会使用已切换账号' };
  }
  const paths = [...new Set(status.processes.map((item) => item.executablePath).filter(Boolean))];
  if (!paths.length) {
    return { ok: false, runningBefore: true, restarted: false, message: '检测到 Codex 正在运行，但无法定位可重启的程序路径' };
  }
  const payload = Buffer.from(JSON.stringify({
    pids: status.processes.map((item) => item.processId),
    paths
  }), 'utf8').toString('base64');
  const stdout = await runPowerShell(`
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
    foreach ($targetPid in @($payload.pids)) {
      Stop-Process -Id ([int]$targetPid) -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 900
    foreach ($path in @($payload.paths)) {
      if ($path -and (Test-Path -LiteralPath $path)) {
        Start-Process -FilePath $path | Out-Null
      }
    }
    @{ ok = $true; runningBefore = $true; restarted = $true; count = @($payload.pids).Count } | ConvertTo-Json -Compress
  `, 15000);
  try {
    return JSON.parse(stdout);
  } catch {
    return { ok: true, runningBefore: true, restarted: true, message: '已发起 Codex 重启' };
  }
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
      refreshIntervalMinutes: 30,
      lowUsageThresholdPercent: 20,
      criticalUsageThresholdPercent: 8
    },
    alertState: {}
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempFile, file);
}

function mergeDefined(base, patch) {
  const next = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      next[key] = value;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      next[key] = mergeDefined(next[key] || {}, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

async function loadState() {
  config = { ...config, ...(await readJson(configPath(), config)) };
  state = mergeDefined(createEmptyState(), await readJson(statePath(), createEmptyState()));
}

async function saveState(patch, replaceSnapshotKeys = []) {
  state = mergeDefined(state, patch);
  for (const key of replaceSnapshotKeys) {
    if (Object.prototype.hasOwnProperty.call(patch?.snapshot || {}, key)) {
      state.snapshot[key] = patch.snapshot[key];
    }
  }
  await writeJson(statePath(), state);
  floatWindow?.webContents.send('usage-data', getViewSnapshot());
}

function getViewSnapshot() {
  const snapshot = state.snapshot || {};
  const fiveHourRemaining = snapshot.usageWindows?.fiveHour?.remainingPercent;
  const remainingPercent = Number.isFinite(Number(fiveHourRemaining))
    ? fiveHourRemaining
    : snapshot.usageRemainingPercent;
  return {
    ...snapshot,
    windowSize: Number(config.windowSize) || 116,
    statusLevel: statusLevel(remainingPercent),
    hasUsageData:
      Number.isFinite(Number(snapshot.usageRemainingPercent)) ||
      Boolean(snapshot.usageWindows?.fiveHour) ||
      Boolean(snapshot.usageWindows?.oneWeek)
  };
}

function statusLevel(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return 'unknown';
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
    getPathValue(payload, 'user_name'),
    getPathValue(payload, 'userName'),
    getPathValue(payload, 'handle'),
    getPathValue(payload, 'profile.username'),
    getPathValue(payload, 'profile.user_name'),
    getPathValue(payload, 'profile.userName'),
    getPathValue(payload, 'profile.handle'),
    getPathValue(payload, 'user.username'),
    getPathValue(payload, 'user.user_name'),
    getPathValue(payload, 'user.userName'),
    getPathValue(payload, 'user.handle'),
    getPathValue(payload, 'account.username'),
    getPathValue(payload, 'account.user_name'),
    getPathValue(payload, 'account.userName'),
    getPathValue(payload, 'account.handle'),
    deepPickByKey(payload, ['username', 'user_name', 'userName', 'handle'])
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
  return parseCodexAuth(await readJson(AUTH_PATH, null));
}

function identityKey(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

async function loadAccountsStore() {
  const store = await readJson(accountsPath(), { version: 1, accounts: [] });
  return {
    version: 1,
    accounts: Array.isArray(store?.accounts) ? store.accounts : []
  };
}

async function saveAccountsStore(store) {
  await writeJson(accountsPath(), {
    version: 1,
    accounts: Array.isArray(store?.accounts) ? store.accounts : []
  });
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
    lastSyncedAt: account.lastSyncedAt || account.updatedAt || null,
    lastSwitchedAt: account.lastSwitchedAt || null
  };
}

function accountFromCurrent(local, usage, tokenUsage, resetCards, syncedAt) {
  return {
    id: 'current',
    nickname: local.nickname,
    username: local.username,
    label: accountLabel(local),
    accountKey: local.accountKey,
    accountId: local.accountId,
    userId: local.userId,
    planTier: usage?.planTier || local.planTier,
    membershipExpiresAt: usage?.membershipExpiresAt || local.membershipExpiresAt,
    usage: { usageWindows: usage?.usageWindows || {}, resetCards },
    usageWindows: usage?.usageWindows || {},
    resetCards: resetCards || [],
    tokenUsage: tokenUsage || null,
    isCurrent: true,
    lastSyncedAt: syncedAt
  };
}

async function refreshFromLocalAuth() {
  try {
    const local = await readLocalCodexAuth();
    await saveState({
      snapshot: {
        planTier: local.planTier,
        membershipExpiresAt: local.membershipExpiresAt,
        lastSyncedAt: new Date().toISOString(),
        sourceStatus: local.planTier
          ? '已读取本机 Codex 会员信息，等待捕获实时用量'
          : '未找到 Codex ChatGPT 会员信息'
      }
    });
    return local;
  } catch {
    await saveState({
      snapshot: {
        lastSyncedAt: new Date().toISOString(),
        sourceStatus: '读取本机 Codex 登录信息失败'
      }
    });
    return {};
  }
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
    .filter((window) => Number.isFinite(Number(window.windowSeconds)))
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

function inferResetCardExpiry(cards = []) {
  const previous = Array.isArray(state.snapshot?.resetCards) ? state.snapshot.resetCards : [];
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
    Number.isFinite(Number(snapshot?.usageRemainingPercent)) ||
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

function readThreadAccountEvidence(previousAssignments = {}) {
  const assignments = { ...(previousAssignments || {}) };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return assignments;
  }

  let database;
  try {
    database = new DatabaseSync(CODEX_LOGS_DB_PATH, { readOnly: true });
    const rows = database.prepare(`
      select thread_id, ts, feedback_log_body
      from logs
      where thread_id is not null
        and target = 'codex_client::transport'
        and feedback_log_body like '%chatgpt_account_id%'
    `).all();
    const candidates = new Map();
    for (const row of rows) {
      const normalized = String(row.feedback_log_body || '').replace(/\\\"/g, '"').replace(/\\n/g, ' ');
      const matches = [...normalized.matchAll(/"chatgpt_account_id"\s*:\s*"([A-Za-z0-9_-]{8,})"/gi)];
      if (!matches.length) continue;
      const candidate = candidates.get(row.thread_id) || { keys: new Set(), observedAt: new Set() };
      for (const match of matches) candidate.keys.add(identityKey(match[1]));
      if (Number.isFinite(Number(row.ts))) candidate.observedAt.add(new Date(Number(row.ts) * 1000).toISOString());
      candidates.set(row.thread_id, candidate);
    }
    for (const [threadId, candidate] of candidates) {
      if (candidate.keys.size === 1) {
        assignments[threadId] = {
          accountKey: [...candidate.keys][0],
          source: 'local-log',
          observedAt: [...candidate.observedAt].sort()
        };
      }
    }
  } catch {
    return assignments;
  } finally {
    database?.close();
  }
  return assignments;
}

async function collectTokenUsageSnapshot({
  accountKey = null,
  userId = null,
  accountId = null,
  scopeStartedAt = null,
  previousAssignments = {},
  previousFingerprints = {},
  previousFingerprintVersion = null,
  currentWeeklyResetAt = null
} = {}) {
  const now = Date.now();
  const scopeStart = Date.parse(scopeStartedAt);
  const currentUserKey = identityKey(userId);
  const currentAccountKey = identityKey(accountId) || accountKey;
  const accountAssignments = readThreadAccountEvidence(previousAssignments);
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
  let loginScopeMatchedEventCount = 0;
  let explicitIdentityEventCount = 0;
  let latestEventAt = null;
  const files = [
    ...(await collectJsonlFiles(CODEX_SESSIONS_PATH)),
    ...(await collectJsonlFiles(CODEX_ARCHIVED_SESSIONS_PATH))
  ];

  const events = [];
  for (const file of files) {
    const sessionId = sessionIdFromPath(file);
    const sessionAssignment = sessionId ? accountAssignments[sessionId] : null;
    let previousTotal = emptyTokenTotals();
    let previousFingerprint = null;
    let contents;
    try {
      contents = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let root;
      try {
        root = JSON.parse(line);
      } catch {
        continue;
      }
      if (root?.type !== 'event_msg' || root?.payload?.type !== 'token_count') continue;
      const timestamp = Date.parse(root.timestamp);
      const cumulative = parseTokenTotals(root.payload?.info?.total_token_usage);
      const last = parseTokenTotals(root.payload?.info?.last_token_usage);
      if (!Number.isFinite(timestamp) || (!cumulative && !last)) continue;
      const delta = cumulative ? subtractTokenTotals(cumulative, previousTotal) : last;
      if (cumulative) previousTotal = cumulative;
      if (!hasTokenTotals(delta)) duplicateEventCount += 1;

      const rateLimits = root.payload?.rate_limits;
      const fingerprint = rateLimitFingerprint(rateLimits?.secondary?.resets_at);
      if (fingerprint && previousFingerprint && fingerprint !== previousFingerprint) {
        const previousResetAt = Date.parse(previousFingerprint);
        if (Number.isFinite(previousResetAt) && previousResetAt <= timestamp + 10 * 60 * 1000) {
          addFingerprintEdge(fingerprintEdges, previousFingerprint, fingerprint);
        }
      }
      if (fingerprint) previousFingerprint = fingerprint;
      const eventAccountKey = identityKey(rateLimits?.account_id);
      const eventUserKey = identityKey(rateLimits?.user_id);
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
          root.timestamp
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
      } else if (Number.isFinite(scopeStart) && timestamp >= scopeStart) {
        belongsToCurrentAccount = true;
        loginScopeMatchedEventCount += 1;
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
    fingerprintAssignments,
    fingerprintVersion: TOKEN_FINGERPRINT_VERSION,
    trackedAccountCount: new Set([
      currentAccountKey,
      ...Object.values(accountAssignments).map((item) => item?.accountKey),
      ...Object.values(fingerprintAssignments).map((item) => item?.accountKey)
    ].filter(Boolean)).size,
    fingerprintCount: Object.values(fingerprintAssignments).filter((item) => !item?.ambiguous).length,
    conflictingFingerprintCount: Object.values(fingerprintAssignments).filter((item) => item?.ambiguous).length,
    sourceFileCount: files.length,
    eventCount,
    duplicateEventCount,
    unassignedEventCount,
    fingerprintMatchedEventCount,
    loginScopeMatchedEventCount,
    explicitIdentityEventCount,
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
    today: { start: new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate()).getTime(), total: emptyTokenTotals(), eventCount: 0 },
    last7d: { start: nowMs - 7 * 24 * 60 * 60 * 1000, total: emptyTokenTotals(), eventCount: 0 },
    last30d: { start: nowMs - 30 * 24 * 60 * 60 * 1000, total: emptyTokenTotals(), eventCount: 0 }
  };
  let sourceFileCount = 0;
  let failedFileCount = 0;
  let scannedEventCount = 0;
  let duplicateEventCount = 0;
  let latestEventAt = null;
  const files = [
    ...(await collectJsonlFiles(CODEX_SESSIONS_PATH)),
    ...(await collectJsonlFiles(CODEX_ARCHIVED_SESSIONS_PATH))
  ];

  for (const file of files) {
    sourceFileCount += 1;
    let previousTotal = emptyTokenTotals();
    let contents;
    try {
      contents = await fs.readFile(file, 'utf8');
    } catch {
      failedFileCount += 1;
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim() || !line.includes('"token_count"')) continue;
      let root;
      try {
        root = JSON.parse(line);
      } catch {
        continue;
      }
      if (root?.type !== 'event_msg' || root?.payload?.type !== 'token_count') continue;
      const timestamp = Date.parse(root.timestamp);
      const cumulative = parseTokenTotals(root.payload?.info?.total_token_usage);
      const last = parseTokenTotals(root.payload?.info?.last_token_usage);
      if (!Number.isFinite(timestamp) || (!cumulative && !last)) continue;
      const delta = cumulative ? subtractTokenTotals(cumulative, previousTotal) : last;
      if (cumulative) previousTotal = cumulative;
      if (!hasTokenTotals(delta)) {
        duplicateEventCount += 1;
        continue;
      }
      scannedEventCount += 1;
      for (const window of Object.values(windows)) {
        if (timestamp >= window.start) {
          addTokenTotals(window.total, delta);
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
      eventCount: window.eventCount
    };
  };
  return {
    updatedAt: now,
    windows: {
      today: mapWindow(windows.today),
      last7d: mapWindow(windows.last7d),
      last30d: mapWindow(windows.last30d)
    },
    sourceFileCount,
    failedFileCount,
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
    if (!response.ok || !response.json) return null;
    return mapResetCreditDetails(response.json);
  } catch {
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
    if (!response.ok || !response.json) return null;
    return mapAccountTokenUsagePayload(response.json, local.accountKey, previous);
  } catch {
    return null;
  }
}

async function refreshStoredAccount(account) {
  const local = parseCodexAuth(account.authJson);
  const now = new Date().toISOString();
  try {
    const [fetchedUsage, fetchedTokenUsage] = await Promise.all([
      fetchUsageForLocalAuth(local),
      fetchAccountTokenUsage(local, account.tokenUsage || null)
    ]);
    const hasFreshUsage = hasOfficialUsageData(fetchedUsage);
    const usage = hasFreshUsage ? fetchedUsage : account.usage || fetchedUsage;
    const tokenUsage = fetchedTokenUsage || account.tokenUsage || null;
    const profileIdentity = fetchedTokenUsage?.profileIdentity || account.tokenUsage?.profileIdentity || {};
    const resetCards = hasFreshUsage
      ? inferResetCardExpiry(fetchedUsage.resetCards || account.resetCards || [])
      : account.resetCards || account.usage?.resetCards || [];
    return {
      ...account,
      nickname: profileIdentity.nickname || account.nickname || local.nickname,
      username: profileIdentity.username || account.username || local.username,
      accountKey: local.accountKey || account.accountKey,
      accountId: local.accountId || account.accountId,
      userId: local.userId || account.userId,
      planTier: fetchedUsage.planTier || account.planTier || local.planTier,
      membershipExpiresAt: fetchedUsage.membershipExpiresAt || account.membershipExpiresAt || local.membershipExpiresAt,
      usage,
      tokenUsage,
      resetCards,
      usageError: null,
      updatedAt: now,
      lastSyncedAt: hasFreshUsage || fetchedTokenUsage ? now : account.lastSyncedAt
    };
  } catch (error) {
    return {
      ...account,
      usageError: String(error?.message || error || '刷新失败').slice(0, 160),
      updatedAt: now
    };
  }
}

async function refreshAccountsStore({ currentAuthJson = null, currentLocal = null, currentUsage = null, currentTokenUsage = null, currentResetCards = [], syncedAt = null } = {}) {
  const store = await loadAccountsStore();
  const currentAccountKey = currentLocal?.accountKey || null;
  const nextAccounts = [];
  let currentAccountWasStored = false;
  for (const account of store.accounts) {
    if (currentAccountKey && account.accountKey === currentAccountKey && currentAuthJson) {
      currentAccountWasStored = true;
      nextAccounts.push(buildStoredAccount(currentAuthJson, {
        ...currentLocal,
        planTier: currentUsage?.planTier || currentLocal.planTier,
        membershipExpiresAt: currentUsage?.membershipExpiresAt || currentLocal.membershipExpiresAt
      }, {
        ...account,
        usage: currentUsage || account.usage,
        tokenUsage: currentTokenUsage || account.tokenUsage,
        resetCards: currentResetCards || account.resetCards,
        usageError: null,
        lastSyncedAt: syncedAt || account.lastSyncedAt
      }));
    } else {
      nextAccounts.push(await refreshStoredAccount(account));
    }
  }
  if (currentAccountKey && currentAuthJson && !currentAccountWasStored) {
    nextAccounts.unshift(buildStoredAccount(currentAuthJson, {
      ...currentLocal,
      planTier: currentUsage?.planTier || currentLocal.planTier,
      membershipExpiresAt: currentUsage?.membershipExpiresAt || currentLocal.membershipExpiresAt
    }, {
      usage: currentUsage || null,
      tokenUsage: currentTokenUsage || null,
      resetCards: currentResetCards || [],
      usageError: null,
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
  const nextStore = { version: 1, accounts: uniqueAccounts };
  await saveAccountsStore(nextStore);
  return nextStore;
}

async function importCurrentAccount() {
  const authJson = await readJson(AUTH_PATH, null);
  const local = parseCodexAuth(authJson);
  if (!local.accessToken || !local.accountKey) throw new Error('当前 auth.json 未包含可导入的 Codex ChatGPT 账号');
  const store = await loadAccountsStore();
  const existingIndex = store.accounts.findIndex((account) => account.accountKey === local.accountKey);
  const existing = existingIndex >= 0 ? store.accounts[existingIndex] : {};
  const account = buildStoredAccount(authJson, local, existing);
  if (existingIndex >= 0) {
    store.accounts[existingIndex] = account;
  } else {
    store.accounts.unshift(account);
  }
  await saveAccountsStore(store);
  await refreshUsage('import-account');
  return {
    snapshot: getViewSnapshot(),
    account: accountView(account, local.accountKey),
    status: existingIndex >= 0 ? 'updated' : 'created'
  };
}

async function switchAccount(id) {
  const store = await loadAccountsStore();
  const account = store.accounts.find((item) => item.id === id);
  if (!account?.authJson) throw new Error('未找到可切换的账号授权快照');
  const now = new Date().toISOString();
  await writeJson(AUTH_PATH, account.authJson);
  account.lastSwitchedAt = now;
  account.updatedAt = now;
  await saveAccountsStore(store);
  await refreshUsage('switch-account');
  return {
    snapshot: getViewSnapshot(),
    account: accountView(account, account.accountKey),
    switchedAt: now
  };
}

async function deleteAccount(id) {
  const store = await loadAccountsStore();
  const nextAccounts = store.accounts.filter((account) => account.id !== id);
  await saveAccountsStore({ version: 1, accounts: nextAccounts });
  await refreshUsage('delete-account');
  return getViewSnapshot();
}

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUsageForLocalAuth(local) {
  if (!local.accessToken || !local.accountId) return {};
  const resetCardsPromise = fetchResetCreditDetails(local);
  for (const url of await resolveUsageUrls()) {
    try {
      const response = await fetchJson(url, {
        headers: {
          authorization: `Bearer ${local.accessToken}`,
          'ChatGPT-Account-Id': local.accountId,
          accept: 'application/json'
        }
      }, 12000);
      if (!response.ok || !response.json) continue;
      const snapshot = mapOfficialUsagePayload(response.json, url);
      if (hasOfficialUsageData(snapshot)) {
        const detailedResetCards = await resetCardsPromise;
        if (detailedResetCards) snapshot.resetCards = detailedResetCards;
        return snapshot;
      }
    } catch {
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
      if (!response.ok || !response.json) continue;
      merged = mergeDefined(merged, extractUsageSnapshot(response.json, url));
    } catch {
      // Unpublished endpoints may not exist for all accounts or app versions.
    }
  }
  return merged;
}

async function fetchWithCodexAuth() {
  return fetchUsageForLocalAuth(await readLocalCodexAuth());
}

function shouldCapture(url) {
  return /chatgpt\.com|openai\.com/.test(url) && /(codex|usage|quota|limit|subscription|account|billing|reset|credit|cap|model)/i.test(url);
}

function setupNetworkCapture(win) {
  try {
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.sendCommand('Network.enable');
  } catch {
    return;
  }

  win.webContents.debugger.on('message', async (_event, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const url = params?.response?.url || '';
    if (!shouldCapture(url) || seenRequestIds.has(params.requestId)) return;
    seenRequestIds.add(params.requestId);
    try {
      const body = await win.webContents.debugger.sendCommand('Network.getResponseBody', {
        requestId: params.requestId
      });
      const text = body?.body || '';
      if (!text || !/[{[]/.test(text[0])) return;
      const json = JSON.parse(text);
      const extracted = extractUsageSnapshot(json, url);
      const hasUsefulData =
        Number.isFinite(Number(extracted.usageRemainingPercent)) ||
        Boolean(extracted.usageResetAt) ||
        Boolean(extracted.resetCards?.length);
      if (!hasUsefulData) return;
      await writeJson(debugPath(), {
        url,
        extracted,
        keys: Object.keys(json || {}),
        capturedAt: new Date().toISOString()
      });
      const capturePatch = { ...extracted };
      if (!extracted.resetCards?.length) delete capturePatch.resetCards;
      await saveState({
        snapshot: {
          ...capturePatch,
          lastSyncedAt: new Date().toISOString(),
          sourceStatus: '已同步'
        }
      });
    } catch {
      // Ignore non-JSON, streamed, or protected responses.
    }
  });
}

async function scrapeVisiblePage() {
  if (!webWindow || webWindow.isDestroyed()) return {};
  try {
    const payload = await webWindow.webContents.executeJavaScript(
      `(() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const bodyText = clean(document.body ? document.body.innerText : '');
        const scripts = Array.from(document.scripts)
          .map((node) => node.textContent || '')
          .filter((text) => /codex|usage|quota|subscription|reset|credit|cap|plus|pro/i.test(text))
          .slice(0, 10)
          .map((text) => text.slice(0, 120000));
        return { url: location.href, title: document.title, bodyText, scripts };
      })()`,
      true
    );
    const extracted = {};
    const text = `${payload.title} ${payload.bodyText}`;
    const percentMatch = text.match(/(?:remaining|剩余|可用|usage|用量)[^0-9%]{0,30}(\\d+(?:\\.\\d+)?)\\s*%/i);
    if (percentMatch) extracted.usageRemainingPercent = percentOrNull(percentMatch[1]);
    const planMatch = text.match(/\\b(plus|pro|team|enterprise|business|free)\\b/i);
    if (planMatch) extracted.planTier = planMatch[1].toLowerCase();
    extracted.sourceUrl = payload.url;
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
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  floatWindow.setAlwaysOnTop(true, 'screen-saver');
  floatWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function createWebWindow() {
  webWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    show: false,
    title: 'Codex 工具同步',
    webPreferences: {
      partition: 'persist:official-openai-usage',
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  setupNetworkCapture(webWindow);
  webWindow.loadURL(APP_URL);
  webWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => refreshUsage('page-load'), 1200);
  });
}

async function refreshUsage(reason = 'manual') {
  const currentAuthJson = await readJson(AUTH_PATH, null);
  const local = parseCodexAuth(currentAuthJson);
  const previousTokenUsage = state.snapshot?.tokenUsage;
  const sameAccount = Boolean(local.accountKey && previousTokenUsage?.accountKey === local.accountKey);
  const tokenScopeStartedAt = sameAccount
    ? previousTokenUsage.scopeStartedAt || local.authIssuedAt
    : local.authIssuedAt || new Date().toISOString();
  const [direct, page, accountTokenUsage] = await Promise.all([
    fetchWithCodexAuth(),
    scrapeVisiblePage(),
    fetchAccountTokenUsage(local, sameAccount ? previousTokenUsage : null)
  ]);
  const fallback = mergeDefined(
    {
      planTier: local.planTier,
      membershipExpiresAt: local.membershipExpiresAt
    },
    page
  );
  const merged = mergeDefined(fallback, direct);
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
    Number.isFinite(Number(merged.usageRemainingPercent)) ||
    Boolean(merged.usageWindows?.fiveHour) ||
    Boolean(merged.usageWindows?.oneWeek) ||
    Boolean(merged.resetCards?.length);
  const statusText = hasUsage
    ? '\u5df2\u540c\u6b65'
    : reason === 'manual'
      ? '\u5df2\u5237\u65b0\u4f1a\u5458\u4fe1\u606f\uff1b\u8bf7\u6253\u5f00\u7f51\u9875\u767b\u5f55\u6216\u8fdb\u5165 Codex \u76f8\u5173\u9875\u9762\u4ee5\u6355\u83b7\u7528\u91cf'
      : state.snapshot?.sourceStatus || '\u7b49\u5f85\u6355\u83b7\u5b9e\u65f6\u7528\u91cf';
  const syncedAt = new Date().toISOString();
  const resetCards = inferResetCardExpiry(merged.resetCards || []);
  const accountsStore = await refreshAccountsStore({
    currentAuthJson,
    currentLocal,
    currentUsage: merged,
    currentTokenUsage: tokenUsage,
    currentResetCards: resetCards,
    syncedAt
  });
  const currentAccount = accountFromCurrent(currentLocal, merged, tokenUsage, resetCards, syncedAt);
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

function openWebWindow() {
  if (!webWindow || webWindow.isDestroyed()) createWebWindow();
  webWindow.show();
  webWindow.focus();
  if (!webWindow.webContents.getURL()) webWindow.loadURL(APP_URL);
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

  const nextX = panelState.open ? panelState.orbX : x;
  const nextY = panelState.open ? panelState.orbY : y;
  panelState = { ...panelState, open: false };
  floatWindow.setBounds({ x: nextX, y: nextY, width: orbOuter, height: orbOuter });
  return { side: panelState.side, orbX: FLOAT_PADDING, panelX: FLOAT_PADDING, orbY: FLOAT_PADDING };
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
  refreshTimer = setInterval(() => refreshUsage('timer'), REFRESH_INTERVAL_MS);
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.codexusage.float');
  await loadState();
  createFloatWindow();
  createWebWindow();
  await refreshUsage('startup');
  startRefreshTimer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('usage:get', () => getViewSnapshot());
ipcMain.handle('usage:refresh', () => refreshUsage('manual'));
ipcMain.handle('usage:open-web', () => openWebWindow());
ipcMain.handle('accounts:import-current', () => importCurrentAccount());
ipcMain.handle('accounts:switch', (_event, id) => switchAccount(id));
ipcMain.handle('accounts:delete', (_event, id) => deleteAccount(id));
ipcMain.handle('codex:status', () => getCodexAppStatus());
ipcMain.handle('codex:restart', () => restartCodexApp());
ipcMain.handle('local-token-summary:refresh', async () => {
  const localTokenSummary = await collectLocalTokenSummary();
  await saveState({ snapshot: { localTokenSummary } }, ['localTokenSummary']);
  return getViewSnapshot();
});
ipcMain.handle('window:set-size', async (_event, size) => {
  const next = Math.max(86, Math.min(Number(size) || config.windowSize, 220));
  config.windowSize = next;
  let layout = null;
  if (panelState.open) {
    layout = positionPanel(true);
  } else {
    const outer = Math.round(next + FLOAT_PADDING * 2);
    floatWindow.setSize(outer, outer);
  }
  await writeJson(configPath(), config);
  return { size: next, layout };
});
ipcMain.handle('window:move-by', (_event, delta) => {
  if (!floatWindow || !delta) return null;
  const [x, y] = floatWindow.getPosition();
  floatWindow.setPosition(Math.round(x + Number(delta.x || 0)), Math.round(y + Number(delta.y || 0)), false);
  if (panelState.open) {
    panelState.orbX = Math.round(panelState.orbX + Number(delta.x || 0));
    panelState.orbY = Math.round(panelState.orbY + Number(delta.y || 0));
  }
  return null;
});
ipcMain.handle('window:set-panel-height', (_event, height) => resizeOpenPanelHeight(height));
ipcMain.handle('window:set-detail-open', (_event, open) => positionPanel(open));
ipcMain.handle('external:open-chatgpt', () => shell.openExternal(APP_URL));
ipcMain.handle('external:open-repo', () => shell.openExternal(GITHUB_REPO_URL));
ipcMain.handle('app:quit', () => app.quit());

app.on('before-quit', () => {
  try {
    session.fromPartition('persist:official-openai-usage').flushStorageData();
  } catch {
    // Best effort only.
  }
});
