function mergePatch(base, patch) {
  const next = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      next[key] = value;
    } else if (value && typeof value === 'object') {
      next[key] = mergePatch(next[key] || {}, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function mergeSparse(base, patch) {
  const next = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      next[key] = value;
    } else if (typeof value === 'object') {
      next[key] = mergeSparse(next[key] || {}, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

module.exports = { mergePatch, mergeSparse };
