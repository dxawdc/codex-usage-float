const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOfficialPricing, createPricingCatalog, MAX_PRICING_AGE_MS } = require('../src/lib/pricing-catalog');

const markdown = `# Pricing
### Standard pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |
| gpt-6-luna | $0.10 | $0.01 | $0.125 | $0.50 | $0.20 | $0.02 | $0.25 | $0.75 |
| gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00 |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |
| gpt-5.4-mini | $0.75 | $0.075 | - | $4.50 | - | - | - | - |

Batch
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| gpt-6-sol | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |

Cyber models
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| gpt-5.5-cyber | $12.50 | $1.25 | - | $75.00 | - | - | - | - |

Specialized models
Standard
| Category | Model | Input | Cached input | Output |
| Codex | gpt-5.3-codex | $1.75 | $0.175 | $14.00 |

Fast mode
| Category | Model | Input | Cached input | Output |
| Codex | gpt-5.3-codex | $3.50 | $0.35 | $28.00 |
`;

test('parses standard short-context prices and specialized Codex rates only', () => {
  const models = parseOfficialPricing(markdown);
  assert.deepEqual(models['gpt-6-sol'], { input: 2, cachedInput: 0.2, output: 10 });
  assert.deepEqual(models['gpt-5.5'], { input: 5, cachedInput: 0.5, output: 30 });
  assert.deepEqual(models['gpt-5.5-cyber'], { input: 12.5, cachedInput: 1.25, output: 75 });
  assert.deepEqual(models['gpt-5.3-codex'], { input: 1.75, cachedInput: 0.175, output: 14 });
  assert.equal(models['gpt-6-sol'].input, 2);
  assert.throws(() => parseOfficialPricing('# Changed'), /格式无效/);
});

test('keeps last valid catalog after a failed refresh and retries stale data', async () => {
  let saved = null;
  let now = Date.parse('2026-09-23T00:00:00Z');
  let calls = 0;
  const catalog = createPricingCatalog({
    cachePath: () => 'pricing.json',
    readJson: async () => saved,
    writeJson: async (_path, value) => { saved = value; },
    fetchText: async () => { calls += 1; if (calls > 1) throw new Error('offline'); return markdown; },
    now: () => now
  });
  await catalog.load();
  assert.equal((await catalog.refresh()).models['gpt-6-sol'].output, 10);
  assert.equal(calls, 1);
  await catalog.refresh();
  assert.equal(calls, 1);
  now += MAX_PRICING_AGE_MS;
  const stale = await catalog.refresh();
  assert.equal(stale.stale, true);
  assert.match(stale.error, /offline/);
  assert.equal(stale.models['gpt-6-sol'].output, 10);
  const restored = createPricingCatalog({
    cachePath: () => 'pricing.json',
    readJson: async () => saved,
    writeJson: async () => {},
    fetchText: async () => { throw new Error('offline'); },
    now: () => now
  });
  assert.equal((await restored.load()).models['gpt-6-sol'].output, 10);
});
