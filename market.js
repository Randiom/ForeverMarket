const positive = n => Number.isFinite(n) && n > 0;

function parsePriceTable(text, market) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const [format, slug, timestamp, count] = header.split('|');
  if (format !== 'AHL1' || slug !== market.replaceAll('.', '/') || !positive(Number(timestamp)) || Number(count) !== lines.length) throw new Error('Invalid AHledger price table');
  const deals = lines.flatMap(line => {
    const fields = line.split(':').map(value => value === '' ? null : Number(value));
    const [id, median, minBuyout, quantity, , , , , salesTenths] = fields;
    if (!Number.isInteger(id) || id < 1 || !positive(median) || !positive(minBuyout) || !positive(quantity) || !positive(salesTenths)) return [];
    const referenceMedian = median;
    return [{ item: { id, name: `Item ${id}`, url: `https://ahledger.com/items/${id}` }, median, minBuyout, referenceMedian, quantity, salesPerDay: salesTenths / 10 }];
  });
  return { market, tableGeneratedAt: new Date(Number(timestamp) * 1000).toISOString(), marketStatus: Number(count) > 0 ? 'scanned' : 'no scans', deals };
}

function limitedCraft(row) {
  // The feed omits cooldowns. Block known families rather than assume repeatability.
  return /^Transmute\b/i.test(row.recipe?.name || '') ||
    [17187, 17563, 18560, 19047, 19566].includes(row.recipe?.spellId) ||
    /^(Mooncloth|Cured Rugged Hide|Refined Deeprock Salt)$/i.test(row.recipe?.name || '') ||
    Number(row.recipe?.cooldownSeconds || row.cooldownSeconds) > 0;
}

function balancedPicks(rows, limit, crafting = false) {
  const sales = row => crafting ? row.resultSalesPerDay : row.salesPerDay;
  const cost = row => crafting ? row.cost : row.minBuyout;
  const selected = [], seen = new Set();
  const take = list => {
    const row = list.find(row => !seen.has(crafting ? row.result.id : row.item.id));
    if (row) { selected.push(row); seen.add(crafting ? row.result.id : row.item.id); }
  };
  const liquid = [...rows].sort((a, b) => sales(b) - sales(a) || cost(a) - cost(b));
  const basicTrainer = row => crafting && row.recipe?.acquisition === 'trainer' && row.recipe.skillRequired <= 150 ? 0 : 1;
  const affordable = [...rows].sort((a, b) => basicTrainer(a) - basicTrainer(b) || cost(a) - cost(b) || sales(b) - sales(a));
  while (selected.length < Math.min(limit, rows.length)) {
    const before = selected.length;
    take(selected.length % 3 === 1 ? affordable : liquid);
    if (before === selected.length) break;
  }
  return selected;
}

function priceMaterials(row, quotes, asOf) {
  if (limitedCraft(row) || !row.reagents?.length || row.unpriced?.length) return null;
  const reagents = [];
  for (const reagent of row.reagents) {
    const quote = quotes[reagent.id];
    const age = Math.abs(Date.parse(quote?.observedAt) - Date.parse(asOf));
    if (!quote || !positive(quote.median) || !positive(quote.minBuyout) || !positive(reagent.qty) || !Number.isFinite(quote.quantity) || quote.quantity < reagent.qty || !Number.isFinite(age) || age > 7200000) return null;
    // Cost a purchase from current AH quotes; never assume free farmed or vendor materials.
    const price = Math.ceil(Math.max(quote.median, quote.minBuyout) * 1.02);
    reagents.push({ ...reagent, price, available: quote.quantity });
  }
  return { ...row, reagents, cost: reagents.reduce((sum, reagent) => sum + reagent.qty * reagent.price, 0) };
}

function currentCraft(row, quotes, asOf) {
  const priced = priceMaterials(row, quotes, asOf);
  const output = quotes[row.result?.id];
  if (!priced || !output || !positive(output.minBuyout) || !positive(output.median) || !positive(row.result.qtyMin)) return null;
  const resultPrice = Math.floor(Math.min(output.minBuyout, output.median) * 0.98);
  const margin = Math.floor(resultPrice * row.result.qtyMin * 0.95) - priced.cost;
  return { ...priced, resultPrice, margin, resultSalesPerDay: output.salesPerDay,
    resultListed: output.quantity, resultClearDays: output.quantity / output.salesPerDay };
}

module.exports = { parsePriceTable, limitedCraft, balancedPicks, priceMaterials, currentCraft };
