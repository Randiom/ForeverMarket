# AHledger flip alerts

A Discord webhook report for World of Warcraft: Forever's **EU PvP Horde** auction house. Every 15 minutes it fetches AHledger's [deals](https://ahledger.com/developers) and crafting endpoints, ranks likely quick flips, and posts up to eight auction deals and eight crafts. It fetches crafting data by profession to cover all priced recipes beyond the API's 500-row unfiltered cap. No Discord bot token or Riot credentials are needed.

## Setup

Use Node.js 20.12 or newer. Set `DISCORD_WEBHOOK_URL` in the process environment or as a GitHub Actions repository secret. The old repository's `DISCORD_TOKEN` and `RIOT_KEY` are not used. The webhook URL is a secret; never commit it. `AHLEDGER_MARKET` optionally selects another Forever market (default `forever.pvp.horde.eu`). See `.env.example` for names; Node does not load `.env` automatically.

```sh
export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
npm test
npm run once    # one report
npm start       # keep running, report every 15 minutes
```

The included GitHub Actions workflow runs at minutes 3, 18, 33, and 48 each hour and can also be started manually. Add the `DISCORD_WEBHOOK_URL` repository secret before enabling it. GitHub may delay scheduled jobs, so a continuously running `npm start` process is the choice when exact timing matters. Do not run both at once or you will receive duplicate reports.

## How opportunities are chosen

Auction deals need at least a 25% discount against a historical median, one estimated sale per day, and one gold of estimated net profit per unit. Estimated net profit is 95% of AHledger's reference median less the cheapest listing. Crafting opportunities need priced reagents, one estimated result sale per day, at most seven days to clear current listings, and one gold of net margin. The API already computes recipe reagents and margins for the [Forever recipes listed on Wowhead](https://www.wowhead.com/forever/items/recipes); the bot uses AHledger's live crafting calculations rather than scraping Wowhead.

All amounts are copper internally (10,000 copper = 1 gold). The report includes the scan time and links to AHledger's item pages. It refuses a scan older than six hours or mismatched data. Listings, costs, and sales estimates can change before a trade completes. A webhook only sends reports; it cannot respond to Discord commands.

Data credit: [AHledger](https://ahledger.com/developers). This bot is intended for free personal or community use under AHledger's published API terms.
