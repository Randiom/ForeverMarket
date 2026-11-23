const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessHistory, qualifyDeal, qualifyCraft, screenCandidates } = require('../history');
const end = Date.parse('2026-11-23T12:30:00Z');
const asOf = new Date(end).toISOString();
function history(price = () => 100000) {
  return {
    item: { id: 1 }, latest: { observedAt: asOf, minBuyout: 60000, median: 110000 },
    series: Array.from({ length: 168 }, (_, hour) => ({ t: new Date(end - hour * 3600000).toISOString(), min: price(hour), median: price(hour) * 1.1, quantity: 10 })),
  };
}
const deal = { item: { id: 1 }, minBuyout: 60000, referenceMedian: 300000, salesPerDay: 10, quantity: 10 };

test('distributed three-hour scans pass with only two days of history', () => {
  const data = history();
  data.series = data.series.filter((_, hour) => hour < 48 && hour % 3 === 0);
  const assessment = assessHistory(data, asOf, 1);
  assert.equal(assessment.ok, true);
  assert.equal(assessment.samples, 16);
  assert.equal(assessment.historyHours, 48);
  assert.equal(assessment.target, 100000);
});

test('a missing third day does not suppress an otherwise stable market', () => {
  const data = history();
  data.series = data.series.filter((_, hour) => hour < 48 || hour > 65);
  const assessment = assessHistory(data, asOf, 1);
  assert.equal(assessment.ok, true);
  assert.equal(assessment.historyHours, 48);
});

test('samples clustered in one half of a day still fail coverage', () => {
  const data = history();
  data.series = data.series.filter((_, hour) => hour % 24 < 10);
  assert.equal(assessHistory(data, asOf, 1).reason, 'insufficient recent history');
});

test('gapped history still rejects declines and spikes', () => {
  for (const prices of [hour => 100000 + hour * 4000, hour => hour % 6 ? 100000 : 200000]) {
    const data = history(prices);
    data.series = data.series.filter((_, hour) => hour < 48 && hour % 3 === 0);
    assert.equal(assessHistory(data, asOf, 1).ok, false);
  }
});

test('old weekly spikes cannot inflate a stable recent resale target', () => {
  const result = assessHistory(history(hour => hour >= 72 ? 1000000 : 100000), asOf, 1);
  assert.equal(result.ok, true);
  assert.equal(result.target, 100000);
  const selected = qualifyDeal(deal, result);
  assert.equal(selected.ok, true);
  assert.equal(selected.row.referenceMedian, 100000);
  assert.equal(selected.row.profit, 35000);
});

test('a declining market is rejected despite a huge weekly discount', () => {
  const result = assessHistory(history(hour => 100000 + hour * 4000), asOf, 1);
  assert.equal(result.reason, 'falling price');
});

test('a six-hour slide fails even when the daily average looks stable', () => {
  const result = assessHistory(history(hour => hour < 6 ? 85000 : 100000), asOf, 1);
  assert.equal(result.reason, 'falling price');
});

test('alternating spikes and troughs fail volatility checks', () => {
  const result = assessHistory(history(hour => hour % 2 ? 200000 : 100000), asOf, 1);
  assert.equal(result.reason, 'volatile price');
});

test('sparse, duplicate, stale or mismatched histories cannot pass', () => {
  const data = history();
  for (const bad of [
    { ...data, series: data.series.slice(0, 10) },
    { ...data, series: Array(100).fill(data.series[0]) },
    { ...data, latest: { ...data.latest, observedAt: new Date(end - 3 * 3600000).toISOString() } },
    { ...data, item: { id: 2 } },
    { ...data, series: data.series.map(row => ({ ...row, min: null })) },
  ]) assert.equal(assessHistory(bad, asOf, 1).ok, false);
});

test('margins are rechecked against recent floors and slow markets are excluded', () => {
  const assessment = assessHistory(history(), asOf, 1);
  assert.equal(qualifyDeal({ ...deal, minBuyout: 90000 }, assessment).reason, 'insufficient recent margin');
  assert.equal(qualifyDeal({ ...deal, salesPerDay: 1 }, assessment).reason, 'slow turnover');
  assert.equal(qualifyDeal({ ...deal, quantity: 100 }, assessment).reason, 'slow turnover');
});

test('craft profit uses current competition, guaranteed yield and recent floors', () => {
  const data = history();
  data.latest.minBuyout = 90000;
  const assessment = assessHistory(data, asOf, 1);
  const craft = { result: { id: 1, qtyMin: 2, qtyMax: 5 }, resultPrice: 500000, cost: 100000, resultSalesPerDay: 10, resultListed: 10 };
  const result = qualifyCraft(craft, assessment);
  assert.equal(result.row.margin, 71000);
  assert.equal(result.row.resultPrice, 90000);
  assert.equal(qualifyCraft({ ...craft, cost: 200000 }, assessment).reason, 'insufficient recent margin');
});

test('history fetch failures exclude candidates and never fall back to weekly targets', async () => {
  const result = await screenCandidates([deal], [], async () => { throw new Error('outage'); }, asOf);
  assert.equal(result.deals.length, 0);
  assert.equal(result.rejected['history unavailable'], 1);
});
