const { contextBridge } = require('electron');

const accountBase = {
  usageWindows: {
    fiveHour: { remainingPercent: 68, resetAt: '2026-07-15T01:20:00.000Z' },
    oneWeek: { remainingPercent: 42, resetAt: '2026-07-19T09:30:00.000Z' }
  },
  tokenUsage: {
    today: { totalTokens: 184000 },
    last7d: { totalTokens: 1280000 },
    last30d: { totalTokens: 3920000 },
    lifetime: { totalTokens: 9210000 },
    peakDaily: { totalTokens: 618000 },
    peakDate: '2026-07-12'
  }
};

const snapshot = Object.freeze({
  windowSize: 116,
  sourceStatus: '已同步 Codex 用量',
  lastSyncedAt: '2026-07-14T15:45:00.000Z',
  currentAccount: {
    ...accountBase,
    id: 'demo-main',
    nickname: 'Demo Plus',
    username: 'demo-plus@example.com',
    isCurrent: true,
    planTier: 'Plus',
    membershipExpiresAt: '2026-08-10T13:37:34.000Z',
    resetCards: [
      { label: 'Codex 重置卡', count: 2, expiresAt: '2026-07-21T00:00:00.000Z' },
      { label: '周额度补充卡', count: 1, expiresAt: '2026-07-24T00:00:00.000Z' }
    ]
  },
  accounts: [
    {
      ...accountBase,
      id: 'demo-main',
      nickname: 'Demo Plus',
      username: 'demo-plus@example.com',
      isCurrent: true,
      planTier: 'Plus',
      membershipExpiresAt: '2026-08-10T13:37:34.000Z',
      resetCards: [{ label: 'Codex 重置卡', count: 3 }]
    },
    {
      ...accountBase,
      id: 'demo-team',
      nickname: 'Team Workspace',
      username: 'team@example.com',
      isCurrent: false,
      planTier: 'Team',
      membershipExpiresAt: '2026-08-28T10:00:00.000Z',
      usageWindows: {
        fiveHour: { remainingPercent: 91, resetAt: '2026-07-15T02:10:00.000Z' },
        oneWeek: { remainingPercent: 76, resetAt: '2026-07-20T08:00:00.000Z' }
      },
      resetCards: [{ label: '周额度补充卡', count: 1 }]
    },
    {
      ...accountBase,
      id: 'demo-pro',
      nickname: 'Research Pro',
      username: 'research@example.com',
      isCurrent: false,
      planTier: 'Pro',
      membershipExpiresAt: '2026-09-03T09:00:00.000Z',
      usageWindows: {
        fiveHour: { remainingPercent: 36, resetAt: '2026-07-15T00:45:00.000Z' },
        oneWeek: { remainingPercent: 58, resetAt: '2026-07-20T12:00:00.000Z' }
      },
      resetCards: []
    }
  ],
  resetCards: [
    { label: 'Codex 重置卡', count: 2, expiresAt: '2026-07-21T00:00:00.000Z' },
    { label: '周额度补充卡', count: 1, expiresAt: '2026-07-24T00:00:00.000Z' }
  ],
  localTokenSummary: {
    sourceFileCount: 8,
    eventCount: 64,
    windows: {
      today: {
        inputTokens: 420000,
        cachedInputTokens: 132000,
        outputTokens: 86000,
        reasoningOutputTokens: 21000,
        totalTokens: 506000,
        cacheRate: 31.4,
        eventCount: 9,
        modelBreakdown: [
          { model: 'gpt-5.5', inputTokens: 280000, cachedInputTokens: 92000, outputTokens: 64000, totalTokens: 344000 },
          { model: 'gpt-5.4-mini', inputTokens: 140000, cachedInputTokens: 40000, outputTokens: 22000, totalTokens: 162000 }
        ]
      },
      last7d: {
        inputTokens: 2480000,
        cachedInputTokens: 930000,
        outputTokens: 510000,
        reasoningOutputTokens: 126000,
        totalTokens: 2990000,
        cacheRate: 37.5,
        eventCount: 41,
        modelBreakdown: [
          { model: 'gpt-5.5', inputTokens: 1720000, cachedInputTokens: 710000, outputTokens: 390000, totalTokens: 2110000 },
          { model: 'gpt-5.4-mini', inputTokens: 760000, cachedInputTokens: 220000, outputTokens: 120000, totalTokens: 880000 }
        ]
      },
      last30d: {
        inputTokens: 7800000,
        cachedInputTokens: 2880000,
        outputTokens: 1420000,
        reasoningOutputTokens: 360000,
        totalTokens: 9220000,
        cacheRate: 36.9,
        eventCount: 128,
        modelBreakdown: [{ model: 'gpt-5.5', inputTokens: 7800000, cachedInputTokens: 2880000, outputTokens: 1420000, totalTokens: 9220000 }]
      },
      lifetime: {
        inputTokens: 18200000,
        cachedInputTokens: 6950000,
        outputTokens: 3180000,
        reasoningOutputTokens: 820000,
        totalTokens: 21380000,
        cacheRate: 38.2,
        eventCount: 318,
        modelBreakdown: [{ model: 'gpt-5.5', inputTokens: 18200000, cachedInputTokens: 6950000, outputTokens: 3180000, totalTokens: 21380000 }]
      }
    },
    daily: [{ date: '2026-07-14', totalTokens: 506000, eventCount: 9 }]
  }
});

const refreshedSnapshot = Object.freeze({
  ...snapshot,
  currentAccount: {
    ...snapshot.currentAccount,
    usageWindows: {
      ...snapshot.currentAccount.usageWindows,
      fiveHour: { remainingPercent: 57, resetAt: '2026-07-15T01:20:00.000Z' }
    }
  }
});

const layout = Object.freeze({ orbX: 18, orbY: 18, panelX: 150, side: 'right' });
const noOp = () => Promise.resolve();

contextBridge.exposeInMainWorld('codexUsage', {
  getSnapshot: () => Promise.resolve(snapshot),
  getSettings: () => Promise.resolve({ refreshIntervalMinutes: 30, alwaysOnTop: true }),
  saveSettings: (settings) => Promise.resolve({ refreshIntervalMinutes: settings?.refreshIntervalMinutes || 30, alwaysOnTop: settings?.alwaysOnTop !== false }),
  refresh: () => Promise.resolve(refreshedSnapshot),
  openWeb: noOp,
  openAbout: noOp,
  prepareAddAccount: noOp,
  importCurrentAccount: () => Promise.resolve({ snapshot }),
  switchAccount: () => Promise.resolve({ snapshot, restartResult: { ok: true } }),
  deleteAccount: () => Promise.resolve(snapshot),
  refreshLocalTokenSummary: () => Promise.resolve(snapshot.localTokenSummary),
  setSize: (size) => Promise.resolve({ size, layout }),
  setPanelHeight: () => Promise.resolve(layout),
  moveBy: noOp,
  setDetailOpen: () => Promise.resolve(layout),
  quit: noOp,
  onSnapshot: () => undefined
});
