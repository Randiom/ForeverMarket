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

function chartLink(item) {
  // Keep unusually long source URLs from exhausting Discord's embed text budget.
  const url = item.chartUrl || item.url;
  return `[View prices](${url.length <= 250 ? url.replace(/[()]/g, c => c === '(' ? '%28' : '%29') : 'https://ahledger.com'})`;
}

function opportunityField(row, index, crafting = false) {
  const item = crafting ? row.result : row.item;
  const profit = crafting ? row.margin : row.profit;
  const cost = crafting ? row.cost : row.minBuyout;
  const sales = crafting ? row.resultSalesPerDay : row.salesPerDay;
  const roi = cost > 0 ? ` · ${Math.floor(profit / cost * 100)}% ROI` : '';
  const details = crafting
    ? `Materials \`${gold(cost)}\` · ${safe(row.recipe.profession)}`
    : `Buy \`${gold(cost)}\` → target \`${gold(row.referenceMedian)}\``;
  return {
    name: `${String(index + 1).padStart(2, '0')} · ${safe(item.name.slice(0, 90))}`,
    value: `**~+${gold(profit)} net/${crafting ? 'craft' : 'unit'}**${roi}\n${details}\nEst. ${sales.toLocaleString('en-US', { maximumFractionDigits: 1 })} sold/day · ${chartLink(item)}`,
    inline: false,
  };
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
  const scan = `<t:${Math.floor(timestamp.getTime() / 1000)}:R>`;
  const credit = { text: 'Prices from AHledger · Estimates after 5% AH cut · Excludes deposits' };
  const payload = {
    username: 'ForeverMarket',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: 'Auction flips',
        url: `https://ahledger.com/deals?market=${market.replaceAll('.', '/')}`,
        description: `**${marketLabel(market)}**\nScan ${scan} · ${deals.length} opportunities\n${deals.length ? 'Ranked by profit × estimated turnover.' : 'No deals meet the profit and sales filters. Check the full market using the title link.'}`,
        color: 0x53ad91,
        fields: deals.slice(0, 8).map((row, i) => opportunityField(row, i)),
        footer: credit,
      },
      {
        title: 'Crafting flips',
        url: `https://ahledger.com/crafting?market=${market.replaceAll('.', '/')}`,
        description: `**${marketLabel(market)}**\nScan ${scan} · ${crafts.length} opportunities\n${crafts.length ? 'Ranked by estimated daily profit potential.' : 'No crafts meet the profit and sales filters. Check the full recipe list using the title link.'}`,
        color: 0x8e9be0,
        fields: crafts.slice(0, 8).map((row, i) => opportunityField(row, i, true)),
        footer: credit,
      },
    ],
    content: '[Prices from AHledger](https://ahledger.com) · Confirm live listings before buying.',
  };
  // Discord caps text at 6,000 characters across all embeds in one message.
  const textSize = () => payload.embeds.reduce((total, embed) => total + embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0), 0);
  while (textSize() > 5900) {
    const embed = payload.embeds.reduce((a, b) => a.fields.length > b.fields.length ? a : b);
    embed.fields.pop();
    embed.description = embed.description.replace(/\d+ opportunities/, `${embed.fields.length} opportunities`);
  }
  return payload;
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
