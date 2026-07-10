const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePatch, mergeSparse } = require('../src/lib/object-utils');

test('mergePatch allows explicit null and empty-string clearing', () => {
  assert.deepEqual(
    mergePatch({ credits: 10, source: 'old', nested: { value: 1 } }, {
      credits: null,
      source: '',
      nested: { value: null },
      ignored: undefined
    }),
    { credits: null, source: '', nested: { value: null } }
  );
});

test('mergeSparse preserves fallback values for absent API fields', () => {
  assert.deepEqual(
    mergeSparse({ plan: 'plus', remaining: 50 }, { plan: null, remaining: 0 }),
    { plan: 'plus', remaining: 0 }
  );
});
