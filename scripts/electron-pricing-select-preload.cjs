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
    usageWindows: { fiveHour: { remainingPercent: 82 } }
  },
  accounts: [],
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
      }
    }
  }
});

const layout = Object.freeze({ orbX: 8, orbY: 8, panelX: 148, side: 'right' });
const noOp = () => Promise.resolve();

contextBridge.exposeInMainWorld('codexUsage', {
  getSnapshot: () => Promise.resolve(snapshot),
  refresh: () => Promise.resolve(snapshot),
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
