const PRICING_URL = 'https://developers.openai.com/api/docs/pricing.md';
const MAX_PRICING_AGE_MS = 24 * 60 * 60 * 1000;

function parseDollar(value) {
  const match = /^\$([0-9]+(?:\.[0-9]+)?)$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function parseRows(table, modelColumn, inputColumn, cachedColumn, outputColumn) {
  const models = {};
  for (const line of table.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const model = cells[modelColumn]?.split(' ')[0]?.toLowerCase();
    const input = parseDollar(cells[inputColumn] || '');
    const cachedInput = parseDollar(cells[cachedColumn] || '');
    const output = parseDollar(cells[outputColumn] || '');
    if (!/^[a-z][a-z0-9.-]+$/.test(model || '') || input === null || cachedInput === null || output === null) continue;
    models[model] = { input, cachedInput, output };
  }
  return models;
}

function tableAfter(text, marker, header) {
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const tableStart = text.indexOf(header, start);
  if (tableStart < 0) return '';
  const tableEnd = text.indexOf('\n\n', tableStart);
  return text.slice(tableStart, tableEnd < 0 ? undefined : tableEnd);
}

function parseOfficialPricing(markdown) {
  if (typeof markdown !== 'string' || !markdown.startsWith('# Pricing')) throw new Error('官方定价页面格式无效');
  const standardHeader = '| Model | Short context input | Short context cached input | Short context cache writes | Short context output |';
  const standard = tableAfter(markdown, '### Standard pricing data', standardHeader);
  const models = parseRows(standard, 0, 1, 2, 4);
  if (Object.keys(models).length < 5) throw new Error('官方标准费率表解析失败');
  const cyberSection = markdown.slice(markdown.indexOf('Cyber models'));
  const cyber = tableAfter(cyberSection, 'Cyber models', standardHeader);
  Object.assign(models, parseRows(cyber, 0, 1, 2, 4));
  const specializedSection = markdown.slice(markdown.indexOf('Specialized models'));
  const specialized = tableAfter(specializedSection, 'Specialized models', '| Category | Model | Input | Cached input | Output |');
  for (const line of specialized.split('\n')) {
    if (!line.startsWith('| Codex |')) continue;
    Object.assign(models, parseRows(line, 1, 2, 3, 4));
  }
  return models;
}

function isValidCatalog(value) {
  if (!value || typeof value !== 'object' || !value.models || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  return Object.keys(value.models).length >= 5 && Object.entries(value.models).every(([model, price]) =>
    /^[a-z][a-z0-9.-]+$/.test(model) &&
    ['input', 'cachedInput', 'output'].every((key) => Number.isFinite(price?.[key]) && price[key] >= 0)
  );
}

function createPricingCatalog({ readJson, writeJson, cachePath, fetchText, now = Date.now }) {
  let catalog = null;
  let error = null;
  let inFlight = null;

  function snapshot() {
    return {
      models: catalog?.models || {},
      updatedAt: catalog?.updatedAt || null,
      sourceUrl: PRICING_URL,
      stale: !catalog || now() - Date.parse(catalog.updatedAt) >= MAX_PRICING_AGE_MS,
      error
    };
  }

  async function load() {
    try {
      const saved = await readJson(cachePath(), null);
      if (isValidCatalog(saved)) catalog = saved;
    } catch (cause) {
      error = `定价缓存读取失败：${cause?.message || cause}`;
    }
    return snapshot();
  }

  async function refresh(force = false) {
    if (!force && !snapshot().stale) return snapshot();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const models = parseOfficialPricing(await fetchText(PRICING_URL));
        const next = { models, updatedAt: new Date(now()).toISOString() };
        await writeJson(cachePath(), next);
        catalog = next;
        error = null;
      } catch (cause) {
        error = `官方定价同步失败：${cause?.message || cause}`;
      }
      return snapshot();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { load, refresh, snapshot };
}

module.exports = { PRICING_URL, MAX_PRICING_AGE_MS, parseOfficialPricing, createPricingCatalog };
