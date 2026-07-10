const test = require('node:test');
const assert = require('node:assert/strict');
const { mapWithConcurrency } = require('../src/lib/async-utils');

test('limits concurrency and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([3, 1, 2, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value * 3));
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(result, [30, 10, 20, 40]);
  assert.equal(peak, 2);
});
