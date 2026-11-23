const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { rankDeals, rankCrafts, makePayload, run } = require('../bot');
const { updateMessage } = require('../message');

const webhook = 'https://discord.com/api/webhooks/123/token';
const item = { id: 1, name: 'Test @everyone', url: 'https://ahledger.com/items/1-test' };
const now = new Date().toISOString();
const deal = { item, minBuyout: 50000, referenceMedian: 100000, discount: .5, quantity: 3, salesPerDay: 2 };
const craft = { recipe: { name: 'Test craft', profession: 'Alchemy' }, result: item, cost: 50000, margin: 20000, profitPerDay: 40000, resultSalesPerDay: 2, resultClearDays: 2, unpriced: [] };
const response = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
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
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('empty boards and unavailable icons remain readable', () => {
  const empty = makePayload([], [], now, 'forever.pvp.horde.eu');
  assert.match(JSON.stringify(empty), /No opportunities meet/);
  const noIcons = makePayload([{ ...deal, profit: 45000 }], [], now, 'forever.pvp.horde.eu', { 1: 'https://untrusted.example/icon.jpg' });
  assert.equal(noIcons.components.flatMap(components).filter(c => c.type === 11).length, 0);
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
  const fetcher = async (url, options) => {
    const common = { market: 'forever.pvp.horde.eu', marketStatus: 'scanned', pricesAsOf: now };
    if (url.includes('/deals/')) return response({ ...common, deals: [deal] });
    if (url.includes('/crafting/')) return response({ ...common, recipes: url.includes('profession=Alchemy') ? [craft] : [] });
    if (url.includes('/tooltip/')) return response({ items: [{ id: 1, icon: 'https://render.worldofwarcraft.com/icon.jpg' }] });
    assert.match(options.method, /POST|PATCH/);
    return response({ id: '456' });
  };
  const payload = await run({ fetcher, webhook, stateFile });
  assert.equal(payload.flags, 32768);
  assert.equal(JSON.parse(await fs.readFile(stateFile)).id, '456');
});

test('stale scans never overwrite the last good board', async t => {
  const stateFile = await state(t);
  const fetcher = async url => {
    if (url.includes('discord.com')) assert.fail('must not send stale data');
    return response({ market: 'forever.pvp.horde.eu', marketStatus: 'scanned', pricesAsOf: new Date(Date.now() - 7 * 3600000).toISOString(), deals: [], recipes: [] });
  };
  await assert.rejects(run({ fetcher, webhook, stateFile }), /stale/);
});
