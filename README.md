# ForeverMarket

A live Discord market board for WoW Forever's **EU PvP Horde** auction house. Every 15 minutes it refreshes the same message with three auction flips and three crafting opportunities, compact gold prices, estimated profit and ROI, and item icons. Links open the full deal and crafting lists.

## Run on Bot-Hosting.net

Use Node.js 22 or newer, clone `https://github.com/Randiom/ForeverMarket` on branch `main`, and set the entry file to `bot.js`. Add `DISCORD_WEBHOOK_URL` as a secret in the host's Env tab. Start the deployment. There are no external dependencies.

The first run creates a board. The bot saves its message ID in `.state/discord-message.json`; subsequent runs edit it, including after restarts. **Preserve this file when syncing or redeploying.** Store it on persistent disk. To use a different persistent path, set `MESSAGE_STATE_FILE`. If you run another host or erase this state, the bot cannot discover its old message and creates another one.

To reuse a message already sent by this webhook, enable Developer Mode in Discord, copy that message's ID, and set `DISCORD_MESSAGE_ID` before the first run. A saved ID takes precedence on later runs. An old embed message can be converted to the new layout. A webhook can only edit its own messages.

A deleted board is replaced on the next successful scan. Rate limits, permission failures, and temporary Discord errors leave the existing board in place. Corrupt state stops updates rather than posting duplicates. The state file contains a webhook fingerprint and message ID, never the webhook token. A lock prevents concurrent processes sharing a state file from posting twice; after an abrupt crash, remove a leftover `.lock` file only after confirming the bot is stopped.

The board uses [Discord Components V2](https://docs.discord.com/developers/components/reference), with thumbnail accessories rather than traditional rich embeds. If icons cannot be fetched, the same board still updates with text. It is a webhook dashboard; interactive pagination or Discord commands would require an application bot.

## Local commands

Set `DISCORD_WEBHOOK_URL` in your environment; `.env` files are not loaded automatically.

```sh
npm test
npm run once   # create or update the board once
npm start      # update immediately, then every 15 minutes
```

Optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AHLEDGER_MARKET` | `forever.pvp.horde.eu` | Market to track |
| `MESSAGE_STATE_FILE` | `.state/discord-message.json` | Persistent message state path |
| `DISCORD_MESSAGE_ID` | unset | Existing webhook message to adopt when no state exists |

## GitHub Actions alternative

The workflow updates at minutes 3, 18, 33, and 48 and supports manual runs. It reads the `DISCORD_WEBHOOK_URL` repository secret and caches the board's message ID between runners. To adopt an existing message, add a repository **variable** called `DISCORD_MESSAGE_ID`. GitHub can delay scheduled runs. If its cache is evicted, the configured message ID allows adoption again; without it a new board is created.

Run one scheduler. **Disable the GitHub Actions workflow when hosting on Bot-Hosting.net.** Separate hosts do not share state files and will otherwise maintain separate boards. Existing historical reports are not deleted by the bot.

## Opportunity selection

The AHledger deals feed is a candidate list, not a buy signal. Each refresh checks the top ten deal candidates and six craft candidates against item history before selecting up to three of each. The request budget is at most 29 API calls per refresh, including icons. This bounded shortlist can miss opportunities outside those candidates.

Candidates must have recent item prices within two hours of the market snapshot. The history check requires at least 12 distinct hourly observations in **each** of the last three 24-hour windows, four in each of the last two six-hour windows, and an observation within two hours. Duplicate and invalid samples do not count. Missing history or API failures exclude the candidate; there is no fallback to the weekly median.

Reject an item when its median minimum-buyout price falls more than 10% day over day, more than 15% compared with the oldest of the three days, more than 5% across the last two six-hour windows, or when the latest six-hour floor is more than 10% below the latest daily floor. Reject volatility when the 90th percentile exceeds 1.5 times the 10th percentile of either minimum buyouts or medians over three days. These are conservative screening rules, not a statistically calibrated forecast.

Resale targets use the **lowest** of the lower quartile of listing floors over 24 hours, the lower quartile over 72 hours, and 95% of the current median. The original historical reference can only lower that target. Buy cost uses the higher of the candidate price and the latest item minimum. Profit is recalculated after the 5% cut. This prevents a weekly spike from setting a rebound target.

Craft targets also cannot exceed the current minimum buyout or the recipe feed's output price. Margin is recalculated using the guaranteed minimum yield and reagent cost; it does not rely on maximum proc yield. Crafting cards display the profession and required skill (for example, Leatherworking 225) from the recipe record, or explicitly show that skill is unknown.

Both types need at least one gold net margin, 15% ROI, five estimated market-wide sales per day and no more than two days of listed supply. Recipes with unpriced reagents are excluded. Craft data is fetched by profession to avoid the unfiltered API's 500-row cap. Each card shows the daily change in median listing floor and the number of hourly observations supporting its checks.

Prices remain copper internally and display values are floored to two decimal gold values. History records **asking prices, not executed trade prices**. Passing a stability screen does not establish that prices will rise, that your listing will sell, or that a trade is profitable after deposits and repeated relisting. The API's sales/day estimate covers the whole market. Scans older than six hours or inconsistent feed timestamps leave the existing board untouched with its prior scan time visible.

Recipe reference: [WoW Forever recipes on Wowhead](https://www.wowhead.com/forever/items/recipes). Calculations use AHledger's current recipe and price data; the bot does not scrape Wowhead. Data credit: [AHledger API](https://ahledger.com/developers). Intended for free personal or community use under its API terms.
