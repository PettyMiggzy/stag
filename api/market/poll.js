/* ============================================================
   Sherwood Market — event poller (Vercel serverless, cron-driven).

   Reads new OrderCreated / OrderFilled events since the last cursor and:
     • posts them to the public Telegram channel (🐋 tag for whale-sized ETH trades)
     • DMs anyone who /watch-ed the token involved

   Idempotent: advances a block cursor in KV, so it never re-posts.
   Guarded by ?key=CRON_SECRET. Wire a cron to hit it every ~1 min.
   ============================================================ */
'use strict';

const {
  MARKET, ETH, SITE, T, rpc, toBig, addrFromWord, word,
  tokenMeta, fmtAmount, kvFactory, tgFactory,
} = require('../_lib/notify');

const MAX_RANGE = 4500;   // max blocks scanned per run (RPC getLogs safety)
const MAX_EVENTS = 40;    // cap posts per run so we never flood on a backfill

module.exports = async (req, res) => {
  // Auth: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"; external crons can pass ?key=<CRON_SECRET>.
  const secret = process.env.CRON_SECRET;
  const key = (req.query && req.query.key) || '';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || (key !== secret && bearer !== secret)) {
    res.statusCode = 401; res.end(JSON.stringify({ error: 'unauthorized' })); return;
  }
  let kv, tg;
  try { kv = await kvFactory(); tg = tgFactory(); }
  catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); return; }

  const channel = process.env.TELEGRAM_CHANNEL_ID;
  const whaleEth = (() => { try { return BigInt(Math.round(Number(process.env.WHALE_ETH || '0.1') * 1e18)); } catch { return 10n ** 17n; } })();

  try {
    const latest = Number(toBig(await rpc('eth_blockNumber')));
    let cursor = Number((await kv('GET', 'mkt:cursor')) || 0);
    if (!cursor) { // first run — start at the tip, don't spam history
      await kv('SET', 'mkt:cursor', String(latest));
      res.end(JSON.stringify({ ok: true, init: true, cursor: latest })); return;
    }
    if (cursor >= latest) { res.end(JSON.stringify({ ok: true, nothing: true, cursor })); return; }

    const from = cursor + 1;
    const to = Math.min(latest, cursor + MAX_RANGE);
    const logs = await rpc('eth_getLogs', [{
      address: MARKET,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [[T.created, T.filled]],
    }]);

    let sent = 0;
    for (const log of logs.slice(0, MAX_EVENTS)) {
      const topic0 = log.topics[0].toLowerCase();
      let text = null, token = null, token2 = null, whale = false;

      if (topic0 === T.created) {
        // OrderCreated(id indexed, maker indexed, sellToken, sellAmount, buyToken, buyAmount)
        const id = toBig(log.topics[1]);
        const sellToken = addrFromWord(word(log.data, 0));
        const sellAmount = toBig(word(log.data, 1));
        const buyToken = addrFromWord(word(log.data, 2));
        const buyAmount = toBig(word(log.data, 3));
        const s = await tokenMeta(kv, sellToken);
        const b = await tokenMeta(kv, buyToken);
        token = sellToken.toLowerCase(); token2 = buyToken.toLowerCase();
        whale = buyToken.toLowerCase() === ETH && buyAmount >= whaleEth;
        text =
          `${whale ? '🐋 ' : '🦌 '}<b>New order${whale ? ' — WHALE' : ''}</b>\n` +
          `Selling <b>${fmtAmount(sellAmount, s.decimals)} ${esc(s.symbol)}</b>\n` +
          `For <b>${fmtAmount(buyAmount, b.decimals)} ${esc(b.symbol)}</b>\n` +
          `<a href="${SITE}/market">Buy on Sherwood Market →</a>`;
      } else if (topic0 === T.filled) {
        // OrderFilled(id indexed, taker indexed, sellToTaker, payToMaker, buyFee, sellFee)
        const id = toBig(log.topics[1]);
        const sellToTaker = toBig(word(log.data, 0));
        const payToMaker = toBig(word(log.data, 1));
        const ord = await readOrder(id);
        if (ord) {
          const s = await tokenMeta(kv, ord.sellToken);
          const b = await tokenMeta(kv, ord.buyToken);
          token = ord.sellToken.toLowerCase(); token2 = ord.buyToken.toLowerCase();
          whale = ord.buyToken.toLowerCase() === ETH && payToMaker >= whaleEth;
          text =
            `${whale ? '🐋 ' : '✅ '}<b>Sold${whale ? ' — WHALE' : ''}</b>\n` +
            `<b>${fmtAmount(sellToTaker, s.decimals)} ${esc(s.symbol)}</b> traded ` +
            `for <b>${fmtAmount(payToMaker, b.decimals)} ${esc(b.symbol)}</b>\n` +
            `<a href="${SITE}/market">Trade on Sherwood Market →</a>`;
        }
      }
      if (!text) continue;

      // public channel
      if (channel) { try { await tg(channel, text); sent++; } catch {} }
      // personal watchers of either token
      const chats = new Set();
      for (const tk of [token, token2].filter(Boolean)) {
        const m = await kv('SMEMBERS', 'mkt:watch:' + tk);
        (Array.isArray(m) ? m : []).forEach((c) => chats.add(c));
      }
      for (const c of chats) { try { await tg(c, '👀 Token you watch:\n' + text); } catch {} }
    }

    await kv('SET', 'mkt:cursor', String(to));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, from, to, logs: logs.length, sent }));
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
  }
};

// escape HTML for Telegram
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// read an order via eth_call getOrder(uint256) -> tuple(maker,active,buyFeeBps,sellFeeBps,sellToken,sellAmount,buyToken,buyAmount)
async function readOrder(id) {
  try {
    const data = '0xd09ef241' + id.toString(16).padStart(64, '0'); // getOrder(uint256)
    const ret = await rpc('eth_call', [{ to: MARKET, data }, 'latest']);
    if (!ret || ret === '0x') return null;
    const w = (i) => '0x' + ret.slice(2 + i * 64, 2 + (i + 1) * 64);
    return {
      maker: '0x' + w(0).slice(26),
      sellToken: '0x' + w(4).slice(26),
      buyToken: '0x' + w(6).slice(26),
    };
  } catch { return null; }
}
