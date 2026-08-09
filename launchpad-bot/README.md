# $STAG — Buy Bot

Real-time **buy alerts** for a token on **Robinhood Chain** (EVM, chainId 4663).
Watches the token's liquidity pool and posts every buy to **Telegram**, **Discord**,
or both. Read-only — no wallet, no private key, ever.

A "buy" = tokens leaving the pool to a wallet (`Transfer` where `from == POOL`).

---

## 1. Install (on an always-on box — VPS, droplet, home server)

```bash
cd launchpad-bot
npm install
cp .env.example .env
```

The bot must run somewhere that stays on. Your laptop works for testing, but for
your community use a cheap VPS or a Raspberry Pi so it never sleeps.

## 2. Point it at your token

In `.env`:

```
TOKEN_ADDRESS=0x....   # the coin's contract
POOL_ADDRESS=0x....    # the liquidity pool it trades against
WETH_ADDRESS=0x....    # optional — lets it show ETH spent per buy
```

> Don't know the pool address? It's the pair/pool the launchpad created for the
> token. Tell me the token address and I'll pull the pool for you.

## 3. Add it to your server

Pick either or both — set only the ones you use.

### Discord (easiest — one paste)
1. **Server Settings → Integrations → Webhooks → New Webhook**
2. Choose the channel, click **Copy Webhook URL**
3. Paste it into `.env`:
   ```
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/....
   ```
That's it — the bot posts a rich embed on every buy.

### Telegram
1. Message **@BotFather** → `/newbot` → follow prompts → copy the **bot token**
2. Add your new bot to your group (and make it admin so it can post)
3. Get the **chat id**: add **@RawDataBot** to the group briefly, or send a
   message and open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` — the `chat.id` is there
   (group ids look like `-1001234567890`)
4. Fill `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=-1001234567890
   ```

## 4. Run it

```bash
# quick test (foreground)
npm start

# production — keep it alive & restart on reboot
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 logs hoodx-buybot
```

---

## What an alert looks like

```
🟩🟩🟩🟩🟩🟩
$ARROW BUY!
💵 0.42 ETH ($1,344)
🪙 1,240,551 ARROW
👤 0x8ac3…21de
📈 $0.000142 · MCap $142.3K
🔗 Tx · Chart
```

Emoji count scales with buy size (`EMOJI_STEP_ETH`). The **Buy** link points at
that coin's page on $STAG (`robinhoodchain.blockscout.com/token/<address>`).

## Tuning (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `MIN_BUY_ETH` | `0` | Hide dust buys below this ETH amount |
| `ETH_USD` | *(blank)* | Static ETH price so it can show `$` and market cap. Blank = ETH-only |
| `EMOJI_STEP_ETH` | `0.02` | One 🟩 per this much ETH |
| `BUY_EMOJI` | `🟩` | Change the buy emoji |
| `MEDIA_URL` | *(blank)* | Image/GIF shown on each alert |
| `POLL_MS` | `8000` | How often to check for new blocks |
| `START_BLOCK` | `0` | `0` = start from now (don't replay old buys) |

## Notes

- **Multiple coins?** Run one copy per token — clone the folder (or the pm2 app
  with a different `name` + `.env`). Say the word and I'll add a multi-token mode
  that watches every launchpad coin from one process.
- The bot stores its progress in `.state.json` so a restart doesn't miss or
  double-post buys.
- `ETH_USD` is static for simplicity. If you want live USD/market-cap pricing I
  can wire it to a price source.
