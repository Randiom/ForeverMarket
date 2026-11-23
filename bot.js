const { updateMessage } = require('./message');
const { screenCandidates } = require('./history');
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
  const roi = cost > 0 ? ` · ${Math.floor(profit / cost * 100)}% ROI` : '';
  const url = item.url.split('?')[0].replace(/[()]/g, c => c === '(' ? '%28' : '%29');
  const name = safe(item.name.slice(0, 65));
  const requirement = crafting ? `${safe(row.recipe.profession)} ${Number.isInteger(row.recipe.skillRequired) ? row.recipe.skillRequired : '(skill unknown)'}` : '';
  const details = crafting ? `Mats ${gold(cost)} · Requires ${requirement}` : `Buy ${gold(cost)} → target ${gold(row.referenceMedian)}`;
  const evidence = row.evidence ? `\n-# 24h floor ${row.evidence.dailyChange >= 0 ? '+' : ''}${Math.round(row.evidence.dailyChange * 100)}% vs prior day · ${row.evidence.samples} hourly samples/3d` : '';
  const text = { type: 10, content: `[${name}](${url.length < 220 ? url : 'https://ahledger.com'})\n**~+${gold(profit)}/${crafting ? 'craft' : 'unit'}**${roi}\n${details} · ~${sales.toLocaleString('en-US', { maximumFractionDigits: 1 })}/day sold${evidence}` };
  const icon = icons[item.id];
  if (!icon || !/^https:\/\/(render\.worldofwarcraft\.com|wow\.zamimg\.com)\//.test(icon)) return text;
  return { type: 9, components: [text], accessory: { type: 11, media: { url: icon }, description: item.name.slice(0, 100) } };
}

function rankDeals(data) {
  return (data.deals || []).filter(row => {
    const profit = Math.floor(row.referenceMedian * 0.95) - row.minBuyout;
    return row.item?.name && row.item?.url?.startsWith('https://ahledger.com/') &&
      Number.isFinite(profit) && profit >= 10000 && row.salesPerDay >= 1 &&
      row.discount >= 0.25 && row.basis !== 'scan' && row.quantity > 0;
  }).map(row => ({ ...row, profit: Math.floor(row.referenceMedian * 0.95) - row.minBuyout }))
    .sort((a, b) => b.profit * Math.min(b.salesPerDay, b.quantity) - a.profit * Math.min(a.salesPerDay, a.quantity))
    .slice(0, 10);
}

function rankCrafts(data) {
  return (data.recipes || []).filter(row => row.recipe?.name &&
    row.result?.url?.startsWith('https://ahledger.com/') &&
    row.unpriced?.length === 0 && row.margin >= 10000 &&
    row.resultSalesPerDay >= 1 && row.resultClearDays <= 7)
    .sort((a, b) => b.profitPerDay - a.profitPerDay).slice(0, 8);
}

async function getJson(path, fetcher = fetch) {
  const response = await fetcher(`${API}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`AHledger returned HTTP ${response.status} for ${path}`);
  return response.json();
}

function makePayload(deals, crafts, asOf, market, icons = {}) {
  const timestamp = new Date(asOf);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('AHledger returned no valid scan time');
  if (Date.now() - timestamp.getTime() > 6 * 60 * 60 * 1000) throw new Error(`AHledger scan is stale: ${asOf}`);
  const section = (title, rows, crafting, color) => ({
    type: 17, accent_color: color,
    components: [
      { type: 10, content: `### ${title} · Top ${rows.length}` },
      ...rows.flatMap((row, i) => [
        ...(i ? [{ type: 14, divider: true, spacing: 1 }] : []),
        itemBlock(row, icons, crafting),
      ]),
      ...(!rows.length ? [{ type: 10, content: 'No opportunities pass recent-history, stability, profit and turnover checks.' }] : []),
    ],
  });
  return {
    flags: 32768,
    allowed_mentions: { parse: [] },
    components: [
      { type: 10, content: `## ForeverMarket\n${marketLabel(market)} · Scan <t:${Math.floor(timestamp.getTime() / 1000)}:R>\n-# Updated <t:${Math.floor(Date.now() / 1000)}:t> · Refreshes every 15 min` },
      section('Buy & resell', deals.slice(0, 3), false, 0x53ad91),
      section('Craft & sell', crafts.slice(0, 3), true, 0x8e9be0),
      { type: 10, content: `-# Targets use recent listing floors, not predicted rebounds. Estimates after 5% AH cut, before deposits. Sales/day is market-wide, not guaranteed. Confirm live listings.\n[Prices from AHledger](https://ahledger.com) · [All deals](https://ahledger.com/deals?market=${market.replaceAll('.', '/')}) · [All crafts](https://ahledger.com/crafting?market=${market.replaceAll('.', '/')})` },
    ],
  };
}

async function run({ fetcher = fetch, webhook = process.env.DISCORD_WEBHOOK_URL, market = MARKET, stateFile, messageId } = {}) {
  if (!/^forever\.(normal|pvp|rp|rppvp)\.(alliance|horde)\.(us|eu|cn|kr)$/.test(market)) throw new Error('Invalid AHLEDGER_MARKET');
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook || '')) throw new Error('Set DISCORD_WEBHOOK_URL to a Discord webhook URL');
  // The unfiltered crafting response stops at 500 rows; each profession fits below that cap.
  const [deals, ...craftFeeds] = await Promise.all([
    getJson(`/v1/deals/${market}?discount=25&units=1&sells=1&limit=200`, fetcher),
    ...PROFESSIONS.map(profession => getJson(`/v1/crafting/${market}?profession=${encodeURIComponent(profession)}`, fetcher)),
  ]);
  if (deals.market !== market || deals.marketStatus !== 'scanned' || craftFeeds.some(feed => feed.market !== market || feed.marketStatus !== 'scanned')) throw new Error('AHledger has no scan for the selected market');
  if (!deals.pricesAsOf || craftFeeds.some(feed => feed.pricesAsOf !== deals.pricesAsOf)) throw new Error('AHledger deal and craft scans differ; retry next run');
  const screened = await screenCandidates(
    rankDeals(deals),
    rankCrafts({ recipes: craftFeeds.flatMap(feed => feed.recipes || []) }).slice(0, 6),
    id => getJson(`/v1/prices/${market}/${id}?range=7d`, fetcher), deals.pricesAsOf,
  );
  console.log('History screening:', JSON.stringify(screened.rejected));
  const rankedDeals = screened.deals.slice(0, 3);
  const rankedCrafts = screened.crafts.slice(0, 3);
  const ids = [...new Set([...rankedDeals.map(row => row.item.id), ...rankedCrafts.map(row => row.result.id)])].filter(Number.isInteger);
  let icons = {};
  if (ids.length) {
    try {
      const tooltip = await getJson(`/v1/tooltip/${market}?items=${ids.join(',')}`, fetcher);
      icons = Object.fromEntries((tooltip.items || []).map(item => [item.id, item.icon]));
    } catch { console.warn('Item icons unavailable; updating with text only'); }
  }
  const payload = makePayload(rankedDeals, rankedCrafts, deals.pricesAsOf, market, icons);
  await updateMessage({ webhook, payload, fetcher, stateFile, messageId });
  return payload;
}

if (require.main === module) {
  if (process.argv.includes('--once')) run().then(() => console.log('Updated market board')).catch(error => { console.error(error.message); process.exitCode = 1; });
  else {
    const tick = () => run().then(() => console.log('Updated market board')).catch(error => console.error(error.message));
    tick();
    setInterval(tick, INTERVAL_MS);
  }
}

module.exports = { copper, rankDeals, rankCrafts, makePayload, run };
