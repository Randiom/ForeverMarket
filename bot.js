const { updateMessage } = require('./message');
const { screenCandidates } = require('./history');
const { parsePriceTable, limitedCraft, balancedPicks, priceMaterials } = require('./market');
const { rateLimitedFetch } = require('./rate-limit');
const API = 'https://api.ahledger.com';
const MARKET = process.env.AHLEDGER_MARKET || 'forever.pvp.horde.eu';
const INTERVAL_MS = 15 * 60 * 1000;
const PROFESSIONS = ['Alchemy', 'Blacksmithing', 'Cooking', 'Enchanting', 'Engineering', 'First Aid', 'Herbalism', 'Leatherworking', 'Mining', 'Skinning', 'Tailoring'];

function copper(value) {
  const n = Math.round(value);
  const gold = Math.floor(n / 10000);
  const silver = Math.floor((n % 10000) / 100);
  const coins = n % 100;
  return `${gold}g ${silver}s ${coins}c`;
}

function safe(text) {
  return String(text).replace(/([\\`*_~|>\[\]])/g, '\\$1').replace(/@/g, '@\u200b');
}

// Floor display values so rounding never overstates profit; calculations keep full copper precision.
function gold(value) {
  if (value < 10000) {
    const n = Math.floor(value);
    return n < 100 ? `${n}c` : `${Math.floor(n / 100)}s ${n % 100}c`;
  }
  return `${(Math.floor(value / 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}g`;
}

function marketLabel(market) {
  const [, ruleset, faction, region] = market.split('.');
  return `${region.toUpperCase()} · ${{ normal: 'Normal', pvp: 'PvP', rp: 'RP', rppvp: 'RP PvP' }[ruleset]} · ${faction === 'horde' ? 'Horde' : 'Alliance'}`;
}

function itemBlock(row, icons, crafting = false) {
  const item = crafting ? row.result : row.item;
  const profit = crafting ? row.margin : row.profit;
  const cost = crafting ? row.cost : row.minBuyout;
  const sales = crafting ? row.resultSalesPerDay : row.salesPerDay;
  const label = sales >= 100 ? 'High volume' : cost <= 50000 ? 'Low entry cost' : 'Steady margin';
  const url = item.url.split('?')[0].replace(/[()]/g, c => c === '(' ? '%28' : '%29');
  const name = safe(item.name.slice(0, 65));
  const requirement = crafting ? `${safe(row.recipe.profession)} ${Number.isInteger(row.recipe.skillRequired) ? row.recipe.skillRequired : '(skill unknown)'}` : '';
  const yieldMin = crafting ? (row.result.qtyMin || 1) : 1;
  const details = crafting ? `Inputs ${gold(cost)} → ${yieldMin} × ${gold(row.resultPrice || 0)} target\nRequires ${requirement} · Source: ${safe((row.recipe.acquisition || 'unknown').slice(0, 30))}` : `Buy ${gold(cost)} → target ${gold(row.referenceMedian)}`;
  const count = Math.max(1, Math.floor(Math.min(10, sales * 0.05 / yieldMin, 100000 / cost,
    ...(crafting ? (row.reagents || []).map(reagent => Number.isFinite(reagent.available) ? reagent.available / reagent.qty : 1) : [row.quantity]))));
  const example = `Example ${count} ${crafting ? 'crafts' : 'units'}: ${gold(cost * count)} cost · ~${gold(profit * count)} net`;
  const evidence = row.evidence ? `\n-# 24h floor ${row.evidence.dailyChange >= 0 ? '+' : ''}${Math.round(row.evidence.dailyChange * 100)}% vs prior day · ${row.evidence.samples} hourly samples/${(row.evidence.historyHours || 72) / 24}d` : '';
  const text = { type: 10, content: `[${name}](${url.length < 220 ? url : 'https://ahledger.com'})\n**~+${gold(profit)}/${crafting ? 'craft' : 'unit'}** · ${label}\n${details}\n${example}\nMarket ~${sales.toLocaleString('en-US', { maximumFractionDigits: 1 })} units/day${evidence}` };
  const icon = icons[item.id];
  if (!icon || !/^https:\/\/(render\.worldofwarcraft\.com|wow\.zamimg\.com)\//.test(icon)) return text;
  return { type: 9, components: [text], accessory: { type: 11, media: { url: icon }, description: item.name.slice(0, 100) } };
}

function rankDeals(data) {
  const candidates = (data.deals || []).map(row => ({ ...row,
    // An old peak must not dominate the limited history-check budget either.
    referenceMedian: Number.isFinite(row.median) && row.median > 0 ? Math.min(row.referenceMedian, row.median) : row.referenceMedian,
  })).filter(row => {
    const profit = Math.floor(row.referenceMedian * 0.98 * 0.95) - row.minBuyout;
    return row.item?.name && row.item?.url?.startsWith('https://ahledger.com/') &&
      Number.isFinite(profit) && profit >= 10 && profit / row.minBuyout >= 0.03 && profit / row.minBuyout <= 1 && row.salesPerDay >= 20 && row.quantity / row.salesPerDay <= 3 && row.quantity > 0;
  }).map(row => ({ ...row, profit: Math.floor(row.referenceMedian * 0.98 * 0.95) - row.minBuyout }))
    .sort((a, b) => b.salesPerDay - a.salesPerDay || a.minBuyout - b.minBuyout);
  return balancedPicks(candidates, 40);
}

function rankCrafts(data) {
  const candidates = (data.recipes || []).filter(row => row.recipe?.name &&
    row.result?.url?.startsWith('https://ahledger.com/') &&
    !limitedCraft(row) && row.unpriced?.length === 0 && row.margin >= 10 && row.cost > 0 &&
    row.margin / row.cost >= 0.03 && row.margin / row.cost <= 1 && row.resultSalesPerDay >= 20 && row.resultClearDays <= 3);
  return balancedPicks(candidates, 40, true);
}

async function getJson(path, fetcher = fetch) {
  const response = await fetcher(`${API}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`AHledger returned HTTP ${response.status} for ${path}`);
  return response.json();
}

async function getPriceTable(market, fetcher) {
  const response = await fetcher(`${API}/v1/pricetable/${market}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`AHledger price table returned HTTP ${response.status}`);
  return parsePriceTable(await response.text(), market);
}

function makePayload(deals, crafts, asOf, market, icons = {}, watch = []) {
  const timestamp = new Date(asOf);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('AHledger returned no valid scan time');
  if (Date.now() - timestamp.getTime() > 6 * 60 * 60 * 1000) throw new Error(`AHledger scan is stale: ${asOf}`);
  const section = (title, rows, crafting, color) => ({
    type: 17, accent_color: color,
    components: [
      { type: 10, content: `### ${title} · ${rows.length} practical picks` },
      ...rows.flatMap((row, i) => [
        ...(i ? [{ type: 14, divider: true, spacing: 1 }] : []),
        itemBlock(row, icons, crafting),
      ]),
      ...(!rows.length ? [{ type: 10, content: 'No opportunities pass recent-history, stability, profit and turnover checks.' }] : []),
    ],
  });
  const dealRows = deals.slice(0, 3), craftRows = crafts.slice(0, 3);
  const render = () => ({
    flags: 32768,
    allowed_mentions: { parse: [] },
    components: [
      { type: 10, content: `## ForeverMarket\n${marketLabel(market)} · Scan <t:${Math.floor(timestamp.getTime() / 1000)}:R>\n-# Updated <t:${Math.floor(Date.now() / 1000)}:t> · Refreshes every 15 min` },
      section('Buy & resell', dealRows, false, 0x53ad91),
      section('Craft & sell', craftRows, true, 0x8e9be0),
      ...(watch.length ? [{ type: 17, accent_color: 0x8394a5, components: [
        { type: 10, content: '### Liquid market watch\n-# Current quotes only · not validated buy recommendations' },
        ...watch.slice(0, 2).map(item => ({ type: 10, content: `**${safe(item.name.slice(0, 65))}**\nMin ${gold(item.minBuyout)} · median ${gold(item.median)} · market ~${Math.floor(item.salesPerDay).toLocaleString('en-US')} units/day` })),
      ] }] : []),
      { type: 10, content: `-# Costs include a 2% material buffer; targets allow 2% slippage and 5% AH cut. Examples exclude deposits, recipe/tool costs and do not promise sales. Known cooldown crafts are excluded. Verify recipe restrictions in game.\n[Prices from AHledger](https://ahledger.com) · [All deals](https://ahledger.com/deals?market=${market.replaceAll('.', '/')}) · [All crafts](https://ahledger.com/crafting?market=${market.replaceAll('.', '/')})` },
    ],
  });
  const textSize = node => (node.content?.length || 0) + (node.components || []).reduce((n, child) => n + textSize(child), 0);
  let payload = render();
  while (textSize(payload) > 3900 && dealRows.length + craftRows.length) {
    (dealRows.length > craftRows.length ? dealRows : craftRows).pop();
    payload = render();
  }
  return payload;
}

async function run({ fetcher = fetch, webhook = process.env.DISCORD_WEBHOOK_URL, market = MARKET, stateFile, messageId } = {}) {
  if (!/^forever\.(normal|pvp|rp|rppvp)\.(alliance|horde)\.(us|eu|cn|kr)$/.test(market)) throw new Error('Invalid AHLEDGER_MARKET');
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook || '')) throw new Error('Set DISCORD_WEBHOOK_URL to a Discord webhook URL');
  const apiFetch = rateLimitedFetch(fetcher);
  // The unfiltered crafting response stops at 500 rows; each profession fits below that cap.
  const [deals, ...craftFeeds] = await Promise.all([
    getPriceTable(market, apiFetch),
    ...PROFESSIONS.map(profession => getJson(`/v1/crafting/${market}?profession=${encodeURIComponent(profession)}`, apiFetch)),
  ]);
  if (deals.market !== market || deals.marketStatus !== 'scanned' || craftFeeds.some(feed => feed.market !== market || feed.marketStatus !== 'scanned')) throw new Error('AHledger has no scan for the selected market');
  const asOf = craftFeeds[0]?.pricesAsOf;
  // The table header is its generation time, not the scan timestamp carried by recipe feeds.
  if (!asOf || craftFeeds.some(feed => feed.pricesAsOf !== asOf) || Math.abs(Date.parse(deals.tableGeneratedAt) - Date.parse(asOf)) > 7200000) throw new Error('AHledger table and recipe feeds are out of sync; retry next run');
  const dealCandidates = rankDeals(deals);
  const craftCandidates = rankCrafts({ recipes: craftFeeds.flatMap(feed => feed.recipes || []) });
  const watchCandidates = balancedPicks(deals.deals.filter(row => row.salesPerDay >= 100 && row.minBuyout <= 50000), 4);
  const quoteIds = [...new Set([...dealCandidates.map(row => row.item.id), ...craftCandidates.flatMap(row => [row.result.id, ...(row.reagents || []).map(reagent => reagent.id)]), ...watchCandidates.map(row => row.item.id)])].filter(Number.isInteger);
  let quotes = {};
  for (let offset = 0; offset < quoteIds.length; offset += 100) {
    try {
      const tooltip = await getJson(`/v1/tooltip/${market}?items=${quoteIds.slice(offset, offset + 100).join(',')}`, apiFetch);
      if (tooltip.market?.slug !== market.replaceAll('.', '/')) throw new Error('Quote market mismatch');
      Object.assign(quotes, Object.fromEntries((tooltip.items || []).map(item => [item.id, item])));
    } catch { console.warn('A current quote batch is unavailable; skipping crafts that need those inputs'); }
  }
  const pricedCrafts = craftCandidates.map(row => priceMaterials(row, quotes, asOf)).filter(Boolean);
  const screened = await screenCandidates(
    dealCandidates,
    pricedCrafts,
    id => getJson(`/v1/prices/${market}/${id}?range=7d`, apiFetch), asOf,
  );
  console.log('History screening:', JSON.stringify({ auctionChecked: dealCandidates.length, craftingShortlisted: craftCandidates.length, craftingInputRejected: craftCandidates.length - pricedCrafts.length, craftingChecked: pricedCrafts.length, auctionPassed: screened.passed.deals, craftingPassed: screened.passed.crafts, rejected: screened.rejected }));
  console.log('Rejected candidates:', JSON.stringify(screened.rejections));
  const rankedDeals = screened.deals.slice(0, 3);
  const rankedCrafts = screened.crafts.slice(0, 3);
  const icons = Object.fromEntries(Object.entries(quotes).map(([id, item]) => [id, item.icon]));
  const pickedIds = new Set([...rankedDeals.map(row => row.item.id), ...rankedCrafts.map(row => row.result.id)]);
  const watch = watchCandidates.map(row => quotes[row.item.id]).filter(item => item?.name && !pickedIds.has(item.id) && item.minBuyout > 0 && item.median > 0 && item.salesPerDay >= 100 && Number.isFinite(Date.parse(item.observedAt)) && Math.abs(Date.parse(item.observedAt) - Date.parse(asOf)) <= 7200000).slice(0, 2);
  const payload = makePayload(rankedDeals, rankedCrafts, asOf, market, icons, watch);
  await updateMessage({ webhook, payload, fetcher, stateFile, messageId });
  return payload;
}

if (require.main === module) {
  if (process.argv.includes('--once')) run().then(() => console.log('Updated market board')).catch(error => { console.error(error.message); process.exitCode = 1; });
  else {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { await run(); console.log('Updated market board'); }
      catch (error) { console.error(error.message); }
      finally { busy = false; }
    };
    tick();
    setInterval(tick, INTERVAL_MS);
  }
}

module.exports = { copper, rankDeals, rankCrafts, makePayload, run };
