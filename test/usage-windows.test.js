const test = require('node:test');
const assert = require('node:assert/strict');
const { mapAggregateUsageWindows } = require('../src/lib/usage-windows');

test('额外模型的 5 小时额度不会冒充聚合 Codex 额度', () => {
  const result = mapAggregateUsageWindows({
    rate_limit: {
      primary_window: {
        used_percent: 4,
        limit_window_seconds: 604800,
        reset_at: 1787803740
      },
      secondary_window: null
    },
    additional_rate_limits: [{
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18000,
          reset_at: 1787312580
        }
      }
    }]
  });

  assert.equal(result.fiveHour, null);
  assert.equal(result.oneWeek.remainingPercent, 96);
  assert.equal(result.oneWeek.windowSeconds, 604800);
});

test('顶层聚合额度仍可同时识别真实的 5 小时和 1 周窗口', () => {
  const result = mapAggregateUsageWindows({
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 18000,
        reset_at: 1787312580
      },
      secondary_window: {
        used_percent: 40,
        limit_window_seconds: 604800,
        reset_at: 1787803740
      }
    }
  });

  assert.equal(result.fiveHour.remainingPercent, 75);
  assert.equal(result.oneWeek.remainingPercent, 60);
});

test('未知时长不会按最接近规则误标为 5 小时或 1 周', () => {
  const result = mapAggregateUsageWindows({
    rate_limit: {
      primary_window: {
        used_percent: 12,
        limit_window_seconds: 3600,
        reset_at: 1787312580
      }
    }
  });

  assert.deepEqual(result, { fiveHour: null, oneWeek: null });
});
