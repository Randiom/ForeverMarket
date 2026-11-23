const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { rankDeals, rankCrafts, makePayload, run, craftingProfessions } = require('../bot');
const { updateMessage } = require('../message');

const webhook = 'https://discord.com/api/webhooks/123/token';
const item = { id: 1, name: 'Test @everyone', url: 'https://ahledger.com/items/1-test' };
const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
const deal = { item, minBuyout: 50000, referenceMedian: 100000, discount: .5, quantity: 3, salesPerDay: 50 };
const craft = { recipe: { name: 'Test craft', profession: 'Leatherworking', skillRequired: 225 }, result: item, cost: 50000, margin: 20000, profitPerDay: 40000, resultSalesPerDay: 50, resultClearDays: 2, unpriced: [] };
const response = (data, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => data });
async function state(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'market-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'message.json');
}

function components(node) {
  return [node, ...(node.components || []).flatMap(components), ...(node.accessory ? components(node.accessory) : [])];
}

test('ranking excludes low liquidity and unpriced crafts', () => {
  assert.equal(rankDeals({ deals: [deal, { ...deal, salesPerDay: 0 }] }).length, 1);
  assert.equal(rankCrafts({ recipes: [craft, { ...craft, unpriced: [1] }] }).length, 1);
});

test('old reference peaks and slow sellers cannot monopolize the history shortlist', () => {
  const candidates = rankDeals({ deals: [
    { ...deal, median: 55000, referenceMedian: 10000000 },
    { ...deal, median: 120000 },
    { ...deal, salesPerDay: 2 },
  ] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].referenceMedian, 100000);
});

test('compact board has six picks, real icons, safe mentions, and fits Components V2 limits', () => {
  const deals = Array.from({ length: 8 }, () => ({ ...deal, profit: 45000 }));
  const payload = makePayload(deals, Array(8).fill(craft), now, 'forever.pvp.horde.eu', { 1: 'https://render.worldofwarcraft.com/classic1x-us/icons/56/example.jpg' });
  const all = payload.components.flatMap(components);
  const text = all.filter(c => c.type === 10).map(c => c.content).join('\n');
  assert.equal(all.filter(c => c.type === 11).length, 6);
  assert.equal(payload.flags, 32768);
  assert.equal(payload.embeds, undefined);
  assert.equal(payload.content, undefined);
  assert.ok(all.length <= 40);
  assert.ok(text.length <= 4000);
  assert.match(text, /4.50g\/unit/);
  assert.match(text, /@\u200beveryone/);
  assert.match(text, /EU · PvP · Horde/);
  assert.match(text, /Requires Leatherworking 225/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('empty boards and unavailable icons remain readable', () => {
  const empty = makePayload([], [], now, 'forever.pvp.horde.eu');
  assert.match(JSON.stringify(empty), /No opportunities pass/);
  const noIcons = makePayload([{ ...deal, profit: 45000 }], [], now, 'forever.pvp.horde.eu', { 1: 'https://untrusted.example/icon.jpg' });
  assert.equal(noIcons.components.flatMap(components).filter(c => c.type === 11).length, 0);
});

test('market watch is explicitly separate from validated recommendations', () => {
  const payload = makePayload([], [], now, 'forever.pvp.horde.eu', {}, [{ name: 'Linen Cloth', minBuyout: 22, median: 30, salesPerDay: 500 }]);
  const text = payload.components.flatMap(components).filter(c => c.type === 10).map(c => c.content).join('\n');
  assert.match(text, /not validated buy recommendations/);
  assert.match(text, /Min 22c · median 30c/);
  assert.doesNotMatch(text, /% ROI/);
});

test('long source names and links stay inside message text limits', () => {
  const long = { ...item, name: '*'.repeat(100), url: `https://ahledger.com/items/${'a'.repeat(170)}` };
  const payload = makePayload(Array(3).fill({ ...deal, item: long, profit: 1000 }), Array(3).fill({ ...craft, result: long }), now, 'forever.pvp.horde.eu', {}, [{ name: 'Cloth', minBuyout: 50, median: 100, salesPerDay: 500 }]);
  const all = payload.components.flatMap(components);
  const size = all.filter(c => c.type === 10).reduce((n, c) => n + c.content.length, 0);
  assert.ok(size <= 4000);
  assert.ok(all.length <= 40);
  assert.doesNotMatch(JSON.stringify(payload), /NaN/);
});

test('first run creates a board; another process reads state and edits it', async t => {
  const stateFile = await state(t);
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, ...options }); return response({ id: '456' }); };
  await updateMessage({ webhook, payload: { flags: 32768, components: [] }, fetcher, stateFile });
  await updateMessage({ webhook, payload: { flags: 32768, components: [] }, fetcher, stateFile });
  assert.deepEqual(calls.map(c => c.method), ['POST', 'PATCH']);
  assert.match(calls[0].url, /wait=true&with_components=true/);
  assert.match(calls[1].url, /messages\/456\?with_components=true/);
  const saved = await fs.readFile(stateFile, 'utf8');
  assert.ok(!saved.includes('token'));
  assert.equal(JSON.parse(saved).id, '456');
});

test('deleted messages are replaced; rate limits and missing webhooks do not create extras', async t => {
  const stateFile = await state(t);
  for (const [status, code, shouldCreate] of [[404, 10008, true], [404, 10015, false], [429, 0, false], [500, 0, false]]) {
    const calls = [];
    const fetcher = async (url, options) => {
      calls.push(options.method);
      return options.method === 'PATCH' ? response({ code }, status) : response({ id: '789' });
    };
    const promise = updateMessage({ webhook, payload: {}, fetcher, stateFile, messageId: '456' });
    if (shouldCreate) await promise; else await assert.rejects(promise);
    assert.equal(calls.includes('POST'), shouldCreate);
  }
});

test('corrupt state fails safely without sending another message', async t => {
  const stateFile = await state(t);
  await fs.writeFile(stateFile, 'bad json');
  await assert.rejects(updateMessage({ webhook, stateFile, fetcher: () => assert.fail('must not send') }), /Cannot read message state/);
});

test('fetches prices and icons, then updates the persisted board', async t => {
  const stateFile = await state(t);
  const craftingUrls = [];
  const fetcher = async (url, options) => {
    if (url.startsWith('https://api.ahledger.com/')) assert.equal(options.headers.Authorization, 'Bearer ahlk_test_only');
    else assert.equal(options.headers.Authorization, undefined);
    const common = { market: 'forever.pvp.horde.eu', marketStatus: 'scanned', pricesAsOf: now };
    if (url.includes('/pricetable/')) return response(`AHL1|forever/pvp/horde/eu|${Date.parse(now) / 1000}|1\n1:100000:50000:3:100000:100000:90000:110000:500`);
    if (url.includes('/crafting/')) {
      craftingUrls.push(url);
      return response({ ...common, recipes: [craft, { ...craft, recipe: { ...craft.recipe, profession: 'Alchemy' }, result: { ...item, id: 999 } }] });
    }
    if (url.includes('/prices/')) return response({
      item, latest: { minBuyout: 50000, median: 120000, observedAt: now },
      series: Array.from({ length: 72 }, (_, hour) => ({ t: new Date(Date.parse(now) - hour * 3600000).toISOString(), min: 100000, median: 120000, quantity: 10 })),
    });
    if (url.includes('/tooltip/')) {
      assert.ok(!url.includes('999'));
      return response({ market: { slug: 'forever/pvp/horde/eu' }, items: [{ id: 1, icon: 'https://render.worldofwarcraft.com/icon.jpg' }] });
    }
    assert.match(options.method, /POST|PATCH/);
    return response({ id: '456' });
  };
  const payload = await run({ fetcher, webhook, stateFile, apiKey: 'ahlk_test_only', profession: 'Leatherworking' });
  assert.equal(payload.flags, 32768);
  assert.match(JSON.stringify(payload), /hourly samples/);
  assert.match(JSON.stringify(payload), /Craft & sell · Leatherworking/);
  assert.deepEqual(craftingUrls, ['https://api.ahledger.com/v1/crafting/forever.pvp.horde.eu?profession=Leatherworking']);
  assert.equal(JSON.parse(await fs.readFile(stateFile)).id, '456');
});

test('profession selection defaults to Leatherworking and accepts normalized names or All', () => {
  assert.deepEqual(craftingProfessions(), ['Leatherworking']);
  assert.deepEqual(craftingProfessions(' alchemy '), ['Alchemy']);
  assert.deepEqual(craftingProfessions(''), ['Leatherworking']);
  assert.equal(craftingProfessions('All').length, 11);
  assert.throws(() => craftingProfessions('Leatherworkng'), /Invalid CRAFTING_PROFESSION/);
});

test('custom profession and All fetch only their selected feeds and label the board', async t => {
  for (const profession of ['Alchemy', 'All']) {
    const stateFile = await state(t);
    const urls = [];
    const fetcher = async url => {
      if (url.includes('/pricetable/')) return response(`AHL1|forever/pvp/horde/eu|${Date.parse(now) / 1000}|1\n1:1000:1000:3:1000:1000:900:1100:500`);
      if (url.includes('/crafting/')) {
        urls.push(url);
        return response({ market: 'forever.pvp.horde.eu', marketStatus: 'scanned', pricesAsOf: now, recipes: [] });
      }
      return response({ id: '456' });
    };
    const payload = await run({ fetcher, webhook, stateFile, profession });
    assert.equal(urls.length, profession === 'All' ? 11 : 1);
    if (profession === 'Alchemy') assert.match(urls[0], /profession=Alchemy$/);
    assert.match(JSON.stringify(payload), new RegExp(`Craft & sell · ${profession === 'All' ? 'All professions' : profession}`));
  }
});

test('invalid professions fail before fetching or publishing', async t => {
  await assert.rejects(run({ webhook, stateFile: await state(t), profession: 'Wrong', fetcher: () => assert.fail('must not fetch') }), /Invalid CRAFTING_PROFESSION/);
});

test('stale scans never overwrite the last good board', async t => {
  const stateFile = await state(t);
  const oldScan = new Date(Date.parse(now) - 7 * 3600000).toISOString();
  const fetcher = async url => {
    if (url.includes('discord.com')) assert.fail('must not send stale data');
    if (url.includes('/pricetable/')) return response(`AHL1|forever/pvp/horde/eu|${Date.parse(oldScan) / 1000}|1\n1:100000:50000:3:100000:100000:90000:110000:500`);
    return response({ market: 'forever.pvp.horde.eu', marketStatus: 'scanned', pricesAsOf: oldScan, deals: [], recipes: [] });
  };
  await assert.rejects(run({ fetcher, webhook, stateFile }), /stale/);
});
