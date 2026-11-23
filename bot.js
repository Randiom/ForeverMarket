const { updateMessage } = require('./message');
const { parsePriceTable, limitedCraft, balancedPicks, currentCraft } = require('./market');
const { createApiClient } = require('./api-client');
const API = 'https://api.ahledger.com';
const MARKET = process.env.AHLEDGER_MARKET || 'forever.pvp.horde.eu';
const INTERVAL_MS = 60 * 1000;
const PROFESSIONS = ['Alchemy', 'Blacksmithing', 'Cooking', 'Enchanting', 'Engineering', 'First Aid', 'Herbalism', 'Leatherworking', 'Mining', 'Skinning', 'Tailoring'];

function craftingProfessions(value = 'Leatherworking') {
  const name = value.trim() || 'Leatherworking';
  if (name.toLowerCase() === 'all') return [...PROFESSIONS];
  const match = PROFESSIONS.find(profession => profession.toLowerCase() === name.toLowerCase());
  if (!match) throw new Error(`Invalid CRAFTING_PROFESSION. Choose ${PROFESSIONS.join(', ')} or All`);
  return [match];
}

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
    return n < 100 ? `${n}c` : `${Math.floor(n / 100)}s${n % 100 ? ` ${n % 100}c` : ''}`;
  }
  return `${(Math.floor(value / 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}g`;
}

function volume(value) {
  return value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: value >= 1000 ? 1 : 0 }).toLowerCase();
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
  const url = item.url.split('?')[0].replace(/[()]/g, c => c === '(' ? '%28' : '%29');
  const name = safe(item.name.slice(0, 65));
  const requirement = crafting ? `${safe(row.recipe.profession)} ${Number.isInteger(row.recipe.skillRequired) ? row.recipe.skillRequired : '(skill unknown)'}` : '';
  const yieldMin = crafting ? (row.result.qtyMin || 1) : 1;
  const details = crafting
    ? `Mats ${gold(cost)} → Sell ${yieldMin > 1 ? `${yieldMin}×` : ''}${gold(row.resultPrice || 0)}\nRequires ${requirement}`
    : `Buy ${gold(cost)} → Sell ${gold(row.referenceMedian)}`;
  const source = crafting ? ` · ${safe((row.recipe.acquisition || 'source unknown').slice(0, 30))}` : '';
  const text = { type: 10, content: `[${name}](${url.length < 220 ? url : 'https://ahledger.com'})\n**+${gold(profit)}** net / ${crafting ? 'craft' : 'unit'}\n${details}\n-# Market ~${volume(sales)}/day${source}` };
  const icon = icons[item.id];
  if (!icon || !/^https:\/\/(render\.worldofwarcraft\.com|wow\.zamimg\.com)\//.test(icon)) return text;
  return { type: 9, components: [text], accessory: { type: 11, media: { url: icon }, description: item.name.slice(0, 100) } };
}

function rankDeals(data, limit = 40) {
  const candidates = (data.deals || []).map(row => ({ ...row,
    // Resale estimates compare today's median with today's cheapest listing.
    referenceMedian: Math.floor((Number.isFinite(row.median) && row.median > 0 ? row.median : row.referenceMedian) * 0.98),
  })).filter(row => {
    const profit = Math.floor(row.referenceMedian * 0.95) - row.minBuyout;
    return row.item?.name && row.item?.url?.startsWith('https://ahledger.com/') &&
      Number.isFinite(profit) && profit >= 10 && profit / row.minBuyout >= 0.03 && profit / row.minBuyout <= 1 && row.salesPerDay >= 20 && row.quantity / row.salesPerDay <= 3 && row.quantity > 0;
  }).map(row => ({ ...row, profit: Math.floor(row.referenceMedian * 0.95) - row.minBuyout }))
    .sort((a, b) => b.salesPerDay - a.salesPerDay || a.minBuyout - b.minBuyout);
  return balancedPicks(candidates, limit);
}

function rankCrafts(data, limit = 40) {
  const candidates = (data.recipes || []).filter(row => row.recipe?.name &&
    row.result?.url?.startsWith('https://ahledger.com/') &&
    !limitedCraft(row) && row.unpriced?.length === 0 && row.margin >= 10 && row.cost > 0 &&
    row.margin / row.cost >= 0.03 && row.margin / row.cost <= 1 && row.resultSalesPerDay >= 20 && row.resultClearDays <= 3);
  return balancedPicks(candidates, limit, true);
}

async function getJson(path, fetcher, options = {}) {
  const response = await fetcher(`${API}${path}`, { ...options, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`AHledger returned HTTP ${response.status} for ${path}`);
  return response.json();
}

async function getPriceTable(market, fetcher) {
  const response = await fetcher(`${API}/v1/pricetable/${market}`);
  if (!response.ok) throw new Error(`AHledger price table returned HTTP ${response.status}`);
  return parsePriceTable(await response.text(), market);
}

function makePayload(deals, crafts, asOf, market, icons = {}, watch = [], profession = 'Leatherworking') {
  const timestamp = new Date(asOf);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('AHledger returned no valid scan time');
  if (Date.now() - timestamp.getTime() > 6 * 60 * 60 * 1000) throw new Error(`AHledger scan is stale: ${asOf}`);
  const section = (title, rows, crafting, color) => ({
    type: 17, accent_color: color,
    components: [
      { type: 10, content: `### ${title}` },
      ...rows.flatMap((row, i) => [
        ...(i ? [{ type: 14, divider: true, spacing: 1 }] : []),
        itemBlock(row, icons, crafting),
      ]),
      ...(!rows.length ? [{ type: 10, content: 'No qualifying spreads right now. Check the [current market](https://ahledger.com).' }] : []),
    ],
  });
  const dealRows = deals.slice(0, 3), craftRows = crafts.slice(0, 3);
  const render = () => ({
    flags: 32768,
    allowed_mentions: { parse: [] },
    components: [
      { type: 10, content: `## ForeverMarket\n${marketLabel(market)}\n-# Scan <t:${Math.floor(timestamp.getTime() / 1000)}:R> · Updated <t:${Math.floor(Date.now() / 1000)}:t>` },
      section('Buy & resell', dealRows, false, 0x53ad91),
      section(`Craft & sell\n-# ${profession}`, craftRows, true, 0x8e9be0),
      ...(watch.length ? [{ type: 17, accent_color: 0x8394a5, components: [
        { type: 10, content: '### Market watch\n-# Prices only · not buy recommendations' },
        ...watch.slice(0, 2).map(item => ({ type: 10, content: `**${safe(item.name.slice(0, 65))}**\nMin ${gold(item.minBuyout)} · median ${gold(item.median)}\n-# Market ~${volume(item.salesPerDay)}/day` })),
      ] }] : []),
      { type: 10, content: `-# Current prices only · Refresh every minute.\n-# Net estimates include 5% AH cut, 2% slippage and 2% material buffer. Excludes deposits and recipe/tool costs. Verify live listings and recipe restrictions.\n[Prices from AHledger](https://ahledger.com) · [All deals](https://ahledger.com/deals?market=${market.replaceAll('.', '/')}) · [View recipes](https://ahledger.com/crafting?market=${market.replaceAll('.', '/')}${profession === 'All professions' ? '' : `&profession=${encodeURIComponent(profession)}`})` },
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

async function run({ fetcher = fetch, webhook = process.env.DISCORD_WEBHOOK_URL, market = MARKET, stateFile, messageId, apiKey = process.env.AHLEDGER_API_KEY || '', apiClient, profession = process.env.CRAFTING_PROFESSION || 'Leatherworking', signal = AbortSignal.timeout(45000) } = {}) {
  if (!/^forever\.(normal|pvp|rp|rppvp)\.(alliance|horde)\.(us|eu|cn|kr)$/.test(market)) throw new Error('Invalid AHLEDGER_MARKET');
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook || '')) throw new Error('Set DISCORD_WEBHOOK_URL to a Discord webhook URL');
  apiKey = apiKey.trim();
  if (apiKey && !/^ahlk_[\w-]+$/.test(apiKey)) throw new Error('AHLEDGER_API_KEY has an invalid format');
  const client = apiClient || createApiClient(fetcher, { apiKey });
  const apiFetch = (url, options = {}) => client(url, { ...options, signal });
  const selectedProfessions = craftingProfessions(profession);
  console.log(`Fetching market table and ${selectedProfessions.join(', ')} recipes`);
  // The unfiltered crafting response stops at 500 rows; each profession fits below that cap.
  const [deals, ...craftFeeds] = await Promise.all([
    getPriceTable(market, apiFetch),
    ...selectedProfessions.map(profession => getJson(`/v1/crafting/${market}?profession=${encodeURIComponent(profession)}`, apiFetch)),
  ]);
  if (deals.market !== market || deals.marketStatus !== 'scanned' || craftFeeds.some(feed => feed.market !== market || feed.marketStatus !== 'scanned')) throw new Error('AHledger has no scan for the selected market');
  const asOf = craftFeeds[0]?.pricesAsOf;
  // The table header is its generation time, not the scan timestamp carried by recipe feeds.
  if (!asOf || craftFeeds.some(feed => feed.pricesAsOf !== asOf) || Math.abs(Date.parse(deals.tableGeneratedAt) - Date.parse(asOf)) > 7200000) throw new Error('AHledger table and recipe feeds are out of sync; retry next run');
  // One market-wide snapshot prices both outputs and materials; no hourly history calls.
  const quotes = Object.fromEntries(deals.deals.map(row => [row.item.id, {
    id: row.item.id, median: row.median, minBuyout: row.minBuyout,
    quantity: row.quantity, salesPerDay: row.salesPerDay, observedAt: asOf,
  }]));
  const rankedDeals = rankDeals(deals, 3);
  const recipeRows = craftFeeds.flatMap(feed => feed.recipes || []).filter(row => selectedProfessions.includes(row.recipe?.profession));
  const pricedCrafts = recipeRows.map(row => currentCraft(row, quotes, asOf)).filter(Boolean);
  const rankedCrafts = rankCrafts({ recipes: pricedCrafts }, 3);
  const pickedIds = new Set([...rankedDeals.map(row => row.item.id), ...rankedCrafts.map(row => row.result.id)]);
  const watch = balancedPicks(deals.deals.filter(row => !pickedIds.has(row.item.id) && row.salesPerDay >= 100 && row.minBuyout <= 50000), 2)
    .map(row => ({ ...quotes[row.item.id], name: row.item.name }));
  const displayIds = [...new Set([...pickedIds, ...watch.map(row => row.id)])];
  const icons = {};
  // Only enrich displayed items. Failure must not discard independently priced crafts.
  if (displayIds.length && !signal.aborted) {
    try {
      console.log(`Fetching names and pictures for ${displayIds.length} displayed items`);
      const tooltip = await getJson(`/v1/tooltip/${market}?items=${displayIds.join(',')}`, apiFetch, { timeoutMs: 10000, attempts: 1 });
      if (tooltip.market?.slug !== market.replaceAll('.', '/')) throw new Error('Quote market mismatch');
      for (const item of tooltip.items || []) {
        if (!pickedIds.has(item.id) && !watch.some(row => row.id === item.id)) continue;
        icons[item.id] = item.icon;
        if (item.name) {
          for (const row of rankedDeals) if (row.item.id === item.id) row.item.name = item.name;
          for (const row of watch) if (row.id === item.id) row.name = item.name;
        }
      }
    } catch { console.warn('Item names/pictures unavailable; using current-price table results without enrichment'); }
  }
  console.log('Current-price screening:', JSON.stringify({ auctionItems: deals.deals.length, recipes: recipeRows.length, pricedCrafts: pricedCrafts.length, auctionPicks: rankedDeals.length, craftingPicks: rankedCrafts.length }));
  const payload = makePayload(rankedDeals, rankedCrafts, asOf, market, icons, watch, selectedProfessions.length === 1 ? selectedProfessions[0] : 'All professions');
  console.log('Updating Discord market board');
  await updateMessage({ webhook, payload, fetcher, stateFile, messageId });
  return payload;
}

if (require.main === module) {
  if (process.argv.includes('--once')) run().then(() => console.log('Updated market board')).catch(error => { console.error(error.message); process.exitCode = 1; });
  else {
    let busy = false;
    let apiClient;
    const tick = async () => {
      if (busy) { console.log('Previous refresh still running; skipping overlapping minute tick'); return; }
      busy = true;
      try {
        apiClient ||= createApiClient(fetch, { apiKey: process.env.AHLEDGER_API_KEY || '' });
        await run({ apiClient });
        console.log('Updated market board');
      }
      catch (error) { console.error(error.message); }
      finally { busy = false; }
    };
    tick();
    setInterval(tick, INTERVAL_MS);
  }
}

module.exports = { copper, rankDeals, rankCrafts, makePayload, run, craftingProfessions };
