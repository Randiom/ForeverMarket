const { test } = require('node:test');
const assert = require('node:assert/strict');
const { copper, rankDeals, rankCrafts, run } = require('../bot');

const item = { name: 'Test @everyone', url: 'https://ahledger.com/items/1-test' };
const now = new Date().toISOString();
const deal = { item, minBuyout: 50000, referenceMedian: 100000, discount: .5, quantity: 3, salesPerDay: 2 };
const craft = { recipe: { name: 'Test craft', profession: 'Alchemy' }, result: item, cost: 50000, margin: 20000, profitPerDay: 40000, resultSalesPerDay: 2, resultClearDays: 2, unpriced: [] };

test('money and ranking exclude low liquidity and unpriced crafts', () => {
  assert.equal(copper(123456), '12g 34s 56c');
  assert.equal(rankDeals({ deals: [deal, { ...deal, salesPerDay: 0 }] }).length, 1);
  assert.equal(rankCrafts({ recipes: [craft, { ...craft, unpriced: [1] }] }).length, 1);
});

test('fetches both feeds and posts a safe, credited webhook report', async () => {
  let sent;
  const fetcher = async (url, options) => {
    if (url.includes('/deals/')) return { ok: true, json: async () => ({ market: 'forever.pvp.horde.eu', marketStatus: 'scanned', pricesAsOf: now, deals: [deal] }) };
    if (url.includes('/crafting/')) return { ok: true, json: async () => ({ market: 'forever.pvp.horde.eu', marketStatus: 'scanned', pricesAsOf: now, recipes: url.includes('profession=Alchemy') ? [craft] : [] }) };
    sent = JSON.parse(options.body);
    return { ok: true };
  };
  await run({ fetcher, webhook: 'https://discord.com/api/webhooks/123/token' });
  assert.equal(sent.embeds.length, 2);
  assert.equal(sent.embeds[1].description.split('\n').length, 1);
  assert.match(sent.embeds[0].description, /4g 50s 0c net\/unit/);
  assert.match(sent.embeds[0].description, /@\u200beveryone/);
  assert.deepEqual(sent.allowed_mentions, { parse: [] });
  assert.match(sent.content, /Prices from AHledger/);
});

test('rejects stale scans before posting', async () => {
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  let posted = false;
  const fetcher = async (url) => {
    if (url.includes('discord.com')) posted = true;
    return { ok: true, json: async () => ({ market: 'forever.pvp.horde.eu', marketStatus: 'scanned', pricesAsOf: old, deals: [], recipes: [] }) };
  };
  await assert.rejects(run({ fetcher, webhook: 'https://discord.com/api/webhooks/123/token' }), /stale/);
  assert.equal(posted, false);
});
