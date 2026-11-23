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

Auction deals need a 25% discount against a historical reference, at least one estimated sale per day, and at least one gold estimated net profit per unit. Net profit is 95% of AHledger's reference median less the cheapest listing. Ranking uses profit multiplied by estimated turnover.

Crafts need priced reagents, at least one estimated result sale per day, at most seven days to clear existing listings, and at least one gold net margin. Ranking uses AHledger's estimated daily profit potential. Crafting data is fetched by profession to avoid the unfiltered API's 500-row cap. Item icons come from AHledger's tooltip endpoint, which supplies Blizzard-hosted images.

Prices remain copper internally. Displayed amounts are floored to two decimal gold values. Estimates include the 5% house cut and exclude deposits; market-wide sales rates do not guarantee your own sales or a quick sale. Scans older than six hours or inconsistent feed timestamps are rejected, leaving the prior board and its visible scan timestamp intact.

Recipe reference: [WoW Forever recipes on Wowhead](https://www.wowhead.com/forever/items/recipes). Calculations use AHledger's current recipe and price data; the bot does not scrape Wowhead. Data credit: [AHledger API](https://ahledger.com/developers). Intended for free personal or community use under its API terms.
