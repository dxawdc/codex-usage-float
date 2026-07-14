const { contextBridge } = require('electron');

const snapshot = Object.freeze({
  windowSize: 116,
  sourceStatus: '已同步 Codex 用量',
  currentAccount: {
    id: 'smoke-account',
    nickname: 'Smoke',
    username: 'smoke@example.com',
    isCurrent: true,
    planTier: 'Plus',
    usageWindows: { fiveHour: { remainingPercent: 82 } },
    resetCards: [{ label: 'Codex 重置卡', count: 3 }]
  },
  accounts: [{
    id: 'smoke-account',
    nickname: 'Smoke',
    username: 'smoke@example.com',
    isCurrent: true,
    planTier: 'Plus',
    usageWindows: { fiveHour: { remainingPercent: 82 } },
    resetCards: [{ label: 'Codex 重置卡', count: 3 }]
  }],
  resetCards: [],
  localTokenSummary: {
    sourceFileCount: 1,
    windows: {
      today: {
        inputTokens: 1000,
        cachedInputTokens: 250,
        outputTokens: 500,
        totalTokens: 1500,
        eventCount: 1,
        modelBreakdown: [{ model: 'gpt-5.5', inputTokens: 1000, cachedInputTokens: 250, outputTokens: 500, totalTokens: 1500 }]
      },
      last7d: {
        inputTokens: 7000,
        cachedInputTokens: 3500,
        outputTokens: 1400,
        totalTokens: 8400,
        cacheRate: 50,
        eventCount: 4,
        modelBreakdown: [
          { model: 'gpt-5.5', inputTokens: 4000, cachedInputTokens: 2000, outputTokens: 800, totalTokens: 4800 },
          { model: 'gpt-5.4-mini', inputTokens: 3000, cachedInputTokens: 1500, outputTokens: 600, totalTokens: 3600 }
        ]
      },
      last30d: {
        inputTokens: 12000,
        cachedInputTokens: 6000,
        outputTokens: 2400,
        totalTokens: 14400,
        cacheRate: 50,
        eventCount: 7,
        modelBreakdown: [{ model: 'gpt-5.5', inputTokens: 12000, cachedInputTokens: 6000, outputTokens: 2400, totalTokens: 14400 }]
      },
      lifetime: {
        inputTokens: 20000,
        cachedInputTokens: 10000,
        outputTokens: 4000,
        totalTokens: 24000,
        cacheRate: 50,
        eventCount: 12,
        modelBreakdown: [{ model: 'gpt-5.5', inputTokens: 20000, cachedInputTokens: 10000, outputTokens: 4000, totalTokens: 24000 }]
      }
    },
    daily: [{ date: '2026-07-12', totalTokens: 8400, eventCount: 4 }]
  }
});

const refreshedSnapshot = Object.freeze({
  ...snapshot,
  currentAccount: {
    ...snapshot.currentAccount,
    usageWindows: { fiveHour: { remainingPercent: 57 } }
  },
  accounts: snapshot.accounts.map((account) => ({
    ...account,
    usageWindows: { fiveHour: { remainingPercent: 57 } }
  }))
});

const layout = Object.freeze({ orbX: 8, orbY: 8, panelX: 148, side: 'right' });
const noOp = () => Promise.resolve();

contextBridge.exposeInMainWorld('codexUsage', {
  getSnapshot: () => Promise.resolve(snapshot),
  getSettings: () => Promise.resolve({ refreshIntervalMinutes: 30, alwaysOnTop: true }),
  saveSettings: () => Promise.resolve({ refreshIntervalMinutes: 30, alwaysOnTop: true }),
  refresh: () => Promise.resolve(refreshedSnapshot),
  openWeb: noOp,
  openAbout: noOp,
  prepareAddAccount: noOp,
  importCurrentAccount: () => Promise.resolve({ snapshot }),
  switchAccount: () => Promise.resolve({ snapshot }),
  deleteAccount: () => Promise.resolve(snapshot),
  refreshLocalTokenSummary: () => Promise.resolve(snapshot.localTokenSummary),
  setSize: (size) => Promise.resolve({ size, layout }),
  setPanelHeight: () => Promise.resolve(layout),
  moveBy: noOp,
  setDetailOpen: () => Promise.resolve(layout),
  quit: noOp,
  onSnapshot: () => undefined
});
