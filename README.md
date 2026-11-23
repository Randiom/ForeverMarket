# ForeverMarket

A live Discord market board for WoW Forever's **EU PvP Horde** auction house. Every minute it refreshes the same message with three auction flips and three crafting opportunities, compact gold prices, estimated cash margins, and item icons. Links open the full deal and crafting lists.

## Run on Bot-Hosting.net

Use Node.js 22 or newer, clone `https://github.com/Randiom/ForeverMarket` on branch `main`, and set the entry file to `bot.js`. Add `DISCORD_WEBHOOK_URL` as a secret in the host's Env tab. Add your free AHledger key as the secret `AHLEDGER_API_KEY` to enable broader and faster scans. Craft & sell defaults to **Leatherworking**. Set `CRAFTING_PROFESSION` to another profession, or `All` to scan all professions. Restart after changing this setting. The bot only fetches the selected crafting feeds, labels the category on the board and filters the recipe link to match. Auction and market-watch sections still cover the whole selected market. Start the deployment. There are no external dependencies.

The first run creates a board. The bot saves its message ID in `.state/discord-message.json`; subsequent runs edit it, including after restarts. **Preserve this file when syncing or redeploying.** Store it on persistent disk. To use a different persistent path, set `MESSAGE_STATE_FILE`. If you run another host or erase this state, the bot cannot discover its old message and creates another one.

To reuse a message already sent by this webhook, enable Developer Mode in Discord, copy that message's ID, and set `DISCORD_MESSAGE_ID` before the first run. A saved ID takes precedence on later runs. An old embed message can be converted to the new layout. A webhook can only edit its own messages.

A deleted board is replaced on the next successful scan. Rate limits, permission failures, and temporary Discord errors leave the existing board in place. Corrupt state stops updates rather than posting duplicates. The state file contains a webhook fingerprint and message ID, never the webhook token. A lock prevents concurrent processes sharing a state file from posting twice; after an abrupt crash, remove a leftover `.lock` file only after confirming the bot is stopped.

The board uses [Discord Components V2](https://docs.discord.com/developers/components/reference), with thumbnail accessories rather than traditional rich embeds. If icons cannot be fetched, the same board still updates with text. It is a webhook dashboard; interactive pagination or Discord commands would require an application bot.

## Local commands

Set `DISCORD_WEBHOOK_URL` in your environment; `.env` files are not loaded automatically.

```sh
npm test
npm run once   # create or update the board once
npm start      # update immediately, then every minute
```

Optional settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AHLEDGER_API_KEY` | unset | Free AHledger key; enables up to 100 auction + 100 crafted outputs per refresh |
| `CRAFTING_PROFESSION` | `Leatherworking` | Crafting category, or `All` for every profession |
| `AHLEDGER_MARKET` | `forever.pvp.horde.eu` | Market to track |
| `MESSAGE_STATE_FILE` | `.state/discord-message.json` | Persistent message state path |
| `DISCORD_MESSAGE_ID` | unset | Existing webhook message to adopt when no state exists |

## GitHub Actions alternative

The workflow is manual-only. Keep the continuously running `npm start` process on Bot-Hosting.net for minute-by-minute checks. It reads the `DISCORD_WEBHOOK_URL` and optional `AHLEDGER_API_KEY` repository secrets and caches the board's message ID between runners. To adopt an existing message, add a repository **variable** called `DISCORD_MESSAGE_ID`. Set the repository variable `CRAFTING_PROFESSION` to change the workflow category; it defaults to Leatherworking. If its cache is evicted, the configured message ID allows adoption again; without it a new board is created.

Run one scheduler. **Disable the GitHub Actions workflow when hosting on Bot-Hosting.net.** Separate hosts do not share state files and will otherwise maintain separate boards. Existing historical reports are not deleted by the bot.

## Opportunity selection

The board balances **volume and entry cost**, not headline ROI. It selects high-volume candidates first, reserves the next slot for a lower-cost candidate (preferring trainer recipes up to skill 150 when available), then another liquid candidate. Outputs are deduplicated. A separate Liquid market watch shows two low-cost, high-volume items using current quotes, even if no validated flips pass. It is explicitly labeled as market information, not a recommendation, and has no profit claim. Percent ROI is not the headline; cards show estimated money per unit or craft, current input cost, target output price, output quantity, required skill, the recipe source reported by the feed, and a small example batch. The example is at most ten purchases/crafts, aims for at most 5% of estimated market sales and 10g of inputs, and respects quoted reagent availability. It always shows at least one unit/craft; expensive single crafts can exceed the example budget. Examples are calculations, not reserved inventory or guaranteed sales.

Auction candidates now come from the **whole AHledger price table**, rather than its large-discount deals endpoint. A small spread on a common material can qualify without a 25% historical discount. Crafting candidates come only from the selected profession feed (or all feeds when `CRAFTING_PROFESSION=All`). Before history checks, choose up to forty of each without a key (eighty outputs total), or one hundred of each with `AHLEDGER_API_KEY` (two hundred outputs total). The full table covers the market, but this is still a bounded shortlist rather than exhaustive validation of every recipe and item. The authenticated process has a ceiling of 299 HTTP requests per rolling minute shared across all API endpoints and refreshes; without a key the ceiling is 28. It does not send filler requests to reach that ceiling. Other clients using the same AHledger account share its 300/minute allowance. The limiter survives successive refreshes; each minute starts a refresh only if the previous one has completed. An anonymous refresh can take several minutes. If a pass overruns, the next tick is skipped and logged. The client honors `Cache-Control`/`Age`, discards cached responses when they expire, and honors `Retry-After` on 429/503 errors. Checking every minute does not create new upstream scans or bypass cache lifetimes. The key is sent only in the Authorization header to AHledger, never to Discord. Recent hourly history remains the short-term screen; longer history access does not turn old peaks into targets. Quote requests are batched in groups of at most 100 IDs so expanded coverage does not silently omit reagents. Concurrent refreshes do not overlap. The GitHub Actions timeout is ten minutes. Console logs report the checked/passing counts and individual rejection reasons.

Require at least 10 copper of net profit per unit/craft, 3% return on input cost, twenty estimated market-wide unit sales a day, and no more than three days of listed supply. Large unit yields count as units when sizing batches. A margin above 100% is excluded for manual verification of listings or recipe restrictions; it is not silently capped or marketed as a windfall. Smaller profitable bulk crafts no longer fail the old 1g/15% cutoffs.

### Costs and crafting restrictions

Before screening a craft's output, fetch **current quotes for every reagent**. Missing, stale, unpriced or insufficiently available inputs exclude that craft. Cost uses the greater of the recipe-feed price, current median and current minimum buyout, plus a 2% material buffer. Farmed materials have their market opportunity cost; vendor shopping is not assumed. Limited quote depth means the total listed quantity is not proof that a whole batch is available at that price.

Craft profit uses the guaranteed minimum yield, a target reduced by 2% for slippage, and the 5% AH cut applied once. Recipe learning, profession leveling, tools, deposits and repeat listing costs are not included. The board displays skill and acquisition as reported by AHledger; check specializations, stations and recipe ownership in game.

The feed omits cooldowns. Known transmute families, Mooncloth, Cured Rugged Hide and refined salt are excluded from repeatable picks; any explicit cooldown reported by the API is also excluded. This is a conservative exclusion list, not a complete restriction database. Verified Forever references include [Arcanite, about 47 hours](https://www.wowhead.com/forever/spell%3D17187/transmute-arcanite), [Mooncloth, about 95 hours](https://www.wowhead.com/forever/spell%3D18560/mooncloth), and [Undeath to Water, 23 hours](https://www.wowhead.com/forever/spell%3D17563/transmute-undeath-to-water). Their material spreads can be real while cooldown-limited production is unsuitable for bulk flipping.

### Price history

Require recent item observations within two hours of the market scan and distributed history: six distinct hourly observations in each of the last two days, two in each half-day, a twelve-hour span per day, and two in each recent six-hour window. Include the third day only when it has the same coverage. Duplicate, missing, future or invalid samples do not create confidence.

Reject median listing-floor declines greater than 10% day over day, 15% versus the third day (when covered), 5% across the two latest six-hour windows, or a latest six-hour floor more than 10% below the daily floor. Reject volatility when the 90th percentile exceeds 1.5 times the 10th percentile of listing floors or medians. These remain heuristic screens, not forecasts.

Targets use the lowest of the lower-quartile listing floors over 24 hours and the full covered window, and the current median. The table's historical reference can only lower an auction target. Craft targets also cannot exceed current competing minimum buyouts or the recipe feed's output price. Apply the 2% slippage allowance before calculating margin.

The table header is its **generation time**, not a scan time. Use the common recipe-feed scan timestamp and require table generation to be within two hours. Material quotes and histories are checked against that scan. A scan older than six hours or inconsistent recipe feeds leaves the prior board intact with its scan timestamp visible.

Prices are copper internally. Cards use gold for larger amounts and silver/copper for small ones so thin margins do not display as 0g. AHledger records asking prices, not executed trade prices, and sales/day estimates cover the whole market. Verify live listings before trading.

Recipe reference: [WoW Forever recipes on Wowhead](https://www.wowhead.com/forever/items/recipes). Calculations use AHledger's current recipe and price data; the bot does not scrape Wowhead. Data credit: [AHledger API](https://ahledger.com/developers). Intended for free personal or community use under its API terms.

Supported crafting categories: Alchemy, Blacksmithing, Cooking, Enchanting, Engineering, First Aid, Herbalism, Leatherworking, Mining, Skinning, Tailoring, and All. Values ignore letter case and surrounding spaces; invalid values fail before any API request.
