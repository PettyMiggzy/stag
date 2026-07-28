/* ============================================================
   Sherwood Market — Telegram bot webhook (Vercel serverless).

   Handles user commands so people can build a personal token watchlist:
     /start | /help          — what this bot does
     /watch  0x<token>        — get DM'd when an order is posted/filled for this token
     /unwatch 0x<token>       — stop watching it
     /list                    — your watched tokens

   Point Telegram at this URL once (see docs/telegram-alerts-setup.md):
     https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://stagwifhood.fun/api/tg/webhook&secret_token=<SECRET>
   ============================================================ */
'use strict';

const { SITE, tokenMeta, kvFactory, tgFactory } = require('../_lib/notify');

const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);

module.exports = async (req, res) => {
  // ack fast — Telegram retries on non-200
  const ok = () => { res.statusCode = 200; res.end('ok'); };

  if (req.method !== 'POST') { res.statusCode = 200; res.end('ok'); return; }

  // optional shared-secret check (set when you register the webhook)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) { ok(); return; }

  let update;
  try { update = typeof req.body === 'object' ? req.body : JSON.parse(await raw(req)); }
  catch { ok(); return; }

  const msg = update && (update.message || update.edited_message);
  const text = msg && msg.text;
  if (!msg || !text) { ok(); return; }
  const chatId = String(msg.chat.id);

  let kv, tg;
  try { kv = await kvFactory(); tg = tgFactory(); }
  catch { ok(); return; } // not configured yet — ack silently

  const [cmdRaw, arg] = text.trim().split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase().replace(/@.*$/, ''); // strip @botname

  try {
    if (cmd === '/start') {
      await tg(chatId, START_MSG);
    } else if (cmd === '/help' || cmd === '/commands') {
      await tg(chatId, HELP_MSG);
    } else if (cmd === '/how' || cmd === '/guide' || cmd === '/howto') {
      await tg(chatId, HOW_MSG);
    } else if (cmd === '/market' || cmd === '/trade' || cmd === '/buy' || cmd === '/sell') {
      await tg(chatId,
        '🛒 <b>Sherwood Market</b>\n\n' +
        'Trade any token peer-to-peer on Robinhood Chain. Tap below, connect your wallet, and post or fill an order.\n\n' +
        '👉 <a href="' + SITE + '/market">Open Sherwood Market</a>\n\n' +
        'New here? Send /how for the full step-by-step.',
        { reply_markup: { inline_keyboard: [[{ text: '🛒 Open Sherwood Market', url: SITE + '/market' }]] } });
    } else if (cmd === '/watch') {
      if (!isAddr(arg)) {
        await tg(chatId,
          '❌ I need the token\'s <b>contract address</b> after the command.\n\n' +
          '<b>Like this:</b>\n<code>/watch 0xcC142366735c882F7885d3c747db99e45E13E453</code>  (that\'s $STAG)\n\n' +
          '<b>Where do I find an address?</b> On the token\'s page in the explorer (' + esc(SITE) + ' → any token), or copy it from the chart site. It always starts with <code>0x</code> and is 42 characters.');
        return ok();
      }
      const t = arg.toLowerCase();
      await kv('SADD', 'mkt:watch:' + t, chatId);
      await kv('SADD', 'mkt:user:' + chatId, t);
      const meta = await tokenMeta(kv, t).catch(() => ({ symbol: t.slice(0, 8) + '…' }));
      await tg(chatId, `✅ <b>Now watching ${esc(meta.symbol)}</b>\n<code>${t}</code>\n\nI'll DM you the second a new order is posted or filled for it. Turn it off anytime with /unwatch. See all with /list.`);
    } else if (cmd === '/unwatch') {
      if (!isAddr(arg)) { await tg(chatId, '❌ Send the token address you want to stop watching:\n<code>/unwatch 0x…</code>\n\nNot sure which? Send /list to see them.'); return ok(); }
      const t = arg.toLowerCase();
      await kv('SREM', 'mkt:watch:' + t, chatId);
      await kv('SREM', 'mkt:user:' + chatId, t);
      await tg(chatId, `🚫 Stopped watching\n<code>${t}</code>\n\nYou won't get alerts for this token anymore.`);
    } else if (cmd === '/list') {
      const list = await kv('SMEMBERS', 'mkt:user:' + chatId);
      const arr = Array.isArray(list) ? list : [];
      if (!arr.length) { await tg(chatId, '👀 You aren\'t watching any tokens yet.\n\nAdd one so I can DM you its trades:\n<code>/watch 0x…token</code>\n\nSend /how if you\'re not sure.'); return ok(); }
      const lines = [];
      for (const t of arr) { const m = await tokenMeta(kv, t).catch(() => ({ symbol: '' })); lines.push(`• <b>${esc(m.symbol || '')}</b>\n  <code>${t}</code>`); }
      await tg(chatId, '👀 <b>You\'re watching ' + arr.length + ' token' + (arr.length > 1 ? 's' : '') + ':</b>\n' + lines.join('\n') + '\n\nStop one with <code>/unwatch 0x…</code>');
    } else if (cmd.startsWith('/')) {
      await tg(chatId, '🤔 I don\'t know that command.\n\nTry /help for the list, or /how for step-by-step instructions.');
    }
  } catch { /* swallow — always ack */ }
  ok();
};

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function raw(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d || '{}')); req.on('error', () => resolve('{}')); });
}

/* ---------------- message copy (kept dead simple on purpose) ---------------- */
const START_MSG =
  '🦌 <b>Welcome to Sherwood Market</b>\n\n' +
  'This is the alert bot for <a href="' + SITE + '/market">Sherwood Market</a> — a place to buy &amp; sell any token, person-to-person, on Robinhood Chain. Like eBay, but for tokens.\n\n' +
  '<b>What I do for you:</b>\n' +
  '📢 The channel posts <b>every</b> new listing &amp; sale automatically.\n' +
  '👀 I can DM <b>you</b> when a token you care about trades — just tell me which one.\n\n' +
  '<b>Two things to try:</b>\n' +
  '1️⃣ Watch a token → <code>/watch 0x…address</code>\n' +
  '2️⃣ Learn to buy/sell → send /how\n\n' +
  'Type / to see every command. 👇';

const HELP_MSG =
  '📖 <b>Commands</b>\n\n' +
  '/market — open the marketplace 🛒\n' +
  '/how — full step-by-step: how to buy &amp; sell\n' +
  '/watch <code>0x…token</code> — DM me when this token trades\n' +
  '/unwatch <code>0x…token</code> — stop watching it\n' +
  '/list — the tokens you\'re watching\n' +
  '/help — this list\n\n' +
  '💡 <b>Tip:</b> a "token address" always starts with <code>0x</code> and is 42 characters. Copy it from the token\'s page and paste it after /watch.';

const HOW_MSG =
  '🧭 <b>How to use Sherwood Market</b>\n' +
  '<i>(read once — it\'s easy)</i>\n\n' +
  '<b>🔑 First, one-time setup</b>\n' +
  '• Get a wallet (MetaMask, Trust, SafePal…) and add <b>Robinhood Chain</b>.\n' +
  '• Keep a little <b>ETH</b> in it for gas (tiny fees).\n\n' +
  '<b>🛒 To BUY a token someone listed</b>\n' +
  '1. Open <a href="' + SITE + '/market">the market</a> → <b>Connect Wallet</b>.\n' +
  '2. Look through <b>Open Orders</b>. Each shows what\'s for sale and the price.\n' +
  '3. Tap <b>Buy</b> on the one you want → confirm in your wallet.\n' +
  '4. Done ✅ The tokens land in your wallet in one transaction.\n\n' +
  '<b>🏷️ To SELL your own token</b>\n' +
  '1. Open the market → <b>Connect Wallet</b> → <b>Post an Order</b>.\n' +
  '2. Pick the token + amount you\'re selling.\n' +
  '3. Pick what you want paid in (ETH or another token) + your price.\n' +
  '4. <b>Approve</b>, then <b>Post</b>. Your tokens go into safe escrow.\n' +
  '5. When someone buys, you get paid automatically. Changed your mind? Tap <b>Cancel</b> to get them back.\n\n' +
  '<b>🔒 Is it safe?</b> Yes — your tokens sit in an audited contract, not with a stranger. Only you can cancel your order, and nobody can touch it. Standard tokens only.\n\n' +
  '<b>💸 Fees:</b> 1% from the buyer + 1% from the seller. That\'s it.\n\n' +
  '👉 <a href="' + SITE + '/market">Open Sherwood Market</a> · full guide: <a href="https://stag.gitbook.io/stag-docs/">docs</a>';
