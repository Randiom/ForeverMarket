const HOUR = 3600000;
const positive = value => Number.isFinite(value) && value > 0;
const { balancedPicks } = require('./market');

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function assessHistory(data, asOf, itemId) {
  const end = Date.parse(asOf);
  const latest = data?.latest;
  const observed = Date.parse(latest?.observedAt);
  const reject = reason => ({ ok: false, reason, item: data?.item });
  if (!Number.isFinite(end) || data?.item?.id !== itemId || !positive(latest?.minBuyout) || !positive(latest?.median) ||
    !Number.isFinite(observed) || Math.abs(end - observed) > 2 * HOUR) return reject('missing or stale item price');

  // Count at most one observation per hour; duplicate samples cannot create confidence.
  const buckets = new Map();
  for (const row of data.series || []) {
    const t = Date.parse(row.t);
    if (!Number.isFinite(t) || t > end || end - t >= 72 * HOUR || !positive(row.min) || !positive(row.median) || !positive(row.quantity)) continue;
    const hour = Math.floor(t / HOUR);
    const existing = buckets.get(hour);
    if (!existing || row.min < existing.min) buckets.set(hour, { ...row, age: (end - t) / HOUR });
  }
  const points = [...buckets.values()];
  const window = (from, to) => points.filter(row => row.age >= from && row.age < to);
  const recent = window(0, 24), previous = window(24, 48), older = window(48, 72);
  const last6 = window(0, 6), previous6 = window(6, 12);
  // Player scans are irregular: require distributed coverage, not near-hourly uploads.
  const coveredDay = rows => rows.length >= 6 &&
    rows.filter(row => row.age % 24 < 12).length >= 2 &&
    rows.filter(row => row.age % 24 >= 12).length >= 2 &&
    Math.max(...rows.map(row => row.age)) - Math.min(...rows.map(row => row.age)) >= 12;
  if (!coveredDay(recent) || !coveredDay(previous) || last6.length < 2 || previous6.length < 2 || !points.some(row => row.age <= 2)) return reject('insufficient recent history');
  const hasThirdDay = coveredDay(older);
  const evaluated = hasThirdDay ? points : window(0, 48);
  const median = rows => quantile(rows.map(row => row.min), 0.5);
  const dailyChange = median(recent) / median(previous) - 1;
  if (dailyChange < -0.10 || (hasThirdDay && median(recent) / median(older) < 0.85) || median(last6) / median(previous6) < 0.95 || median(last6) / median(recent) < 0.90) return reject('falling price');
  const floorRange = quantile(evaluated.map(row => row.min), 0.9) / quantile(evaluated.map(row => row.min), 0.1);
  const medianRange = quantile(evaluated.map(row => row.median), 0.9) / quantile(evaluated.map(row => row.median), 0.1);
  if (floorRange > 1.5 || medianRange > 1.5) return reject('volatile price');
  // Use a lower quartile of actual listing floors, never a weekly rebound assumption.
  const target = Math.floor(Math.min(
    quantile(recent.map(row => row.min), 0.25),
    quantile(evaluated.map(row => row.min), 0.25),
    latest.median,
  ));
  return { ok: true, target, dailyChange, samples: evaluated.length, historyHours: hasThirdDay ? 72 : 48, latest, item: data.item };
}

function qualifyDeal(row, assessment) {
  if (!assessment.ok) return assessment;
  const buy = Math.max(row.minBuyout, assessment.latest.minBuyout);
  const target = Math.floor(Math.min(assessment.target, row.referenceMedian) * 0.98);
  const profit = Math.floor(target * 0.95) - buy;
  if (!positive(buy) || !positive(target) || profit < 10 || profit / buy < 0.03) return { ok: false, reason: 'insufficient recent margin' };
  if (profit / buy > 1) return { ok: false, reason: 'unusually large margin; verify listings' };
  if (!(row.salesPerDay >= 20) || !positive(row.quantity) || row.quantity / row.salesPerDay > 3) return { ok: false, reason: 'slow turnover' };
  const item = assessment.item?.url?.startsWith('https://ahledger.com/') && assessment.item.name ? assessment.item : row.item;
  return { ok: true, row: { ...row, item, minBuyout: buy, referenceMedian: target, profit, evidence: assessment } };
}

function qualifyCraft(row, assessment) {
  if (!assessment.ok) return assessment;
  const target = Math.floor(Math.min(assessment.target, assessment.latest.minBuyout, row.resultPrice) * 0.98);
  const yieldMin = row.result.qtyMin;
  const margin = Math.floor(target * yieldMin * 0.95) - row.cost;
  if (!positive(yieldMin) || !positive(row.cost) || !positive(target) || !Number.isFinite(margin) || margin < 10 || margin / row.cost < 0.03) return { ok: false, reason: 'insufficient recent margin' };
  if (margin / row.cost > 1) return { ok: false, reason: 'unusually large margin; verify recipe' };
  if (!(row.resultSalesPerDay >= 20) || !Number.isFinite(row.resultListed) || row.resultListed < 0 || row.resultListed / row.resultSalesPerDay > 3) return { ok: false, reason: 'slow turnover' };
  return { ok: true, row: { ...row, margin, resultPrice: target, profitPerDay: margin / yieldMin * row.resultSalesPerDay, evidence: assessment } };
}

async function screenCandidates(deals, crafts, loadHistory, asOf) {
  // Each output history is loaded once; the caller paces requests to the API limit.
  const ids = [...new Set([...deals.map(row => row.item.id), ...crafts.map(row => row.result.id)])];
  const histories = new Map();
  for (let offset = 0; offset < ids.length; offset += 4) {
    await Promise.all(ids.slice(offset, offset + 4).map(async id => {
      try { histories.set(id, assessHistory(await loadHistory(id), asOf, id)); }
      catch { histories.set(id, { ok: false, reason: 'history unavailable' }); }
    }));
  }
  const rejected = {};
  const rejections = [];
  const apply = (rows, qualify, getId) => rows.flatMap(row => {
    const result = qualify(row, histories.get(getId(row)));
    if (result.ok) return [result.row];
    rejected[result.reason] = (rejected[result.reason] || 0) + 1;
    rejections.push({ id: getId(row), name: histories.get(getId(row))?.item?.name || (row.result || row.item).name, reason: result.reason });
    return [];
  });
  const acceptedDeals = apply(deals, qualifyDeal, row => row.item.id);
  const acceptedCrafts = apply(crafts, qualifyCraft, row => row.result.id);
  const result = {
    deals: balancedPicks(acceptedDeals, 3),
    crafts: balancedPicks(acceptedCrafts, 3, true),
    passed: { deals: acceptedDeals.length, crafts: acceptedCrafts.length },
    rejected,
    rejections,
  };
  return result;
}

module.exports = { assessHistory, qualifyDeal, qualifyCraft, screenCandidates };
