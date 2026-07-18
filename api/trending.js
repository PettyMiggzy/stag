/* ============================================================
   Sherwood Terminal — LIVE trending on Robinhood Chain.

   Ranks tokens by real Uniswap-V3 swap volume over a rolling window, computed
   straight from chain (no data provider). Cached ~2 min in KV so it's instant
   for visitors and cheap on the RPC. Powers the 🔥 Trending panel on /terminal.

   GET /api/trending  ->  { updatedAt, windowMin, ethUsd, tokens:[...] }
   ============================================================ */
'use strict';
const { rpc, kvFactory } = require('./_lib/notify');

const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const BS = 'https://robinhoodchain.blockscout.com';
const WINDOW_BLOCKS = 9000;   // ~15 min at ~0.1s blocks
const UNIVERSE = 30;          // top-N tokens by holders to consider
const TOP = 15;               // rows returned
const CACHE_SEC = 120;
const STAG = '0xcddb2d9838b7edab2f04af4943a6efe42c2f9f49';

const pad = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const s256 = (h) => { const v = BigInt('0x' + h); return v >= (1n << 255n) ? v - (1n << 256n) : v; };
const abs = (v) => (v < 0n ? -v : v);

async function getPool(token) {
  for (const fee of ['2710', '0bb8', '01f4']) { // 1%, 0.3%, 0.05%
    try {
      const r = await rpc('eth_call', [{ to: V3_FACTORY, data: '0x1698ee82' + pad(token) + pad(WETH) + pad('0x' + fee) }, 'latest']);
      if (r && r !== '0x') { const a = '0x' + r.slice(26); if (!/^0x0+$/.test(a)) return a; }
    } catch {}
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  let kv = null;
  try { kv = await kvFactory(); } catch {}

  // serve cache
  if (kv) { try { const c = await kv('GET', 'trend:cache'); if (c) { res.setHeader('x-cache', 'HIT'); res.end(c); return; } } catch {} }

  try {
    // ETH price (for USD) — best-effort from Blockscout stats
    let ethUsd = 1800;
    try { const s = await (await fetch(BS + '/api/v2/stats')).json(); if (+s.coin_price > 0) ethUsd = +s.coin_price; } catch {}

    // universe: top tokens by holders + always include $STAG
    let universe = [];
    try {
      const t = await (await fetch(BS + '/api/v2/tokens?type=ERC-20&sort=holders_count&order=desc')).json();
      universe = (t.items || []).slice(0, UNIVERSE).map((x) => (x.address_hash || x.address || '').toLowerCase());
    } catch {}
    if (!universe.includes(STAG)) universe.push(STAG);
    universe = universe.filter((a) => a && a !== WETH);

    const latest = Number(BigInt(await rpc('eth_blockNumber')));
    const from = latest - WINDOW_BLOCKS;
    const fromHex = '0x' + from.toString(16), toHex = '0x' + latest.toString(16);

    const rows = await Promise.all(universe.map(async (token) => {
      // cache the pool address (rarely changes)
      let pool = kv ? await kv('GET', 'trend:pool:' + token).catch(() => null) : null;
      if (!pool) { pool = await getPool(token); if (pool && kv) kv('SET', 'trend:pool:' + token, pool).catch(() => {}); }
      if (!pool) return null;
      let logs = [];
      try { logs = await rpc('eth_getLogs', [{ address: pool, topics: [SWAP_TOPIC], fromBlock: fromHex, toBlock: toHex }]); } catch { return null; }
      if (!logs.length) return null;
      const token0IsWeth = WETH < token;
      let vol = 0n, buys = 0, sells = 0, firstSqrt = null, lastSqrt = null;
      // Swap data words: [0]amount0 [1]amount1 [2]sqrtPriceX96 [3]liquidity [4]tick
      for (const lg of logs) {
        const d = lg.data.slice(2);
        const a0 = s256(d.slice(0, 64)), a1 = s256(d.slice(64, 128));
        const wethDelta = token0IsWeth ? a0 : a1;
        vol += abs(wethDelta);
        if (wethDelta < 0n) buys++; else sells++;                       // WETH leaving pool = buy
        const sqrt = Number(BigInt('0x' + d.slice(128, 192))) / 2 ** 96; // sqrtPriceX96
        if (firstSqrt === null) firstSqrt = sqrt; lastSqrt = sqrt;
      }
      // token price change in WETH over the window
      let chg = 0;
      if (firstSqrt && lastSqrt && firstSqrt > 0) {
        const r = (lastSqrt / firstSqrt) ** 2;
        chg = (token0IsWeth ? (1 / r) : r) - 1;
      }
      const volEth = Number(vol) / 1e18;
      return { address: token, pool, volumeEth: volEth, volumeUsd: volEth * ethUsd, buys, sells, swaps: logs.length, changePct: chg * 100 };
    }));

    const tokens = rows.filter(Boolean).sort((a, b) => b.volumeEth - a.volumeEth).slice(0, TOP)
      .map((r, i) => ({ rank: i + 1, ...r }));

    // fill symbols from Blockscout (one call each, cached)
    for (const r of tokens) {
      let sym = kv ? await kv('GET', 'trend:sym:' + r.address).catch(() => null) : null;
      if (!sym) {
        try { const info = await (await fetch(BS + '/api/v2/tokens/' + r.address)).json(); sym = info.symbol || (r.address.slice(0, 6) + '…'); }
        catch { sym = r.address.slice(0, 6) + '…'; }
        if (kv) kv('SET', 'trend:sym:' + r.address, sym).catch(() => {});
      }
      r.symbol = sym;
    }

    const payload = JSON.stringify({ updatedAt: latest, windowMin: Math.round(WINDOW_BLOCKS / 600), ethUsd, tokens });
    if (kv) { kv('SET', 'trend:cache', payload).catch(() => {}); kv('EXPIRE', 'trend:cache', String(CACHE_SEC)).catch(() => {}); }
    res.setHeader('x-cache', 'MISS');
    res.end(payload);
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: e.message, tokens: [] }));
  }
};
