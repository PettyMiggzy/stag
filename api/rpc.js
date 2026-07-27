/* ============================================================
   STAGWIFHOOD — RPC fallback proxy (Vercel serverless).

   The site talks to the FREE public Robinhood Chain RPC directly in the
   browser. This endpoint is only hit when a public-RPC call fails. It uses
   the SAME free public RPC upstream — NO paid provider — so it can never run
   up a bill. It still helps: a shared server IP dodges per-user rate limits,
   and a response cache dedupes bursts of identical reads.

   Guards:
     • read-only method allowlist (can't be used as a write/relay)
     • only forwards to Robinhood Chain (fixed upstream)
     • in-memory response cache (dedupes bursts of identical getLogs)
     • same-site Origin check (deters other sites from using it)

   No env var required. (Alchemy was removed — it was billing.) To re-enable a
   paid upstream later, add PAID_RPC_URL to `upstreams` below.
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

  // Backup path (the browser already tried the free public RPC and failed). We use ONLY the
  // FREE public RPC here — no paid provider — but the proxy still adds value: a server-side
  // response cache (dedupes getLogs bursts) and a single shared IP that dodges per-user rate
  // limits. Alchemy is intentionally NOT used (was running up a bill); to re-enable a paid
  // upstream later, set PAID_RPC_URL and add it to the front of `upstreams`.
  const upstreams = [PUBLIC_RPC];
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
