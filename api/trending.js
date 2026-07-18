/* ============================================================
   Sherwood Terminal — LIVE token data on Robinhood Chain.

   Pulls from GeckoTerminal (network=robinhood): trending + top pools, then
   builds four views — 🔥 Trending · 🚀 Gainers · 📉 Dips · 🆕 New — each with
   CA, price, market cap, 24h volume, buys/sells, and multi-window % change.
   Cached ~90s in KV so it's instant for visitors and gentle on the API.

   GET /api/trending  ->  { updatedAt, views:{ trending, gainers, dips, new } }
   ============================================================ */
'use strict';
const { kvFactory } = require('./_lib/notify');

const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const CACHE_SEC = 90;
const PER_VIEW = 14;
const MIN_VOL = 300;        // ignore near-dead pairs in gainers/dips (USD 24h vol)

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

async function gt(path) {
  const r = await fetch(GT + path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('gt ' + r.status);
  return r.json();
}

// merge a GeckoTerminal pools payload into a token map (keep the highest-volume pool per token)
function absorb(map, payload, order) {
  const inc = {}; (payload.included || []).forEach((i) => { inc[i.id] = i.attributes || {}; });
  let rank = 0;
  for (const p of payload.data || []) {
    const a = p.attributes || {};
    const btId = p.relationships?.base_token?.data?.id || '';
    const tok = inc[btId] || {};
    const address = (tok.address || '').toLowerCase();
    if (!address) continue;
    const vol = num(a.volume_usd?.h24);
    const pc = a.price_change_percentage || {};
    const tx = a.transactions?.h24 || {};
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : 0;
    const img = tok.image_url && !/missing|null/i.test(tok.image_url) ? tok.image_url : null;
    const entry = {
      symbol: tok.symbol || '?', address, image: img,
      priceUsd: num(a.base_token_price_usd),
      mcapUsd: num(a.market_cap_usd) || num(a.fdv_usd),
      volH24: vol,
      chg: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
      buys24: num(tx.buys), sells24: num(tx.sells),
      createdAt: created,
      trendRank: order ? rank++ : (map.get(address)?.trendRank ?? 9999),
    };
    const prev = map.get(address);
    if (!prev || entry.volH24 >= prev.volH24) map.set(address, { ...prev, ...entry, image: entry.image || prev?.image || null, trendRank: Math.min(prev?.trendRank ?? 9999, entry.trendRank) });
    else if (prev && !prev.image && entry.image) prev.image = entry.image;
  }
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  let kv = null; try { kv = await kvFactory(); } catch {}
  if (kv) { try { const c = await kv('GET', 'trend:cache2'); if (c) { res.setHeader('x-cache', 'HIT'); res.end(c); return; } } catch {} }

  try {
    const [trend, top] = await Promise.all([
      gt('/trending_pools?include=base_token&duration=1h').catch(() => ({ data: [] })),
      gt('/pools?include=base_token&sort=h24_volume_usd_desc&page=1').catch(() => ({ data: [] })),
    ]);
    const map = new Map();
    absorb(map, trend, true);   // trending order preserved
    absorb(map, top, false);    // widen the universe for gainers/dips/new
    const all = [...map.values()];
    const now = Date.now();
    all.forEach((t) => { t.ageH = t.createdAt ? Math.max(0, (now - t.createdAt) / 3.6e6) : null; });

    const liquid = all.filter((t) => t.volH24 >= MIN_VOL);
    const views = {
      trending: [...all].sort((a, b) => a.trendRank - b.trendRank).slice(0, PER_VIEW),
      gainers: [...liquid].sort((a, b) => b.chg.h24 - a.chg.h24).slice(0, PER_VIEW),
      dips: [...liquid].sort((a, b) => a.chg.h24 - b.chg.h24).slice(0, PER_VIEW),
      new: [...all].filter((t) => t.ageH != null && t.ageH <= 24 * 10).sort((a, b) => a.ageH - b.ageH).slice(0, PER_VIEW),
    };
    // rank each view
    for (const k of Object.keys(views)) views[k] = views[k].map((t, i) => ({ rank: i + 1, ...t }));

    const payload = JSON.stringify({ updatedAt: now, source: 'geckoterminal', views });
    if (kv) { kv('SET', 'trend:cache2', payload).catch(() => {}); kv('EXPIRE', 'trend:cache2', String(CACHE_SEC)).catch(() => {}); }
    res.setHeader('x-cache', 'MISS');
    res.end(payload);
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: e.message, views: { trending: [], gainers: [], dips: [], new: [] } }));
  }
};
