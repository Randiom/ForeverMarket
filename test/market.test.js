const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePriceTable, limitedCraft, balancedPicks, priceMaterials, currentCraft } = require('../market');
const { rankDeals, rankCrafts } = require('../bot');
const now = '2026-11-23T12:00:00.000Z';
const recipe = { spellId: 1, name: 'Bolt of Cloth', profession: 'Tailoring', skillRequired: 70, acquisition: 'trainer' };
const item = { id: 1, name: 'Cloth', url: 'https://ahledger.com/items/1-cloth' };
const craft = { recipe, result: { ...item, qtyMin: 1 }, resultPrice: 1000, cost: 800, margin: 150, resultSalesPerDay: 500, resultListed: 500, resultClearDays: 1, unpriced: [], reagents: [{ id: 2, name: 'Cloth', qty: 2, price: 400 }] };

test('full table includes small spreads and converts sales-per-day correctly', () => {
  const data = parsePriceTable('AHL1|forever/pvp/horde/eu|1795435200|1\n1:1000:800:100:1000:1000:800:1200:5000', 'forever.pvp.horde.eu');
  assert.equal(data.deals[0].salesPerDay, 500);
  assert.equal(data.deals[0].referenceMedian, 1000);
  assert.equal(rankDeals(data).length, 1);
  assert.throws(() => parsePriceTable('AHL1|wrong|1|1\n1:2', 'forever.pvp.horde.eu'), /Invalid/);
  assert.throws(() => parsePriceTable('AHL1|forever/pvp/horde/eu|1|2\n1:2', 'forever.pvp.horde.eu'), /Invalid/);
});

test('known cooldown crafts cannot appear as repeatable opportunities', () => {
  for (const [name, spellId] of [['Transmute: Arcanite', 17187], ['Transmute: Undeath to Water', 17563], ['Mooncloth', 18560]]) {
    const row = { ...craft, recipe: { ...recipe, name, spellId } };
    assert.equal(limitedCraft(row), true);
    assert.equal(rankCrafts({ recipes: [row] }).length, 0);
  }
  assert.equal(limitedCraft(craft), false);
});

test('a small-margin, liquid trainer craft is no longer discarded by the 1g floor', () => {
  assert.equal(rankCrafts({ recipes: [craft] }).length, 1);

});

test('material costs use available current quotes and a 2% buffer, not free materials', () => {
  const quotes = { 2: { median: 450, minBuyout: 420, quantity: 30, observedAt: now } };
  const priced = priceMaterials(craft, quotes, now);
  assert.equal(priced.cost, 918);
  assert.equal(priced.reagents[0].available, 30);
  assert.equal(priceMaterials(craft, {}, now), null);
  assert.equal(priceMaterials(craft, { 2: { ...quotes[2], quantity: 1 } }, now), null);
  assert.equal(priceMaterials(craft, { 2: { ...quotes[2], observedAt: '2026-11-20T00:00:00Z' } }, now), null);
});

test('large apparent ROI disappears when actual input costs are checked', () => {
  const priced = priceMaterials(craft, { 2: { median: 600, minBuyout: 590, quantity: 20, observedAt: now } }, now);
  assert.equal(rankCrafts({ recipes: [{ ...priced, margin: 931 - priced.cost }] }).length, 0);
});

test('mixed selection gives volume and low capital picks room before a huge profit item', () => {
  const rows = [
    { ...craft, result: { ...item, id: 1 }, resultSalesPerDay: 500, cost: 800, margin: 150 },
    { ...craft, result: { ...item, id: 2 }, resultSalesPerDay: 50, cost: 200, margin: 20 },
    { ...craft, result: { ...item, id: 3 }, resultSalesPerDay: 30, cost: 1000000, margin: 500000 },
  ];
  assert.deepEqual(balancedPicks(rows, 2, true).map(row => row.result.id), [1, 2]);
});

test('current craft targets use current competition, minimum yield, one AH cut and buffered inputs', () => {
  const quotes = {
    1: { minBuyout: 1000, median: 1200, quantity: 50, salesPerDay: 500, observedAt: now },
    2: { minBuyout: 400, median: 400, quantity: 100, observedAt: now },
  };
  const result = currentCraft({ ...craft, resultPrice: 100000, reagents: [{ id: 2, qty: 2, price: 100000 }] }, quotes, now);
  assert.equal(result.cost, 816);
  assert.equal(result.resultPrice, 980);
  assert.equal(result.margin, 115);
  assert.equal(currentCraft(craft, { 2: quotes[2] }, now), null);
  assert.equal(currentCraft({ ...craft, result: { ...item, qtyMin: 0 } }, quotes, now), null);
  assert.equal(rankCrafts({ recipes: [{ ...result, margin: result.cost * 2 }] }).length, 0);
});

test('table ignores both low and high historical medians for current price calculations', () => {
  for (const oldPrice of [1, 999999]) {
    const data = parsePriceTable(`AHL1|forever/pvp/horde/eu|1795435200|1\n1:1000:800:100:${oldPrice}:${oldPrice}:1:999999:5000`, 'forever.pvp.horde.eu');
    assert.equal(data.deals[0].referenceMedian, 1000);
  }
});

test('craft selection can include forty distinct outputs', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ ...craft, result: { ...craft.result, id: i + 1 }, resultSalesPerDay: 1000 - i }));
  const candidates = rankCrafts({ recipes: rows });
  assert.equal(candidates.length, 40);
  assert.ok(candidates.some(row => row.result.id > 8));
});

test('authenticated scanning can select one hundred distinct crafted outputs', () => {
  const rows = Array.from({ length: 125 }, (_, i) => ({ ...craft, result: { ...craft.result, id: i + 1 }, resultSalesPerDay: 1000 - i }));
  assert.equal(rankCrafts({ recipes: rows }, 100).length, 100);
});

test('auction profit matches the displayed whole-copper target and applies the AH cut once', () => {
  const [row] = rankDeals({ deals: [{ item, median: 1003, referenceMedian: 999999, minBuyout: 800, quantity: 20, salesPerDay: 100 }] });
  assert.equal(row.referenceMedian, 982);
  assert.equal(row.profit, 132);
});
