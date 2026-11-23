const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rateLimitedFetch } = require('../rate-limit');

test('concurrent API requests are held until the rolling budget is available', async () => {
  let clock = 0;
  const starts = [];
  const limited = rateLimitedFetch(async url => { starts.push(clock); return url; }, {
    limit: 2, windowMs: 1000, now: () => clock,
    wait: async ms => { clock += ms; },
  });
  await Promise.all(Array.from({ length: 9 }, (_, i) => limited(`request-${i}`)));
  assert.equal(starts.length, 9);
  for (const start of starts) assert.ok(starts.filter(t => t >= start && t < start + 1000).length <= 2);
  assert.ok(clock >= 4000);
});
