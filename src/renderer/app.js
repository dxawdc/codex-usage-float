const state = {
  snapshot: null,
  size: 116,
  sizeInitialized: false,
  panelOpen: false,
  dragging: null,
  localRange: 'today',
  pendingSwitchAccount: null,
  switchPhase: 'idle',
  theme: localStorage.getItem('codexUsageTheme') || 'dark',
  pricing: null,
  pricingModel: 'gpt-5.5',
  settings: { refreshIntervalMinutes: 30, alwaysOnTop: true, orbStyle: 'classic' },
  settingsTab: 'refresh',
  orbStylePreview: 'classic',
  panelHeightTimer: null,
  orbRemaining: null,
  orbPercentAnimationFrame: null,
  orbPercentAnimationTimer: null,
  orbPulseTimer: null
};

const els = {
  root: document.documentElement,
  orb: document.getElementById('orb'),
  scrim: document.getElementById('scrim'),
  panel: document.getElementById('panel'),
  ringFill: document.getElementById('ringFill'),
  tierText: document.getElementById('tierText'),
  percentText: document.getElementById('percentText'),
  orbCaption: document.getElementById('orbCaption'),
  closePanel: document.getElementById('closePanel'),
  pricingSettingsButton: document.getElementById('pricingSettingsButton'),
  refreshButton: document.getElementById('refreshButton'),
  aboutButton: document.getElementById('aboutButton'),
  openButton: document.getElementById('openButton'),
  quitButton: document.getElementById('quitButton'),
  resizeGrip: document.getElementById('resizeGrip'),
  lastSyncedText: document.getElementById('lastSyncedText'),
  currentAccountText: document.getElementById('currentAccountText'),
  currentTierPill: document.getElementById('currentTierPill'),
  prepareAddAccountButton: document.getElementById('prepareAddAccountButton'),
  importAccountButton: document.getElementById('importAccountButton'),
  accountFlowStatus: document.getElementById('accountFlowStatus'),
  accountsList: document.getElementById('accountsList'),
  resetCardsTitle: document.getElementById('resetCardsTitle'),
  cardCountText: document.getElementById('cardCountText'),
  resetCards: document.getElementById('resetCards'),
  localSummarySubtitle: document.getElementById('localSummarySubtitle'),
  localInputTokens: document.getElementById('localInputTokens'),
  localCachedTokens: document.getElementById('localCachedTokens'),
  localCacheRate: document.getElementById('localCacheRate'),
  localOutputTokens: document.getElementById('localOutputTokens'),
  localInputCost: document.getElementById('localInputCost'),
  localOutputCost: document.getElementById('localOutputCost'),
  localTokenMeta: document.getElementById('localTokenMeta'),
  localModelBreakdown: document.getElementById('localModelBreakdown'),
  localCompactGrid: document.getElementById('localCompactGrid'),
  confirmDialog: document.getElementById('confirmDialog'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmBody: document.getElementById('confirmBody'),
  confirmStatus: document.getElementById('confirmStatus'),
  cancelSwitchButton: document.getElementById('cancelSwitchButton'),
  manualSwitchButton: document.getElementById('manualSwitchButton'),
  autoSwitchButton: document.getElementById('autoSwitchButton'),
  themeToggleButton: document.getElementById('themeToggleButton'),
  pricingDialog: document.getElementById('pricingDialog'),
  settingsRefreshTab: document.getElementById('settingsRefreshTab'),
  settingsPricingTab: document.getElementById('settingsPricingTab'),
  settingsDisplayTab: document.getElementById('settingsDisplayTab'),
  settingsOrbTab: document.getElementById('settingsOrbTab'),
  refreshSettingsPanel: document.getElementById('refreshSettingsPanel'),
  pricingSettingsPanel: document.getElementById('pricingSettingsPanel'),
  displaySettingsPanel: document.getElementById('displaySettingsPanel'),
  orbSettingsPanel: document.getElementById('orbSettingsPanel'),
  orbStyleFields: [...document.querySelectorAll('input[name="orbStyle"]')],
  refreshIntervalField: document.getElementById('refreshIntervalField'),
  alwaysOnTopField: document.getElementById('alwaysOnTopField'),
  pricingModelSelect: document.getElementById('pricingModelSelect'),
  inputPriceField: document.getElementById('inputPriceField'),
  cachedInputPriceField: document.getElementById('cachedInputPriceField'),
  outputPriceField: document.getElementById('outputPriceField'),
  pricingStatus: document.getElementById('pricingStatus'),
  closePricingButton: document.getElementById('closePricingButton'),
  resetPricingButton: document.getElementById('resetPricingButton'),
  savePricingButton: document.getElementById('savePricingButton')
};

const DEFAULT_MODEL_PRICING_PER_MILLION = Object.freeze({
  'gpt-5.6-sol': Object.freeze({ input: 5, cachedInput: 0.5, output: 30 }),
  'gpt-5.6-terra': Object.freeze({ input: 2.5, cachedInput: 0.25, output: 15 }),
  'gpt-5.6-luna': Object.freeze({ input: 1, cachedInput: 0.1, output: 6 }),
  'gpt-5.5': Object.freeze({ input: 5, cachedInput: 0.5, output: 30 }),
  'gpt-5.5-cyber': Object.freeze({ input: 20, cachedInput: 2, output: 120 }),
  'gpt-5.4': Object.freeze({ input: 2.5, cachedInput: 0.25, output: 15 }),
  'gpt-5.4-mini': Object.freeze({ input: 0.75, cachedInput: 0.075, output: 4.5 }),
  'gpt-5.3-codex': Object.freeze({ input: 1.75, cachedInput: 0.175, output: 14 }),
  'gpt-5.2': Object.freeze({ input: 1.75, cachedInput: 0.175, output: 14 })
});
const DEFAULT_GPT_5_5_PRICE_PER_MILLION = DEFAULT_MODEL_PRICING_PER_MILLION['gpt-5.5'];
const PRICING_STORAGE_KEY = 'codexUsagePricing';
const ORB_STYLE_IDS = new Set(['classic', 'aurora', 'pixel', 'flip']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isFiniteValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function formatTier(value) {
  if (!value) return '--';
  const tier = String(value).toLowerCase();
  if (tier.includes('enterprise')) return 'Enterprise';
  if (tier.includes('business')) return 'Business';
  if (tier.includes('team')) return 'Team';
  if (tier.includes('pro')) return 'Pro';
  if (tier.includes('plus')) return 'Plus';
  if (tier.includes('free')) return 'Free';
  return String(value);
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--%';
  return `${clamp(number, 0, 100).toFixed(number < 10 ? 1 : 0)}%`;
}

function normalizeOrbStyle(value) {
  return typeof value === 'string' && ORB_STYLE_IDS.has(value) ? value : 'classic';
}

function applyOrbStyle(value) {
  const next = normalizeOrbStyle(value);
  state.orbStylePreview = next;
  els.orb.dataset.orbStyle = next;
  for (const field of els.orbStyleFields) field.checked = field.value === next;
}

function setOrbPercentText(value) {
  els.percentText.textContent = formatPercent(value);
}

function updateOrbPercent(nextRemaining) {
  const previousRemaining = state.orbRemaining;
  const canAnimate = Number.isFinite(previousRemaining)
    && Number.isFinite(nextRemaining)
    && Math.abs(previousRemaining - nextRemaining) > 0.01;
  state.orbRemaining = nextRemaining;

  if (!canAnimate) {
    setOrbPercentText(nextRemaining);
    return;
  }

  if (state.orbPercentAnimationFrame) cancelAnimationFrame(state.orbPercentAnimationFrame);
  clearTimeout(state.orbPercentAnimationTimer);
  clearTimeout(state.orbPulseTimer);
  els.orb.classList.remove('is-updating');
  void els.orb.offsetWidth;
  els.orb.classList.add('is-updating');

  const duration = 460;
  const startedAt = performance.now();
  const finish = () => {
    if (state.orbPercentAnimationFrame) cancelAnimationFrame(state.orbPercentAnimationFrame);
    state.orbPercentAnimationFrame = null;
    clearTimeout(state.orbPercentAnimationTimer);
    setOrbPercentText(nextRemaining);
  };
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    setOrbPercentText(previousRemaining + (nextRemaining - previousRemaining) * eased);
    if (progress < 1) {
      state.orbPercentAnimationFrame = requestAnimationFrame(tick);
      return;
    }
    finish();
  };
  state.orbPercentAnimationFrame = requestAnimationFrame(tick);
  state.orbPercentAnimationTimer = setTimeout(finish, duration + 80);
  state.orbPulseTimer = setTimeout(() => els.orb.classList.remove('is-updating'), 640);
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(number);
}

function formatTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  if (number >= 1000000000) return `${(number / 1000000000).toFixed(2)}B`;
  if (number >= 1000000) return `${(number / 1000000).toFixed(2)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return formatNumber(number);
}

function formatUsdEstimate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  const fractionDigits = number === 0 ? 2 : number < 0.01 ? 4 : number < 1 ? 3 : 2;
  const amount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(number);
  return `≈ ${amount}`;
}

function normalizePrice(value, fallback = DEFAULT_GPT_5_5_PRICE_PER_MILLION) {
  const source = value || {};
  const normalized = {};
  for (const key of ['input', 'cachedInput', 'output']) {
    const number = Number(source[key]);
    normalized[key] = Number.isFinite(number) && number >= 0
      ? Math.min(number, 1000000)
      : fallback[key];
  }
  return normalized;
}

function normalizeModelKey(value) {
  const model = String(value || '').trim().toLowerCase();
  return model || 'unknown';
}

function normalizePricing(value) {
  const source = value || {};
  const isLegacyFlatPrice = ['input', 'cachedInput', 'output'].some((key) => Object.hasOwn(source, key));
  const fallback = normalizePrice(source.fallback || (isLegacyFlatPrice ? source : null));
  const models = {};
  for (const [model, defaultPrice] of Object.entries(DEFAULT_MODEL_PRICING_PER_MILLION)) {
    models[model] = normalizePrice(source.models?.[model], defaultPrice);
  }
  for (const [model, price] of Object.entries(source.models || {})) {
    models[normalizeModelKey(model)] = normalizePrice(price, models[normalizeModelKey(model)] || fallback);
  }
  return { fallback, models };
}

function loadPricingSettings() {
  try {
    return normalizePricing(JSON.parse(localStorage.getItem(PRICING_STORAGE_KEY) || '{}'));
  } catch {
    return normalizePricing();
  }
}

function savePricingSettings(value) {
  const pricing = normalizePricing(value);
  localStorage.setItem(PRICING_STORAGE_KEY, JSON.stringify(pricing));
  state.pricing = pricing;
  return pricing;
}

function pricingForModel(model, pricing = state.pricing) {
  const normalized = normalizePricing(pricing);
  return normalized.models[normalizeModelKey(model)] || normalized.fallback;
}

function estimateTokenCost(tokens, model, pricing = state.pricing) {
  if (!tokens) return null;
  const price = pricingForModel(model, pricing);
  const inputTokens = Math.max(0, Number(tokens.inputTokens) || 0);
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, Number(tokens.cachedInputTokens) || 0));
  const outputTokens = Math.max(0, Number(tokens.outputTokens) || 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const input = (
    uncachedInputTokens * price.input +
    cachedInputTokens * price.cachedInput
  ) / 1000000;
  const output = outputTokens * price.output / 1000000;
  return { input, output, total: input + output };
}

function estimateModelAwareCost(window) {
  if (!window) return null;
  const breakdown = Array.isArray(window.modelBreakdown) && window.modelBreakdown.length
    ? window.modelBreakdown
    : [{ model: 'unknown', ...window }];
  return breakdown.reduce((total, item) => {
    const cost = estimateTokenCost(item, item.model);
    total.input += cost.input;
    total.output += cost.output;
    total.total += cost.total;
    return total;
  }, { input: 0, output: 0, total: 0 });
}

function formatMinute(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function accentForRemaining(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return '#8ba3b8';
  if (value <= 10) return '#ef4444';
  if (value <= 25) return '#f97316';
  if (value <= 50) return '#facc15';
  return '#4ade80';
}

function accountDisplayName(account) {
  if (!account) return '--';
  const nickname = account.nickname || account.label?.split(' - ')[0] || 'Codex';
  const username = account.username || account.label?.split(' - ').slice(1).join(' - ') || '未知账号';
  return `${nickname} ${username}`;
}

function snapshotFromResult(result) {
  return result?.snapshot || result;
}

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  els.root.dataset.theme = state.theme;
  localStorage.setItem('codexUsageTheme', state.theme);
  if (!els.themeToggleButton) return;
  const isDark = state.theme === 'dark';
  els.themeToggleButton.textContent = isDark ? '☀️' : '🌙';
  els.themeToggleButton.title = isDark ? '切换浅色模式' : '切换深色模式';
  els.themeToggleButton.setAttribute('aria-label', els.themeToggleButton.title);
}

function setButtonBusy(button, busyText, fallbackText) {
  if (!button.dataset.defaultText) button.dataset.defaultText = fallbackText || button.textContent;
  button.textContent = busyText;
  button.disabled = true;
}

function accountNameParts(account) {
  if (!account) return { nickname: '--', username: '--' };
  const nickname = account.nickname || accountDisplayName(account).split(/\s+/)[0] || 'Codex';
  const username = account.username || accountDisplayName(account).split(/\s+/).slice(1).join(' ') || '未知账号';
  return { nickname, username };
}

function usageWindow(account, key) {
  return account?.usageWindows?.[key] || account?.usage?.usageWindows?.[key] || null;
}

function tokenTotal(tokenUsage, key) {
  const value = key === 'today'
    ? tokenUsage?.today || tokenUsage?.last24h
    : tokenUsage?.[key];
  return value?.totalTokens;
}

function formatDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[2]}/${match[3]}` : '';
}

function tokenUsageHint(tokenUsage) {
  if (tokenUsage?.source === 'account-profile') return '';
  if (tokenUsage?.attributionConfidence === 'high') return ' · 高可信归属';
  if (tokenUsage?.attributionConfidence === 'medium') return ' · 推断归属';
  if (tokenUsage?.attributionConfidence === 'low') return ' · 归属待确认';
  return tokenUsage?.source === 'local-estimate' ? ' · 未拆分账号' : '';
}

function normalizeResetCards(cards = []) {
  const rows = [];
  for (const card of cards) {
    const count = Math.max(0, Math.floor(Number(card.count) || 0));
    for (let index = 0; index < Math.min(count, 50); index += 1) rows.push({ ...card, count: 1 });
  }
  return rows;
}

function availableResetCardCount(account) {
  const cards = Array.isArray(account?.resetCards)
    ? account.resetCards
    : account?.usage?.resetCards || [];
  return cards.reduce((total, card) => total + Math.max(0, Math.floor(Number(card?.count) || 0)), 0);
}

function createMiniQuota(label, window) {
  const remaining = isFiniteValue(window?.remainingPercent) ? Number(window.remainingPercent) : Number.NaN;
  const safeRemaining = Number.isFinite(remaining) ? clamp(remaining, 0, 100) : 0;
  const accent = accentForRemaining(remaining);
  const quota = document.createElement('div');
  quota.className = 'mini-quota';
  quota.innerHTML = `
    <div class="mini-quota-head">
      <span>${label}</span>
      <div class="mini-quota-value">
        <strong style="color:${accent}">${formatPercent(remaining)}</strong>
        <span>重置 ${formatMinute(window?.resetAt)}</span>
      </div>
    </div>
    <div class="mini-meter"><div style="width:${safeRemaining}%;background:${accent}"></div></div>
  `;
  return quota;
}

function renderAccounts(accounts = []) {
  els.accountsList.replaceChildren();
  els.accountsList.classList.toggle('is-scrollable', accounts.length > 3);
  if (!accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有导入账号，先导入当前账号';
    els.accountsList.appendChild(empty);
    return;
  }

  for (const account of accounts) {
    const row = document.createElement('article');
    row.className = `account-card${account.isCurrent ? ' is-current' : ''}`;
    const { nickname, username } = accountNameParts(account);
    const fiveHour = usageWindow(account, 'fiveHour');
    const oneWeek = usageWindow(account, 'oneWeek');
    const today = formatTokens(tokenTotal(account.tokenUsage, 'today'));
    const last7d = formatTokens(tokenTotal(account.tokenUsage, 'last7d'));
    const last30d = formatTokens(tokenTotal(account.tokenUsage, 'last30d'));
    const lifetime = formatTokens(tokenTotal(account.tokenUsage, 'lifetime'));
    const peak = formatTokens(tokenTotal(account.tokenUsage, 'peakDaily'));
    const peakDate = formatDateKey(account.tokenUsage?.peakDate);
    const resetCardCount = availableResetCardCount(account);

    const main = document.createElement('div');
    main.className = 'account-main';
    const header = document.createElement('div');
    header.className = 'account-card-head';
    const title = document.createElement('div');
    title.className = 'account-title';
    const nameLine = document.createElement('div');
    nameLine.className = 'account-title-line';

    const nicknameNode = document.createElement('strong');
    nicknameNode.className = 'account-name-part';
    nicknameNode.textContent = nickname;
    const usernameNode = document.createElement('strong');
    usernameNode.className = 'account-username-part';
    usernameNode.textContent = username;
    const planNode = document.createElement('span');
    planNode.className = 'account-plan-inline';
    planNode.textContent = `${formatTier(account.planTier)} · 到期 ${formatMinute(account.membershipExpiresAt)}`;

    const resetCardNode = document.createElement('span');
    resetCardNode.className = `account-reset-card-inline${resetCardCount > 0 ? ' has-reset-cards' : ''}`;
    resetCardNode.textContent = `reset*${formatNumber(resetCardCount)}`;

    nameLine.append(nicknameNode, usernameNode, planNode, resetCardNode);
    if (account.isCurrent) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'account-active-badge';
      activeBadge.textContent = '使用中';
      nameLine.appendChild(activeBadge);
    }
    if (account.authStatus === 'needs_reauth' || account.authStatus === 'stale') {
      const authBadge = document.createElement('span');
      authBadge.className = `account-auth-badge ${account.authStatus}`;
      authBadge.textContent = account.authStatus === 'needs_reauth' ? '需重新登录' : '数据待刷新';
      nameLine.appendChild(authBadge);
    }
    title.appendChild(nameLine);
    header.appendChild(title);
    const headerActions = document.createElement('div');
    headerActions.className = 'account-card-actions';
    const button = document.createElement('button');
    button.className = account.isCurrent ? 'mini-button current' : 'mini-button';
    const credentialsInvalid = account.authStatus === 'needs_reauth';
    button.textContent = account.isCurrent ? '当前账号' : credentialsInvalid ? '需重登' : '切换';
    button.disabled = Boolean(account.isCurrent || credentialsInvalid);
    if (!account.isCurrent && !credentialsInvalid) {
      button.addEventListener('click', () => openSwitchDialog(account));
    }
    headerActions.appendChild(button);
    if (!account.isCurrent && account.id !== 'current') {
      const deleteButton = document.createElement('button');
      deleteButton.className = 'icon-button small';
      deleteButton.title = '删除账号记录';
      deleteButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
      deleteButton.addEventListener('click', async () => {
        state.snapshot = await window.codexUsage.deleteAccount(account.id);
        render();
      });
      headerActions.appendChild(deleteButton);
    }
    header.appendChild(headerActions);

    const quotas = document.createElement('div');
    quotas.className = 'account-quotas';
    quotas.append(createMiniQuota('5h', fiveHour), createMiniQuota('1周', oneWeek));

    const tokenLine = document.createElement('p');
    tokenLine.className = 'account-token-line';
    tokenLine.textContent = `Token 今日 ${today} · 7天 ${last7d} · 30天 ${last30d} · 累计 ${lifetime} · 峰值 ${peak}${peakDate ? ` (${peakDate})` : ''}${tokenUsageHint(account.tokenUsage)}`;
    if (account.usageError) tokenLine.textContent += ` · ${account.usageError}`;

    main.append(header, quotas, tokenLine);
    row.appendChild(main);

    els.accountsList.appendChild(row);
  }
}

function renderCards(cards = [], accountLabel = '--') {
  const available = normalizeResetCards(cards);
  els.resetCards.replaceChildren();
  const availableCount = cards.reduce((total, card) => total + Math.max(0, Number(card.count) || 0), 0);
  els.resetCardsTitle.textContent = `可用重置卡 · ${accountLabel || '--'}`;
  els.cardCountText.textContent = `${formatNumber(availableCount)} 张`;
  if (!available.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '当前账号没有可用重置卡';
    els.resetCards.appendChild(empty);
    return;
  }
  available.forEach((card, index) => {
    const row = document.createElement('article');
    row.className = 'reset-card';
    const title = document.createElement('strong');
    title.textContent = `#${index + 1} ${card.label || '重置卡'}`;
    const meta = document.createElement('span');
    meta.textContent = card.expiresAt
      ? formatMinute(card.expiresAt)
      : card.resetAt
        ? formatMinute(card.resetAt)
        : '有效期未知';
    row.append(title, meta);
    els.resetCards.appendChild(row);
  });
}

function localWindow(summary) {
  return summary?.windows?.[state.localRange] || null;
}

function modelDisplayName(model) {
  return normalizeModelKey(model) === 'unknown'
    ? '未识别模型'
    : String(model || '').replace(/(^|[-_])(\w)/g, (_, prefix, char) => `${prefix}${char.toUpperCase()}`);
}

function renderModelBreakdown(current) {
  els.localModelBreakdown.replaceChildren();
  const breakdown = Array.isArray(current?.modelBreakdown) ? current.modelBreakdown : [];
  for (const item of breakdown) {
    const row = document.createElement('div');
    row.className = 'model-usage-row';
    const name = document.createElement('strong');
    name.className = 'model-usage-name';
    name.textContent = modelDisplayName(item.model);
    name.title = item.model === 'unknown' ? '日志中缺少模型上下文，使用“未识别模型”定价' : item.model;
    const meta = document.createElement('span');
    meta.className = 'model-usage-meta';
    meta.textContent = `${formatTokens(item.totalTokens)} Token · ${formatUsdEstimate(estimateTokenCost(item, item.model)?.total)}`;
    row.append(name, meta);
    els.localModelBreakdown.appendChild(row);
  }
}

function renderLocalSummary(summary) {
  const current = localWindow(summary);
  const cost = estimateModelAwareCost(current);
  els.localInputTokens.textContent = formatTokens(current?.inputTokens);
  els.localCachedTokens.textContent = formatTokens(current?.cachedInputTokens);
  els.localCacheRate.textContent = isFiniteValue(current?.cacheRate) ? formatPercent(current.cacheRate) : '--';
  els.localOutputTokens.textContent = formatTokens(current?.outputTokens);
  els.localInputCost.textContent = formatUsdEstimate(cost?.input);
  els.localOutputCost.textContent = formatUsdEstimate(cost?.output);
  const modelCount = Array.isArray(current?.modelBreakdown) ? current.modelBreakdown.length : 0;
  els.localSummarySubtitle.textContent = `所有会话 · ${modelCount || 1} 个模型 · 总估算 ${formatUsdEstimate(cost?.total)}`;
  els.localTokenMeta.textContent = [
    `推理输出 ${formatTokens(current?.reasoningOutputTokens)}`,
    `总计 ${formatTokens(current?.totalTokens)}`,
    `${formatNumber(summary?.sourceFileCount || 0)} 个文件`,
    `${formatNumber(current?.eventCount || 0)} 条`
  ].join(' · ');
  renderModelBreakdown(current);
  document.querySelectorAll('[data-local-range]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.localRange === state.localRange);
  });
}

function render() {
  const data = state.snapshot || {};
  const currentAccount = data.currentAccount || data.accounts?.find((account) => account.isCurrent) || null;
  const fiveHour = usageWindow(currentAccount, 'fiveHour') || data.usageWindows?.fiveHour;
  if (!state.sizeInitialized && Number.isFinite(Number(data.windowSize))) {
    state.size = Number(data.windowSize);
    state.sizeInitialized = true;
  }

  const remaining = Number(fiveHour?.remainingPercent);
  const remainingSafe = Number.isFinite(remaining) ? clamp(remaining, 0, 100) : 0;
  const accent = accentForRemaining(remaining);
  const sourceStatus = data.sourceStatus === '已同步 Codex 用量' ? '已同步' : data.sourceStatus || '等待同步';

  els.root.style.setProperty('--accent', accent);
  els.root.style.setProperty('--orb-size', `${state.size}px`);
  els.orb.style.setProperty('--angle', `${remainingSafe * 3.6}deg`);
  els.ringFill.style.setProperty('--angle', `${remainingSafe * 3.6}deg`);
  els.orb.dataset.quota = remainingSafe <= 10 ? 'critical' : remainingSafe <= 25 ? 'low' : remainingSafe <= 50 ? 'focused' : 'calm';
  els.tierText.textContent = formatTier(currentAccount?.planTier || data.planTier);
  updateOrbPercent(remaining);
  els.orbCaption.textContent = '5h 剩余';
  els.lastSyncedText.textContent = data.lastSyncedAt
    ? `刷新 ${formatMinute(data.lastSyncedAt)} · ${sourceStatus}`
    : sourceStatus;
  els.currentAccountText.textContent = `当前：${accountDisplayName(currentAccount)}`;
  els.currentTierPill.textContent = formatTier(currentAccount?.planTier || data.planTier);

  renderAccounts(data.accounts || (currentAccount ? [currentAccount] : []));
  renderCards(data.resetCards || currentAccount?.resetCards || [], accountDisplayName(currentAccount) || data.resetCardsAccountLabel);
  renderLocalSummary(data.localTokenSummary);
  schedulePanelHeightResize();
}

function applyLayout(layout) {
  if (!layout) return;
  els.root.style.setProperty('--orb-x', `${layout.orbX}px`);
  els.root.style.setProperty('--orb-y', `${layout.orbY}px`);
  els.root.style.setProperty('--panel-x', `${layout.panelX}px`);
  document.body.classList.toggle('panel-left', layout.side === 'left');
  document.body.classList.toggle('panel-right', layout.side !== 'left');
}

function schedulePanelHeightResize() {
  if (!state.panelOpen || els.panel.hidden) return;
  clearTimeout(state.panelHeightTimer);
  state.panelHeightTimer = setTimeout(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!state.panelOpen || els.panel.hidden) return;
    const desiredHeight = Math.ceil(els.panel.offsetTop + els.panel.scrollHeight + 8);
    const layout = await window.codexUsage.setPanelHeight(desiredHeight);
    applyLayout(layout);
  }, 80);
}

async function load() {
  [state.snapshot, state.settings] = await Promise.all([
    window.codexUsage.getSnapshot(),
    window.codexUsage.getSettings()
  ]);
  applyOrbStyle(state.settings.orbStyle);
  render();
}

async function setPanelOpen(open) {
  state.panelOpen = open;
  document.body.classList.toggle('is-panel-open', open);
  els.panel.hidden = !open;
  els.scrim.hidden = !open;
  const layout = await window.codexUsage.setDetailOpen(open);
  applyLayout(layout);
  if (open) {
    state.snapshot = await window.codexUsage.getSnapshot();
    render();
    schedulePanelHeightResize();
  }
}

async function refresh() {
  els.refreshButton.classList.add('is-loading');
  try {
    state.snapshot = await window.codexUsage.refresh();
    render();
  } finally {
    els.refreshButton.classList.remove('is-loading');
  }
}

function setSwitchStatus(message, tone = '') {
  els.confirmStatus.hidden = !message;
  els.confirmStatus.textContent = message || '';
  els.confirmStatus.classList.toggle('is-pending', tone === 'pending');
  els.confirmStatus.classList.toggle('is-success', tone === 'success');
  els.confirmStatus.classList.toggle('is-error', tone === 'error');
}

function setAccountFlowStatus(message, tone = '') {
  els.accountFlowStatus.hidden = !message;
  els.accountFlowStatus.textContent = message || '';
  els.accountFlowStatus.classList.toggle('is-pending', tone === 'pending');
  els.accountFlowStatus.classList.toggle('is-success', tone === 'success');
  els.accountFlowStatus.classList.toggle('is-error', tone === 'error');
  schedulePanelHeightResize();
}

function setPricingStatus(message, tone = '') {
  els.pricingStatus.hidden = !message;
  els.pricingStatus.textContent = message || '';
  els.pricingStatus.classList.toggle('is-pending', tone === 'pending');
  els.pricingStatus.classList.toggle('is-success', tone === 'success');
  els.pricingStatus.classList.toggle('is-error', tone === 'error');
}

function priceInputValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : '';
}

function pricingModelKeys() {
  const summaryModels = localWindow(state.snapshot?.localTokenSummary)?.modelBreakdown || [];
  return [...new Set([
    ...Object.keys(DEFAULT_MODEL_PRICING_PER_MILLION),
    ...Object.keys(state.pricing?.models || {}),
    ...summaryModels.map((item) => normalizeModelKey(item.model))
  ])];
}

function setPricingModelOptions() {
  const selected = pricingModelKeys().includes(state.pricingModel) ? state.pricingModel : 'gpt-5.5';
  state.pricingModel = selected;
  els.pricingModelSelect.replaceChildren(...pricingModelKeys().map((model) => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = modelDisplayName(model);
    return option;
  }));
  els.pricingModelSelect.value = selected;
}

function setPricingFields(pricing = state.pricing) {
  const next = pricingForModel(state.pricingModel, pricing);
  els.inputPriceField.value = priceInputValue(next.input);
  els.cachedInputPriceField.value = priceInputValue(next.cachedInput);
  els.outputPriceField.value = priceInputValue(next.output);
}

function readPricingFields() {
  const fields = [
    ['input', els.inputPriceField, '输入'],
    ['cachedInput', els.cachedInputPriceField, '缓存输入'],
    ['output', els.outputPriceField, '输出']
  ];
  const result = {};
  for (const [key, field, label] of fields) {
    const number = Number(field.value);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`${label}价格需要是大于等于 0 的数字`);
    }
    result[key] = number;
  }
  return normalizePrice(result);
}

function setSettingsTab(tab) {
  state.settingsTab = ['pricing', 'display', 'orb'].includes(tab) ? tab : 'refresh';
  const isPricing = state.settingsTab === 'pricing';
  const isDisplay = state.settingsTab === 'display';
  const isOrb = state.settingsTab === 'orb';
  const isRefresh = !isPricing && !isDisplay && !isOrb;
  els.settingsRefreshTab.classList.toggle('is-active', isRefresh);
  els.settingsPricingTab.classList.toggle('is-active', isPricing);
  els.settingsDisplayTab.classList.toggle('is-active', isDisplay);
  els.settingsOrbTab.classList.toggle('is-active', isOrb);
  els.settingsRefreshTab.setAttribute('aria-selected', String(isRefresh));
  els.settingsPricingTab.setAttribute('aria-selected', String(isPricing));
  els.settingsDisplayTab.setAttribute('aria-selected', String(isDisplay));
  els.settingsOrbTab.setAttribute('aria-selected', String(isOrb));
  els.refreshSettingsPanel.hidden = !isRefresh;
  els.pricingSettingsPanel.hidden = !isPricing;
  els.displaySettingsPanel.hidden = !isDisplay;
  els.orbSettingsPanel.hidden = !isOrb;
  els.savePricingButton.textContent = isPricing
    ? '保存定价'
    : isDisplay
      ? '保存显示模式'
      : isOrb
        ? '保存悬浮球'
        : '保存刷新时间';
  els.resetPricingButton.hidden = !isPricing;
  if (isRefresh) {
    els.refreshIntervalField.value = String(state.settings.refreshIntervalMinutes || 30);
    requestAnimationFrame(() => els.refreshIntervalField.focus());
  } else if (isPricing) {
    setPricingModelOptions();
    setPricingFields();
    requestAnimationFrame(() => els.pricingModelSelect.focus());
  } else if (isDisplay) {
    els.alwaysOnTopField.checked = state.settings.alwaysOnTop !== false;
    requestAnimationFrame(() => els.alwaysOnTopField.focus());
  } else {
    applyOrbStyle(state.orbStylePreview);
    requestAnimationFrame(() => els.orbStyleFields.find((field) => field.checked)?.focus());
  }
  schedulePanelHeightResize();
}

function openPricingDialog() {
  applyOrbStyle(state.settings.orbStyle);
  setSettingsTab('refresh');
  setPricingModelOptions();
  setPricingFields();
  setPricingStatus('');
  els.pricingDialog.hidden = false;
  requestAnimationFrame(() => els.inputPriceField.focus());
  schedulePanelHeightResize();
}

function closePricingDialog() {
  setPricingStatus('');
  applyOrbStyle(state.settings.orbStyle);
  els.pricingDialog.hidden = true;
  schedulePanelHeightResize();
}

function setSwitchActions(mode, strategy = '') {
  const isBusy = mode === 'busy';
  const isDone = mode === 'done';
  els.cancelSwitchButton.hidden = isBusy || isDone;
  els.manualSwitchButton.hidden = isDone;
  els.autoSwitchButton.hidden = isDone;
  els.cancelSwitchButton.disabled = isBusy;
  els.manualSwitchButton.disabled = isBusy;
  els.autoSwitchButton.disabled = isBusy;
  els.cancelSwitchButton.textContent = isDone ? '知道了' : '取消';
  els.manualSwitchButton.textContent = isBusy && strategy === 'manual' ? '切换中...' : '手动切换';
  els.autoSwitchButton.textContent = isBusy && strategy === 'auto' ? '自动切换中...' : '自动切换';

  if (isDone) {
    els.cancelSwitchButton.hidden = false;
    els.cancelSwitchButton.disabled = false;
  }
}

function openSwitchDialog(account) {
  state.pendingSwitchAccount = account;
  state.switchPhase = 'choice';
  els.confirmTitle.textContent = `切换到 ${account.nickname || account.username || '该账号'}？`;
  els.confirmBody.textContent = '项目、任务、会话、插件和配置保持共用。自动切换会关闭完整 Codex 桌面端，保存当前最新认证，切换账号后再重新打开。';
  setSwitchStatus('推荐自动切换；手动切换要求你先完全退出 Codex 桌面端。');
  setSwitchActions('choice');
  els.confirmDialog.hidden = false;
  schedulePanelHeightResize();
}

function closeSwitchDialog() {
  state.pendingSwitchAccount = null;
  state.switchPhase = 'idle';
  setSwitchStatus('');
  els.confirmDialog.hidden = true;
  schedulePanelHeightResize();
}

function startDrag(event, element) {
  if (event.button !== 0 || event.target === els.resizeGrip) return;
  if (event.target.closest('button, input, select, textarea, a')) return;
  event.preventDefault();
  state.dragging = {
    element,
    lastX: event.screenX,
    lastY: event.screenY
  };
  element.classList.add('is-dragging');
  element.setPointerCapture(event.pointerId);
}

function moveDrag(event) {
  if (!state.dragging || resizing) return;
  const dx = event.screenX - state.dragging.lastX;
  const dy = event.screenY - state.dragging.lastY;
  if (!dx && !dy) return;
  state.dragging.lastX = event.screenX;
  state.dragging.lastY = event.screenY;
  window.codexUsage.moveBy({ x: dx, y: dy });
}

function endDrag(event) {
  if (!state.dragging) return;
  const element = state.dragging.element;
  element.classList.remove('is-dragging');
  state.dragging = null;
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
}

function cancelDrag() {
  state.dragging?.element?.classList.remove('is-dragging');
  state.dragging = null;
}

let resizing = null;
let resizeTimer = null;

async function commitSize(size) {
  const result = await window.codexUsage.setSize(size);
  state.size = Number(result?.size || size);
  applyLayout(result?.layout);
  render();
}

els.orb.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  setPanelOpen(true);
});
els.orb.addEventListener('dblclick', refresh);
els.orb.addEventListener('wheel', (event) => {
  event.preventDefault();
  commitSize(state.size + (event.deltaY < 0 ? 8 : -8));
}, { passive: false });
els.orb.addEventListener('pointerdown', (event) => startDrag(event, els.orb));
els.orb.addEventListener('pointermove', moveDrag);
els.orb.addEventListener('pointerup', endDrag);
els.orb.addEventListener('pointercancel', cancelDrag);
els.panel.addEventListener('pointerdown', (event) => startDrag(event, els.panel));
els.panel.addEventListener('pointermove', moveDrag);
els.panel.addEventListener('pointerup', endDrag);
els.panel.addEventListener('pointercancel', cancelDrag);

els.resizeGrip.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  event.stopPropagation();
  resizing = { startX: event.screenX, startY: event.screenY, startSize: state.size };
  els.orb.classList.add('is-resizing');
  els.resizeGrip.setPointerCapture(event.pointerId);
});
els.resizeGrip.addEventListener('pointermove', (event) => {
  if (!resizing) return;
  const delta = Math.max(event.screenX - resizing.startX, event.screenY - resizing.startY);
  state.size = clamp(resizing.startSize + delta, 86, 220);
  render();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => commitSize(state.size), 80);
});
els.resizeGrip.addEventListener('pointerup', (event) => {
  if (!resizing) return;
  resizing = null;
  els.orb.classList.remove('is-resizing');
  if (els.resizeGrip.hasPointerCapture(event.pointerId)) els.resizeGrip.releasePointerCapture(event.pointerId);
  commitSize(state.size);
});

document.querySelectorAll('[data-local-range]').forEach((button) => {
  button.addEventListener('click', () => {
    state.localRange = button.dataset.localRange;
    renderLocalSummary(state.snapshot?.localTokenSummary);
    schedulePanelHeightResize();
  });
});

els.closePanel.addEventListener('click', () => setPanelOpen(false));
els.scrim.addEventListener('click', () => setPanelOpen(false));
els.refreshButton.addEventListener('click', refresh);
els.pricingSettingsButton.addEventListener('click', openPricingDialog);
els.settingsRefreshTab.addEventListener('click', () => setSettingsTab('refresh'));
els.settingsPricingTab.addEventListener('click', () => setSettingsTab('pricing'));
els.settingsDisplayTab.addEventListener('click', () => setSettingsTab('display'));
els.settingsOrbTab.addEventListener('click', () => setSettingsTab('orb'));
els.closePricingButton.addEventListener('click', closePricingDialog);
for (const field of els.orbStyleFields) {
  field.addEventListener('change', () => {
    if (!field.checked) return;
    applyOrbStyle(field.value);
    setPricingStatus('正在预览，点击“保存悬浮球”后固定使用。');
  });
}
els.pricingModelSelect.addEventListener('change', () => {
  state.pricingModel = normalizeModelKey(els.pricingModelSelect.value);
  setPricingFields();
});
els.resetPricingButton.addEventListener('click', () => {
  const pricing = savePricingSettings();
  setPricingFields(pricing);
  renderLocalSummary(state.snapshot?.localTokenSummary);
  setPricingStatus('已恢复默认定价。', 'success');
  schedulePanelHeightResize();
});
els.savePricingButton.addEventListener('click', () => {
  if (state.settingsTab === 'refresh') {
    const value = Number(els.refreshIntervalField.value);
    if (!Number.isFinite(value) || value < 5 || value > 180) {
      setPricingStatus('刷新间隔需为 5–180 分钟。', 'error');
      return;
    }
    window.codexUsage.saveSettings({ refreshIntervalMinutes: Math.round(value) })
      .then((settings) => {
        state.settings = settings;
        els.refreshIntervalField.value = String(settings.refreshIntervalMinutes);
        setPricingStatus(`已设置为每 ${settings.refreshIntervalMinutes} 分钟自动刷新。`, 'success');
      })
      .catch((error) => setPricingStatus(String(error?.message || error || '刷新设置保存失败'), 'error'));
    return;
  }
  if (state.settingsTab === 'display') {
    window.codexUsage.saveSettings({ alwaysOnTop: els.alwaysOnTopField.checked })
      .then((settings) => {
        state.settings = settings;
        els.alwaysOnTopField.checked = settings.alwaysOnTop !== false;
        setPricingStatus(settings.alwaysOnTop ? '已开启窗口置顶。' : '已取消窗口置顶。', 'success');
      })
      .catch((error) => setPricingStatus(String(error?.message || error || '显示模式保存失败'), 'error'));
    return;
  }
  if (state.settingsTab === 'orb') {
    const orbStyle = normalizeOrbStyle(state.orbStylePreview);
    window.codexUsage.saveSettings({ orbStyle })
      .then((settings) => {
        state.settings = settings;
        applyOrbStyle(settings.orbStyle);
        setPricingStatus('悬浮球样式已保存。', 'success');
      })
      .catch((error) => setPricingStatus(String(error?.message || error || '悬浮球样式保存失败'), 'error'));
    return;
  }
  try {
    const price = readPricingFields();
    const pricing = savePricingSettings({
      ...state.pricing,
      models: {
        ...(state.pricing?.models || {}),
        [state.pricingModel]: price
      }
    });
    setPricingFields(pricing);
    renderLocalSummary(state.snapshot?.localTokenSummary);
    closePricingDialog();
  } catch (error) {
    setPricingStatus(String(error?.message || error || '定价保存失败'), 'error');
    schedulePanelHeightResize();
  }
});
els.prepareAddAccountButton.addEventListener('click', async () => {
  const confirmed = window.confirm(
    '添加账号会关闭并重新打开 Codex。当前账号的最新认证会先保存，只清除活动 auth.json；项目、任务、会话和配置不会删除。是否继续？'
  );
  if (!confirmed) return;
  setButtonBusy(els.prepareAddAccountButton, '准备中...', '+ 添加账号');
  setAccountFlowStatus('正在关闭 Codex 并保存当前账号认证...', 'pending');
  try {
    const result = await window.codexUsage.prepareAddAccount();
    setAccountFlowStatus(result?.message || '请在 Codex 登录新账号，完成后返回本工具导入。', result?.ok ? 'success' : 'error');
    els.prepareAddAccountButton.textContent = result?.ok ? '等待新账号登录' : '请手动打开 Codex';
  } catch (error) {
    setAccountFlowStatus(`准备添加账号失败：${String(error?.message || error || '未知错误')}`, 'error');
    els.prepareAddAccountButton.textContent = '准备失败';
  } finally {
    els.prepareAddAccountButton.disabled = false;
    setTimeout(() => {
      if (!els.prepareAddAccountButton.disabled) els.prepareAddAccountButton.textContent = '+ 添加账号';
    }, 3000);
  }
});

els.importAccountButton.addEventListener('click', async () => {
  setButtonBusy(els.importAccountButton, '导入中...', '导入当前账号');
  setAccountFlowStatus('正在读取当前 Codex 登录并更新账号档案...', 'pending');
  try {
    const result = await window.codexUsage.importCurrentAccount();
    state.snapshot = snapshotFromResult(result);
    render();
    els.importAccountButton.textContent = result?.status === 'updated' ? '已导入，数据已更新' : '已导入当前账号';
    setAccountFlowStatus(
      result?.status === 'updated' ? '当前账号认证已更新。' : '新账号已保存，可以安全切换。',
      'success'
    );
    setTimeout(() => {
      if (!els.importAccountButton.disabled) els.importAccountButton.textContent = '导入当前账号';
    }, 1800);
  } catch (error) {
    els.importAccountButton.textContent = '导入失败';
    setAccountFlowStatus(`导入失败：${String(error?.message || error || '未知错误')}`, 'error');
    setTimeout(() => {
      if (!els.importAccountButton.disabled) els.importAccountButton.textContent = '导入当前账号';
    }, 1800);
  } finally {
    els.importAccountButton.disabled = false;
  }
});
els.cancelSwitchButton.addEventListener('click', closeSwitchDialog);
async function performAccountSwitch(strategy) {
  const account = state.pendingSwitchAccount;
  if (!account) return;
  state.switchPhase = 'switching';
  setSwitchActions('busy', strategy);
  setSwitchStatus(
    strategy === 'auto'
      ? '正在关闭完整 Codex 桌面端、保存当前最新认证并切换账号...'
      : '正在保存当前最新认证并替换活动 auth.json...',
    'pending'
  );
  try {
    const result = await window.codexUsage.switchAccount(account.id, strategy);
    state.snapshot = snapshotFromResult(result);
    render();
    const displayName = accountDisplayName(result?.account || account);

    if (strategy === 'manual') {
      state.switchPhase = 'done';
      els.confirmTitle.textContent = '账号已切换';
      els.confirmBody.textContent = `当前账号已切换为 ${displayName}。`;
      setSwitchStatus('当前认证已保存并切换。现在可以打开 Codex；项目和任务状态保持共用。', 'success');
      setSwitchActions('done');
      return;
    }

    const restartResult = result?.restart;
    state.switchPhase = 'done';
    els.confirmTitle.textContent = restartResult?.ok ? '自动切换完成' : '账号已切换';
    els.confirmBody.textContent = `当前账号已切换为 ${displayName}。`;
    setSwitchStatus(restartResult?.ok
      ? `${restartResult.message || 'Codex 已重新启动'}；项目、任务、会话和配置继续共用。`
      : (restartResult?.message || '认证已切换，但 Codex 自动启动失败，请手动打开。'), restartResult?.ok ? 'success' : 'error');
    setSwitchActions('done');
  } catch (error) {
    state.switchPhase = 'choice';
    setSwitchStatus(`切换失败：${String(error?.message || error || '未知错误')}`, 'error');
    setSwitchActions('choice');
  } finally {
    schedulePanelHeightResize();
  }
}

els.manualSwitchButton.addEventListener('click', () => performAccountSwitch('manual'));
els.autoSwitchButton.addEventListener('click', () => performAccountSwitch('auto'));
els.themeToggleButton.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
els.aboutButton.addEventListener('click', () => window.codexUsage.openAbout());
els.openButton.addEventListener('click', () => window.codexUsage.openWeb());
els.quitButton.addEventListener('click', () => window.codexUsage.quit());
window.codexUsage.onSnapshot((value) => {
  state.snapshot = value;
  render();
});

state.pricing = loadPricingSettings();
applyTheme(state.theme);
load();
