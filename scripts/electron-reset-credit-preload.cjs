const { contextBridge } = require('electron');

const account = { id: 'current', accountKey: 'account-a', nickname: '测试账号', planTier: 'plus', isCurrent: true };
const card = { id: 'credit-1', label: '完整重置卡（周 + 5 小时）', count: 1, expiresAt: '2099-01-01T00:00:00Z' };
let snapshot = { windowSize: 116, currentAccount: account, accounts: [account], resetCards: [card], sourceStatus: '测试数据' };
let calls = [];
let fail = false;
let refreshPending = false;
contextBridge.exposeInMainWorld('codexUsage', {
  getSnapshot: async () => snapshot,
  getPricing: async () => ({ models: {} }),
  getSettings: async () => ({ refreshIntervalMinutes: 30, alwaysOnTop: true, orbStyle: 'classic' }),
  onSnapshot: () => {}, onPricing: () => {},
  setDetailOpen: async () => ({ side: 'right', orbX: 8, panelX: 156, orbY: 8 }),
  setPanelHeight: async () => null,
  useResetCredit: async (request) => {
    calls.push(request);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (fail) throw new Error('暂时无法确认使用结果，请重试此卡');
    if (refreshPending) return { code: 'reset', refreshPending: true, message: '重置卡使用成功；数据暂未刷新，请稍后手动刷新' };
    snapshot = { ...snapshot, resetCards: [], usageWindows: { fiveHour: { remainingPercent: 100 } } };
    return { code: 'reset', message: '重置卡使用成功，额度与卡片已刷新', snapshot };
  }
});
contextBridge.exposeInMainWorld('resetCreditTest', {
  calls: () => calls,
  setFailure: (value) => { fail = value; },
  setRefreshPending: (value) => { refreshPending = value; },
  reset: () => { calls = []; snapshot = { ...snapshot, resetCards: [card] }; return snapshot; }
});
