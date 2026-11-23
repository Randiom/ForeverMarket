const { test } = require('node:test');
const assert = require('node:assert/strict');
const { copper, rankDeals, rankCrafts, makePayload, run } = require('../bot');

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
  assert.equal(sent.embeds[1].fields.length, 1);
  assert.match(sent.embeds[0].fields[0].value, /4.50g net\/unit/);
  assert.match(sent.embeds[0].fields[0].name, /@\u200beveryone/);
  assert.match(sent.embeds[0].description, /EU · PvP · Horde/);
  assert.equal(sent.embeds[0].fields[0].inline, false);
  assert.deepEqual(sent.allowed_mentions, { parse: [] });
  assert.match(sent.content, /Prices from AHledger/);
});

test('long item names and URLs fit Discord embed limits', () => {
  const longItem = { name: '@_'.repeat(100), url: `https://ahledger.com/items/${'x'.repeat(400)}` };
  const deals = Array.from({ length: 8 }, () => ({ ...deal, item: longItem, profit: 45000 }));
  const crafts = Array.from({ length: 8 }, () => ({ ...craft, result: longItem }));
  const payload = makePayload(deals, crafts, now, 'forever.pvp.horde.eu');
  let total = 0;
  for (const embed of payload.embeds) {
    total += embed.title.length + embed.description.length + embed.footer.text.length;
    assert.ok(embed.fields.length <= 25);
    for (const field of embed.fields) {
      assert.ok(field.name.length <= 256);
      assert.ok(field.value.length <= 1024);
      total += field.name.length + field.value.length;
    }
  }
  assert.ok(total <= 6000);
});

test('empty reports explain filters and link to the source', () => {
  const payload = makePayload([], [], now, 'forever.pvp.horde.eu');
  assert.match(payload.embeds[0].description, /No deals meet/);
  assert.match(payload.embeds[1].description, /No crafts meet/);
  assert.ok(payload.embeds.every(embed => embed.url.startsWith('https://ahledger.com/')));
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
