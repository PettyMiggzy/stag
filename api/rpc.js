/* ============================================================
   STAGWIFHOOD — RPC fallback proxy (Vercel serverless).

   The site talks to the FREE public Robinhood Chain RPC directly in the
   browser. This endpoint is only hit when a public-RPC call fails, so it
   keeps Alchemy usage (and cost) to a minimum. The paid key lives ONLY in
   the ALCHEMY_RPC_URL env var — it is never shipped to the browser.

   Cost guards:
     • read-only method allowlist (can't be used as a write/relay)
     • only forwards to Robinhood Chain (fixed upstream)
     • in-memory response cache (dedupes bursts of identical getLogs)
     • same-site Origin check (deters other sites from spending our quota)

   Set ALCHEMY_RPC_URL in Vercel → Project → Settings → Environment Variables.
   If it's unset, this safely falls back to the public RPC.
   ============================================================ */
'use strict';

const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const ALLOWED = new Set([
  'eth_getLogs', 'eth_blockNumber', 'eth_chainId', 'eth_call', 'eth_estimateGas',
  'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBalance', 'eth_getCode', 'eth_gasPrice', 'eth_getTransactionCount',
]);
const CACHE_TTL = 30_000;   // ms
const CACHE_MAX = 500;
const cache = new Map();    // key -> { t, body }

function allowedOrigin(req) {
  const o = (req.headers.origin || req.headers.referer || '').toLowerCase();
  if (!o) return true; // same-origin server-side / curl with no Origin
  return o.includes('stagwifhood') || o.includes('localhost') || o.includes('vercel.app');
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
  return await new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return; }
  if (!allowedOrigin(req)) { res.statusCode = 403; res.end(JSON.stringify({ error: 'forbidden' })); return; }

  const body = await readBody(req);
  const id = (body && body.id) || 1;
  if (!body || !ALLOWED.has(body.method)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not allowed' } }));
    return;
  }

  const key = JSON.stringify([body.method, body.params || []]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) {
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-cache', 'HIT');
    res.end(JSON.stringify(hit.body));
    return;
  }

  // This endpoint is the BACKUP path (the browser already tried the free public RPC and failed),
  // so prefer the PAID Alchemy RPC here, then fall back to the public RPC as a last resort.
  const upstreams = [process.env.ALCHEMY_RPC_URL, PUBLIC_RPC].filter(Boolean);
  let last = { jsonrpc: '2.0', id, error: { code: -32000, message: 'no upstream' } };
  for (const upstream of upstreams) {
    try {
      const r = await fetch(upstream, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: body.method, params: body.params || [] }),
      });
      const j = await r.json();
      // a JSON-RPC-level error is a valid response for this method — return it (don't try the next node)
      if (j && !j.error) {
        cache.set(key, { t: Date.now(), body: j });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // evict oldest
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-cache', 'MISS');
      res.end(JSON.stringify(j));
      return;
    } catch (e) { last = { jsonrpc: '2.0', id, error: { code: -32000, message: 'upstream error' } }; }
  }
  res.statusCode = 502;
  res.end(JSON.stringify(last));
};
