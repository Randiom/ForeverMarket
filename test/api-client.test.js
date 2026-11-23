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

test('a transient timeout retries the same read once with a new signal', async () => {
  let calls = 0, clock = 0;
  const signals = [];
  const client = createApiClient(async (url, options) => {
    calls++; signals.push(options.signal);
    if (calls === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response('{"ok":true}');
  }, { now: () => clock, wait: async ms => { clock += ms; } });
  assert.deepEqual(await (await client(`${base}?profession=Leatherworking`)).json(), { ok: true });
  assert.equal(calls, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(clock, 1000);
});

test('exhausted timeouts identify the endpoint without exposing credentials', async () => {
  let calls = 0;
  const client = createApiClient(async () => { calls++; throw new DOMException('sensitive upstream message', 'TimeoutError'); }, { apiKey: 'ahlk_test_only', wait: async () => {} });
  await assert.rejects(client(`${base}?profession=Leatherworking`), error => {
    assert.match(error.message, /\/v1\/test\?profession=Leatherworking: timed out after 30 seconds \(2 attempts\)/);
    assert.ok(!error.message.includes('ahlk_test_only'));
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });
  assert.equal(calls, 2);
});

test('a stalled response body is retried too, even without cache headers', async () => {
  let calls = 0;
  const client = createApiClient(async () => {
    calls++;
    if (calls === 1) return { ok: true, status: 200, text: async () => { throw new DOMException('timeout', 'TimeoutError'); } };
    return new Response('{"complete":true}');
  }, { wait: async () => {} });
  assert.equal((await (await client(base)).json()).complete, true);
  assert.equal(calls, 2);
});

test('an aborted refresh cannot start another API request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = createApiClient(async () => { calls++; return new Response('{}'); });
  await assert.rejects(client(base, { signal: controller.signal }), /refresh time budget/);
  assert.equal(calls, 0);
});

test('the history scheduler can identify fresh cache entries without reading expired data', async () => {
  let clock = 0;
  const client = createApiClient(async () => new Response('{}', { headers: { 'Cache-Control': 'max-age=1' } }), { now: () => clock });
  await client(base);
  assert.equal(client.hasFresh?.(base), true);
  clock = 1000;
  assert.equal(client.hasFresh?.(base), false);
});
