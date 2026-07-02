const state = {
  snapshot: null,
  size: 116,
  sizeInitialized: false,
  panelOpen: false,
  dragging: null
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
  fiveHourUsed: document.getElementById('fiveHourUsed'),
  fiveHourRemain: document.getElementById('fiveHourRemain'),
  fiveHourReset: document.getElementById('fiveHourReset'),
  fiveHourBar: document.getElementById('fiveHourBar'),
  oneWeekUsed: document.getElementById('oneWeekUsed'),
  oneWeekRemain: document.getElementById('oneWeekRemain'),
  oneWeekReset: document.getElementById('oneWeekReset'),
  oneWeekBar: document.getElementById('oneWeekBar'),
  lastSyncedText: document.getElementById('lastSyncedText'),
  planText: document.getElementById('planText'),
  expiresText: document.getElementById('expiresText'),
  cardCountText: document.getElementById('cardCountText'),
  resetCards: document.getElementById('resetCards'),
  tokenSourceText: document.getElementById('tokenSourceText'),
  token24h: document.getElementById('token24h'),
  token7d: document.getElementById('token7d'),
  token30d: document.getElementById('token30d')
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

function usageWindow(data, key) {
  return data?.usageWindows?.[key] || null;
}

function renderUsageCard(window, usedEl, remainEl, resetEl, barEl) {
  const used = Number(window?.usedPercent);
  const remaining = Number(window?.remainingPercent);
  const safeRemaining = Number.isFinite(remaining) ? clamp(remaining, 0, 100) : 0;
  const accent = accentForRemaining(remaining);
  usedEl.textContent = formatPercent(remaining);
  usedEl.style.color = accent;
  remainEl.textContent = formatPercent(used);
  resetEl.textContent = formatMinute(window?.resetAt);
  barEl.style.width = `${safeRemaining}%`;
  barEl.style.background = `linear-gradient(90deg, ${accent}, color-mix(in srgb, ${accent} 70%, #ffffff 30%))`;
}

function normalizeResetCards(cards = []) {
  const rows = [];
  for (const card of cards) {
    const count = Math.max(0, Math.floor(Number(card.count) || 0));
    for (let index = 0; index < Math.min(count, 50); index += 1) rows.push({ ...card, count: 1 });
  }
  return rows;
}

function renderCards(cards = []) {
  const available = normalizeResetCards(cards);
  els.resetCards.replaceChildren();
  const availableCount = cards.reduce((total, card) => total + Math.max(0, Number(card.count) || 0), 0);
  els.cardCountText.textContent = `${formatNumber(availableCount)} 张`;
  if (!available.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '当前没有可用重置卡';
    els.resetCards.appendChild(empty);
    return;
  }
  available.forEach((card, index) => {
    const row = document.createElement('article');
    row.className = 'reset-card';
    const title = document.createElement('strong');
    title.textContent = `#${index + 1} ${card.label || '重置卡'}`;
    const meta = document.createElement('span');
    const time = card.expiresAt
      ? formatMinute(card.expiresAt)
      : card.resetAt
        ? formatMinute(card.resetAt)
        : '有效期未知';
    meta.textContent = time;
    row.append(title, meta);
    els.resetCards.appendChild(row);
  });
}

function renderTokens(tokenUsage) {
  if (!tokenUsage) {
    els.tokenSourceText.textContent = '--';
    els.token24h.textContent = '--';
    els.token7d.textContent = '--';
    els.token30d.textContent = '--';
    return;
  }
  const source = tokenUsage.sourceLabel || '当前账号';
  const detail = tokenUsage.source === 'account-profile'
    ? tokenUsage.mayBeDelayed ? ' · 延迟更新' : ''
    : ` · ${formatNumber(tokenUsage.eventCount || 0)} 条`;
  els.tokenSourceText.textContent = `${source}${detail}`;
  els.token24h.textContent = formatTokens((tokenUsage.today || tokenUsage.last24h)?.totalTokens);
  els.token7d.textContent = formatTokens(tokenUsage.last7d?.totalTokens);
  els.token30d.textContent = formatTokens(tokenUsage.last30d?.totalTokens);
}

function render() {
  const data = state.snapshot || {};
  const fiveHour = usageWindow(data, 'fiveHour');
  const oneWeek = usageWindow(data, 'oneWeek');
  if (!state.sizeInitialized && Number.isFinite(Number(data.windowSize))) {
    state.size = Number(data.windowSize);
    state.sizeInitialized = true;
  }

  const remaining = Number(fiveHour?.remainingPercent);
  const remainingSafe = Number.isFinite(remaining) ? clamp(remaining, 0, 100) : 0;
  const accent = accentForRemaining(remaining);

  els.root.style.setProperty('--accent', accent);
  els.root.style.setProperty('--orb-size', `${state.size}px`);
  els.ringFill.style.setProperty('--angle', `${remainingSafe * 3.6}deg`);
  els.tierText.textContent = formatTier(data.planTier);
  els.percentText.textContent = formatPercent(remaining);
  els.percentText.style.color = accent;
  els.orbCaption.textContent = '5h 剩余';
  const sourceStatus = data.sourceStatus === '已同步 Codex 用量' ? '已同步' : data.sourceStatus || '等待同步';
  els.lastSyncedText.textContent = data.lastSyncedAt
    ? `刷新 ${formatMinute(data.lastSyncedAt)} · ${sourceStatus}`
    : sourceStatus;
  renderUsageCard(fiveHour, els.fiveHourUsed, els.fiveHourRemain, els.fiveHourReset, els.fiveHourBar);
  renderUsageCard(oneWeek, els.oneWeekUsed, els.oneWeekRemain, els.oneWeekReset, els.oneWeekBar);

  els.planText.textContent = formatTier(data.planTier);
  els.expiresText.textContent = formatMinute(data.membershipExpiresAt);
  renderCards(data.resetCards || []);
  renderTokens(data.tokenUsage);
}

function applyLayout(layout) {
  if (!layout) return;
  els.root.style.setProperty('--orb-x', `${layout.orbX}px`);
  els.root.style.setProperty('--orb-y', `${layout.orbY}px`);
  els.root.style.setProperty('--panel-x', `${layout.panelX}px`);
  document.body.classList.toggle('panel-left', layout.side === 'left');
  document.body.classList.toggle('panel-right', layout.side !== 'left');
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

els.closePanel.addEventListener('click', () => setPanelOpen(false));
els.scrim.addEventListener('click', () => setPanelOpen(false));
els.refreshButton.addEventListener('click', refresh);
els.openButton.addEventListener('click', () => window.codexUsage.openWeb());
els.quitButton.addEventListener('click', () => window.codexUsage.quit());
window.codexUsage.onSnapshot((value) => {
  state.snapshot = value;
  render();
});

load();
