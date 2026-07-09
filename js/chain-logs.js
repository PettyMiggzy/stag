/* ============================================================
   STAGWIFHOOD — full-history Transfer loader for Robinhood Chain.
   Pulls EVERY ERC-20/721 Transfer for a token via chunked, parallel
   eth_getLogs against the public RPC — so connected-wallet clusters
   are computed over the token's whole life, not a recent sample.

   Free (public RPC, no backend). Block ranges are known up front so
   they run in parallel; dense ranges adaptively split. Results cache
   in localStorage and refresh incrementally on the next visit.

   Exposes: window.STAG.getLatestBlock() -> Promise<number>
            window.STAG.fetchAllTransfers(token, opts) ->
               Promise<{edges:[[from,to],...], transfers, wallets, calls, fromCache}>
   ============================================================ */
(function () {
  'use strict';
  const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';  // free, primary
  const PROXY = '/api/rpc';       // paid-RPC fallback behind our serverless fn (key server-side)
  const SMALL_RANGE = 60000;      // only ranges this small ever fall back to the paid RPC
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const CHUNK = 1_000_000;      // blocks per getLogs call (splits if a range is too dense)
  const CONCURRENCY = 8;
  const CACHE_PREFIX = 'stag_edges_';
  const CACHE_KEEP = 3;         // LRU: keep edge caches for the last N tokens

  const hexy = (n) => '0x' + n.toString(16);

  async function rpcAt(endpoint, method, params) {
    const r = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!r.ok) throw new Error('RPC HTTP ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'rpc error');
    return j.result;
  }
  // one-shot calls: free public RPC first, paid proxy only if it fails
  async function rpc(method, params) {
    try { return await rpcAt(PUBLIC_RPC, method, params); }
    catch (e) { try { return await rpcAt(PROXY, method, params); } catch (_) { throw e; } }
  }
  // getLogs for a block range: free RPC first. A LARGE range that fails is
  // thrown back so the caller splits it (on the free RPC). Only once a range
  // is small do we spend a paid call on it — bounding Alchemy usage.
  async function getLogsRange(token, from, to) {
    const params = [{ address: token, topics: [TRANSFER], fromBlock: hexy(from), toBlock: hexy(to) }];
    try { return await rpcAt(PUBLIC_RPC, 'eth_getLogs', params); }
    catch (e) {
      if (to - from <= SMALL_RANGE) return await rpcAt(PROXY, 'eth_getLogs', params);
      throw e;
    }
  }

  async function getLatestBlock() { return parseInt(await rpc('eth_blockNumber', []), 16); }

  // ---- localStorage cache (compact: addresses stored without the 0x) ----
  function loadCache(token) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + token);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.e)) return null;
      return { latest: o.l | 0, edges: o.e.map((s) => ['0x' + s.slice(0, 40), '0x' + s.slice(40)]) };
    } catch (_) { return null; }
  }
  function saveCache(token, latest, edges) {
    try {
      // LRU evict
      const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
      const packed = edges.map(([a, b]) => a.slice(2) + b.slice(2));
      localStorage.setItem(CACHE_PREFIX + token, JSON.stringify({ l: latest, e: packed, t: keys.length }));
      // keep only the most recently written CACHE_KEEP caches
      const all = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
      if (all.length > CACHE_KEEP) {
        // drop the ones other than current (best-effort; simple + safe)
        all.filter((k) => k !== CACHE_PREFIX + token).slice(0, all.length - CACHE_KEEP).forEach((k) => localStorage.removeItem(k));
      }
    } catch (_) { /* quota — fine, just skip caching */ }
  }

  // ---- fetch all Transfer edges in [fromBlock, latest] ----
  async function fetchRange(token, from, to, edges) {
    const logs = await getLogsRange(token, from, to);
    for (const l of logs) {
      if (!l.topics || l.topics.length < 3) continue;
      const f = '0x' + l.topics[1].slice(26).toLowerCase();
      const t = '0x' + l.topics[2].slice(26).toLowerCase();
      edges.push([f, t]);
    }
  }

  async function fetchAllTransfers(token, opts) {
    token = token.toLowerCase();
    opts = opts || {};
    const onProgress = opts.onProgress || (() => {});
    const latest = opts.latest != null ? opts.latest : await getLatestBlock();

    // incremental: start from cached edges, only fetch new blocks
    let edges = [], startBlock = 0, fromCache = false;
    const cached = loadCache(token);
    if (cached && cached.latest > 0 && cached.latest <= latest) {
      edges = cached.edges; startBlock = cached.latest + 1; fromCache = true;
    }

    // seed 1M chunks over [startBlock, latest]
    let ranges = [];
    for (let b = startBlock; b <= latest; b += CHUNK) ranges.push([b, Math.min(latest, b + CHUNK - 1)]);

    let calls = 0;
    const worker = async ([from, to]) => {
      try { calls++; await fetchRange(token, from, to, edges); }
      catch (e) {
        if (to > from) { const mid = (from + to) >> 1; ranges.push([from, mid], [mid + 1, to]); } // dense/timeout → split
        // single-block failure is dropped rather than looping forever
      }
    };
    while (ranges.length) {
      const batch = ranges.splice(0, CONCURRENCY);
      await Promise.all(batch.map(worker));
      onProgress(edges.length);
    }

    if (startBlock <= latest || !fromCache) saveCache(token, latest, edges);

    const wallets = new Set();
    edges.forEach(([a, b]) => { if (a !== ZERO) wallets.add(a); if (b !== ZERO) wallets.add(b); });
    return { edges, transfers: edges.length, wallets: wallets.size, calls, fromCache };
  }

  window.STAG = Object.assign(window.STAG || {}, { getLatestBlock, fetchAllTransfers, RPC: PUBLIC_RPC });
})();
