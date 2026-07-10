async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.from(items || []);
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

module.exports = { mapWithConcurrency };
