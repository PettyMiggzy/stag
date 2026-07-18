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
    if (cmd === '/start' || cmd === '/help') {
      await tg(chatId,
        '🦌 <b>Sherwood Market Alerts</b>\n\n' +
        'I ping you about trades on <a href="' + SITE + '/market">Sherwood Market</a> — the P2P token exchange on Robinhood Chain.\n\n' +
        '<b>Commands</b>\n' +
        '/watch <code>0x…token</code> — alert me on orders for this token\n' +
        '/unwatch <code>0x…token</code> — stop\n' +
        '/list — my watched tokens\n\n' +
        'The public channel posts every new listing &amp; sale automatically.');
    } else if (cmd === '/watch') {
      if (!isAddr(arg)) { await tg(chatId, '❌ Send a token address:\n<code>/watch 0x…</code>'); return ok(); }
      const t = arg.toLowerCase();
      await kv('SADD', 'mkt:watch:' + t, chatId);
      await kv('SADD', 'mkt:user:' + chatId, t);
      const meta = await tokenMeta(kv, t).catch(() => ({ symbol: t.slice(0, 8) + '…' }));
      await tg(chatId, `✅ Watching <b>${esc(meta.symbol)}</b>\n<code>${t}</code>\nI'll DM you on new orders &amp; sales.`);
    } else if (cmd === '/unwatch') {
      if (!isAddr(arg)) { await tg(chatId, '❌ Send a token address:\n<code>/unwatch 0x…</code>'); return ok(); }
      const t = arg.toLowerCase();
      await kv('SREM', 'mkt:watch:' + t, chatId);
      await kv('SREM', 'mkt:user:' + chatId, t);
      await tg(chatId, `🚫 Stopped watching\n<code>${t}</code>`);
    } else if (cmd === '/list') {
      const list = await kv('SMEMBERS', 'mkt:user:' + chatId);
      const arr = Array.isArray(list) ? list : [];
      if (!arr.length) { await tg(chatId, 'You aren\'t watching any tokens yet.\nAdd one: <code>/watch 0x…</code>'); return ok(); }
      const lines = [];
      for (const t of arr) { const m = await tokenMeta(kv, t).catch(() => ({ symbol: '' })); lines.push(`• <b>${esc(m.symbol || '')}</b> <code>${t}</code>`); }
      await tg(chatId, '👀 <b>You\'re watching:</b>\n' + lines.join('\n'));
    } else if (cmd.startsWith('/')) {
      await tg(chatId, 'Unknown command. Try /help');
    }
  } catch { /* swallow — always ack */ }
  ok();
};

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function raw(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d || '{}')); req.on('error', () => resolve('{}')); });
}
