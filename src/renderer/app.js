const state = {
  snapshot: null,
  size: 116,
  sizeInitialized: false,
  panelOpen: false,
  dragging: null,
  localRange: 'today',
  pendingSwitchAccount: null,
  panelHeightTimer: null
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
  refreshButton: document.getElementById('refreshButton'),
  openButton: document.getElementById('openButton'),
  quitButton: document.getElementById('quitButton'),
  resizeGrip: document.getElementById('resizeGrip'),
  lastSyncedText: document.getElementById('lastSyncedText'),
  currentAccountText: document.getElementById('currentAccountText'),
  currentTierPill: document.getElementById('currentTierPill'),
  importAccountButton: document.getElementById('importAccountButton'),
  accountsList: document.getElementById('accountsList'),
  resetCardsTitle: document.getElementById('resetCardsTitle'),
  cardCountText: document.getElementById('cardCountText'),
  resetCards: document.getElementById('resetCards'),
  localInputTokens: document.getElementById('localInputTokens'),
  localCachedTokens: document.getElementById('localCachedTokens'),
  localCacheRate: document.getElementById('localCacheRate'),
  localOutputTokens: document.getElementById('localOutputTokens'),
  localTokenMeta: document.getElementById('localTokenMeta'),
  confirmDialog: document.getElementById('confirmDialog'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmBody: document.getElementById('confirmBody'),
  cancelSwitchButton: document.getElementById('cancelSwitchButton'),
  confirmSwitchButton: document.getElementById('confirmSwitchButton')
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function tokenUsageHint(tokenUsage) {
  if (tokenUsage?.source === 'account-profile') return '';
  return '';
}

function normalizeResetCards(cards = []) {
  const rows = [];
  for (const card of cards) {
    const count = Math.max(0, Math.floor(Number(card.count) || 0));
    for (let index = 0; index < Math.min(count, 50); index += 1) rows.push({ ...card, count: 1 });
  }
  return rows;
}

function createMiniQuota(label, window) {
  const remaining = Number(window?.remainingPercent);
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

    nameLine.append(nicknameNode, usernameNode, planNode);
    if (account.isCurrent) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'account-active-badge';
      activeBadge.textContent = '使用中';
      nameLine.appendChild(activeBadge);
    }
    title.appendChild(nameLine);
    header.appendChild(title);
    const headerActions = document.createElement('div');
    headerActions.className = 'account-card-actions';
    const button = document.createElement('button');
    button.className = account.isCurrent ? 'mini-button current' : 'mini-button';
    button.textContent = account.isCurrent ? '当前账号' : '切换';
    button.disabled = Boolean(account.isCurrent);
    if (!account.isCurrent) {
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
    tokenLine.textContent = `Token 今日 ${today} · 7天 ${last7d} · 30天 ${last30d}${tokenUsageHint(account.tokenUsage)}`;
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

function renderLocalSummary(summary) {
  const current = localWindow(summary);
  els.localInputTokens.textContent = formatTokens(current?.inputTokens);
  els.localCachedTokens.textContent = formatTokens(current?.cachedInputTokens);
  els.localCacheRate.textContent = Number.isFinite(Number(current?.cacheRate)) ? formatPercent(current.cacheRate) : '--';
  els.localOutputTokens.textContent = formatTokens(current?.outputTokens);
  els.localTokenMeta.textContent = [
    `推理输出 ${formatTokens(current?.reasoningOutputTokens)}`,
    `总计 ${formatTokens(current?.totalTokens)}`,
    `${formatNumber(summary?.sourceFileCount || 0)} 个文件`,
    `${formatNumber(current?.eventCount || 0)} 条`
  ].join(' · ');
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
  els.ringFill.style.setProperty('--angle', `${remainingSafe * 3.6}deg`);
  els.tierText.textContent = formatTier(currentAccount?.planTier || data.planTier);
  els.percentText.textContent = formatPercent(remaining);
  els.percentText.style.color = accent;
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
  state.snapshot = await window.codexUsage.getSnapshot();
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

function openSwitchDialog(account) {
  state.pendingSwitchAccount = account;
  els.confirmTitle.textContent = `切换到 ${account.nickname || account.username || '该账号'}？`;
  els.confirmBody.textContent = '会替换当前 auth.json，已运行的 Codex 会话可能需要新开 turn 或重启。';
  els.confirmDialog.hidden = false;
}

function closeSwitchDialog() {
  state.pendingSwitchAccount = null;
  els.confirmDialog.hidden = true;
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
els.importAccountButton.addEventListener('click', async () => {
  els.importAccountButton.disabled = true;
  try {
    state.snapshot = await window.codexUsage.importCurrentAccount();
    render();
  } finally {
    els.importAccountButton.disabled = false;
  }
});
els.cancelSwitchButton.addEventListener('click', closeSwitchDialog);
els.confirmSwitchButton.addEventListener('click', async () => {
  const account = state.pendingSwitchAccount;
  if (!account) return;
  els.confirmSwitchButton.disabled = true;
  try {
    state.snapshot = await window.codexUsage.switchAccount(account.id);
    closeSwitchDialog();
    render();
  } finally {
    els.confirmSwitchButton.disabled = false;
  }
});
els.openButton.addEventListener('click', () => window.codexUsage.openWeb());
els.quitButton.addEventListener('click', () => window.codexUsage.quit());
window.codexUsage.onSnapshot((value) => {
  state.snapshot = value;
  render();
});

load();
