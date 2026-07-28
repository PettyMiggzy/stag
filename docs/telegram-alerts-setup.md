# Sherwood Market — Telegram Alerts Setup

This turns on the 🔔 alert bot: a **public channel** that auto-posts every new listing + sale on
Sherwood Market, plus a **personal watchlist** (`/watch 0x…token`) people can DM the bot.

It's all serverless — no server to run. You just create a bot + a channel, add a small database
(free), paste a handful of env vars into Vercel, and register the webhook once.

**Time: ~10 minutes. Cost: $0 (free tiers).**

---

## 1) Create the Telegram bot

1. In Telegram, message **@BotFather** → `/newbot`.
2. Give it a name (e.g. *Sherwood Market Alerts*) and a username ending in `bot`.
3. BotFather gives you a **token** like `123456:ABC-DEF…`. **Save it** — this is `TELEGRAM_BOT_TOKEN`.

## 2) Create the public channel

1. Telegram → new **Channel** (e.g. *Sherwood Market* → `@stagmarket`). Make it **public**.
2. Open the channel → **Administrators** → **Add** your bot → give it **Post Messages** permission.
3. Your `TELEGRAM_CHANNEL_ID` is the public @handle, e.g. `@stagmarket`.
   *(Private channel? Use its numeric id like `-1001234567890` instead — ask @userinfobot.)*

## 3) Add the free database (Vercel KV / Upstash)

The bot needs a tiny bit of storage (a block cursor + who watches what).

1. Vercel dashboard → your **stag** project → **Storage** → **Create** → **Upstash Redis** (KV). Free tier is plenty.
2. Connect it to the project. Vercel auto-adds **`KV_REST_API_URL`** and **`KV_REST_API_TOKEN`** env vars.
   *(If it names them `UPSTASH_REDIS_REST_URL/TOKEN`, just add two more env vars `KV_REST_API_URL` / `KV_REST_API_TOKEN` with the same values.)*

## 4) Set the env vars in Vercel

**Project → Settings → Environment Variables** (Production). Add:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from step 1 |
| `TELEGRAM_CHANNEL_ID` | e.g. `@stagmarket` |
| `KV_REST_API_URL` | from step 3 (auto) |
| `KV_REST_API_TOKEN` | from step 3 (auto) |
| `CRON_SECRET` | any random string you make up (guards the poller) |
| `TELEGRAM_WEBHOOK_SECRET` | any random string you make up (guards the webhook) |
| `WHALE_ETH` | *(optional)* ETH-priced trade ≥ this gets a 🐋 tag. Default `0.1` |

Then **redeploy** (Deployments → ⋯ → Redeploy) so the new env + cron take effect.

## 5) Register the Telegram webhook (once)

This tells Telegram to send `/watch` commands to the site. Paste in a browser (fill in your values):

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://www.stagwifhood.fun/api/tg/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

You should see `{"ok":true,"result":true,...}`. Now DM your bot `/start` — it should reply.

## 6) The poller (auto)

`vercel.json` already schedules the event poller every minute:

```
"crons": [{ "path": "/api/market/poll", "schedule": "* * * * *" }]
```

- **On Vercel Pro/Enterprise:** this just works — it runs every minute and sends the alerts.
- **On the free Hobby plan:** Vercel only runs crons **once a day**. To get real-time alerts,
  use a free external pinger instead: at **cron-job.org**, create a job that GETs
  `https://stagwifhood.fun/api/market/poll?key=<CRON_SECRET>` every 1 minute. (You can then
  delete the `crons` block from `vercel.json`, or leave it — harmless.)

> The first poll run just records the current block (no history spam). From then on, every new
> order and sale posts to the channel, and anyone watching that token gets a DM.

---

## Test it

1. DM the bot `/start` → you get the help message. ✅
2. DM `/watch 0xcC142366735c882F7885d3c747db99e45E13E453` (that's $STAG) → "Watching STAG". ✅
3. Post a small order on **stagwifhood.fun/market** → within ~1 min the channel posts it and you get a DM. ✅

## Troubleshooting

- **Bot doesn't reply to /start** → webhook not set (redo step 5) or `TELEGRAM_WEBHOOK_SECRET` mismatch.
- **Channel gets nothing** → bot isn't a channel admin (step 2) or `TELEGRAM_CHANNEL_ID` wrong.
- **"KV not configured"** → the `KV_REST_API_*` env vars aren't set / project not redeployed.
- **Manual poke:** open `https://stagwifhood.fun/api/market/poll?key=<CRON_SECRET>` — it returns JSON like `{"ok":true,"from":..,"to":..,"sent":N}`.

Keep `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`, and `TELEGRAM_WEBHOOK_SECRET` private — never commit them.
