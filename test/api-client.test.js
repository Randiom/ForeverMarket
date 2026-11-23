const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApiClient } = require('../api-client');
const base = 'https://api.ahledger.com/v1/test';

test('cached responses are reused only for their remaining max-age', async () => {
  let clock = 0, calls = 0;
  const client = createApiClient(async () => {
    calls++;
    return new Response(JSON.stringify({ value: calls }), { headers: { 'Cache-Control': 'public, max-age=60', Age: '50' } });
  }, { now: () => clock });
  const first = await (await client(base)).json();
  first.value = 99;
  clock = 9000;
  assert.equal((await (await client(base)).json()).value, 1);
  assert.equal(calls, 1);
  clock = 10000;
  assert.equal((await (await client(base)).json()).value, 2);
});

test('no-store and failed responses are never cached', async () => {
  for (const [status, control] of [[200, 'no-store, max-age=300'], [503, 'max-age=300']]) {
    let calls = 0, clock = 0;
    const client = createApiClient(async () => { calls++; return new Response('{}', { status, headers: { 'Cache-Control': control, 'Retry-After': '1' } }); }, { now: () => clock, wait: async ms => { clock += ms; } });
    await client(base); await client(base);
    assert.equal(calls, 2);
  }
});

test('the authenticated 299 request budget persists across refreshes', async () => {
  let clock = 0;
  const starts = [];
  const client = createApiClient(async () => { starts.push(clock); return new Response('{}'); }, {
    apiKey: 'ahlk_test_only', now: () => clock, wait: async ms => { clock += ms; },
  });
  await Promise.all(Array.from({ length: 200 }, (_, i) => client(`${base}/${i}`)));
  clock = 30000;
  await Promise.all(Array.from({ length: 200 }, (_, i) => client(`${base}/${i + 200}`)));
  assert.equal(starts.length, 400);
  for (const start of starts) assert.ok(starts.filter(t => t >= start && t < start + 60000).length <= 299);
  assert.ok(clock >= 60000);
});

test('Retry-After pauses subsequent requests and credentials cannot leave AHledger', async () => {
  let clock = 0, calls = 0;
  const client = createApiClient(async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer ahlk_test_only');
    assert.ok(!options.signal.aborted);
    return new Response('{}', { status: calls === 1 ? 429 : 200, headers: { 'Retry-After': '5' } });
  }, { apiKey: 'ahlk_test_only', now: () => clock, wait: async ms => { clock += ms; } });
  await client(base); await client(base);
  assert.equal(clock, 5000);
  await assert.rejects(client('https://discord.com/api/webhooks/test'), /Invalid AHledger API destination/);
  assert.equal(calls, 2);
});
