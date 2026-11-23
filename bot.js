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
  return String(text).replace(/([\\`*_~|>])/g, '\\$1').replace(/@/g, '@\u200b');
}

function rankDeals(data) {
  return (data.deals || []).filter(row => {
    const profit = Math.floor(row.referenceMedian * 0.95) - row.minBuyout;
    return row.item?.name && row.item?.url?.startsWith('https://ahledger.com/') &&
      Number.isFinite(profit) && profit >= 10000 && row.salesPerDay >= 1 &&
      row.discount >= 0.25 && row.basis !== 'scan' && row.quantity > 0;
  }).map(row => ({ ...row, profit: Math.floor(row.referenceMedian * 0.95) - row.minBuyout }))
    .sort((a, b) => b.profit * Math.min(b.salesPerDay, b.quantity) - a.profit * Math.min(a.salesPerDay, a.quantity))
    .slice(0, 8);
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

function makePayload(deals, crafts, asOf, market) {
  const timestamp = new Date(asOf);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('AHledger returned no valid scan time');
  if (Date.now() - timestamp.getTime() > 6 * 60 * 60 * 1000) throw new Error(`AHledger scan is stale: ${asOf}`);
  const dealLines = deals.map((row, i) =>
    `${i + 1}. [${safe(row.item.name)}](${row.item.url}) — buy ${copper(row.minBuyout)}, typical ${copper(row.referenceMedian)}, **~${copper(row.profit)} net/unit** · ${row.salesPerDay}/day sold`);
  const craftLines = crafts.map((row, i) =>
    `${i + 1}. [${safe(row.recipe.name)}](${row.result.url}) (${safe(row.recipe.profession)}) — mats ${copper(row.cost)}, **~${copper(row.margin)} net/craft** · ${row.resultSalesPerDay}/day sold`);
  return {
    username: 'AHledger flip alerts',
    allowed_mentions: { parse: [] },
    embeds: [
      { title: 'Auction flips', description: dealLines.join('\n') || 'No qualifying deals in this scan.', color: 0x43b581 },
      { title: 'Crafting flips', description: craftLines.join('\n') || 'No qualifying crafts in this scan.', color: 0x5865f2 },
    ],
    content: `**${safe(market)}** · AH scan <t:${Math.floor(timestamp.getTime() / 1000)}:R> · [Prices from AHledger](https://ahledger.com/developers)\nEstimates use recent prices and a 5% house cut; confirm live listings before buying.`,
  };
}

async function run({ fetcher = fetch, webhook = process.env.DISCORD_WEBHOOK_URL, market = MARKET } = {}) {
  if (!/^forever\.(normal|pvp|rp|rppvp)\.(alliance|horde)\.(us|eu|cn|kr)$/.test(market)) throw new Error('Invalid AHLEDGER_MARKET');
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook || '')) throw new Error('Set DISCORD_WEBHOOK_URL to a Discord webhook URL');
  // The unfiltered crafting response stops at 500 rows; each profession fits below that cap.
  const [deals, ...craftFeeds] = await Promise.all([
    getJson(`/v1/deals/${market}?discount=25&units=1&sells=1&limit=200`, fetcher),
    ...PROFESSIONS.map(profession => getJson(`/v1/crafting/${market}?profession=${encodeURIComponent(profession)}`, fetcher)),
  ]);
  if (deals.market !== market || deals.marketStatus !== 'scanned' || craftFeeds.some(feed => feed.market !== market || feed.marketStatus !== 'scanned')) throw new Error('AHledger has no scan for the selected market');
  if (!deals.pricesAsOf || craftFeeds.some(feed => feed.pricesAsOf !== deals.pricesAsOf)) throw new Error('AHledger deal and craft scans differ; retry next run');
  const payload = makePayload(rankDeals(deals), rankCrafts({ recipes: craftFeeds.flatMap(feed => feed.recipes || []) }), deals.pricesAsOf, market);
  const response = await fetcher(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`);
  return payload;
}

if (require.main === module) {
  if (process.argv.includes('--once')) run().then(() => console.log('Posted flip report')).catch(error => { console.error(error.message); process.exitCode = 1; });
  else {
    const tick = () => run().then(() => console.log('Posted flip report')).catch(error => console.error(error.message));
    tick();
    setInterval(tick, INTERVAL_MS);
  }
}

module.exports = { copper, rankDeals, rankCrafts, makePayload, run };
