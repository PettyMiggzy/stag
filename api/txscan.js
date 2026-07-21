/* ============================================================
   STAGWIFHOOD — GoPlus pre-sign transaction scan (Vercel serverless).

   The browser sends an UNSIGNED tx {chainId, from, to, data, value}; this
   endpoint asks GoPlus to simulate it and returns a simple verdict the UI
   can show BEFORE the user signs (a "scanned safe" badge, or a warning).

   • The GoPlus API key lives ONLY in the GOPLUS_API_KEY env var — never shipped
     to the browser.  Set it in Vercel → Project → Settings → Environment Variables.
   • FAILS OPEN: if the key is unset, GoPlus errors, or times out, this returns
     { scanned:false } so a mint/stake is NEVER blocked by the scanner.
   • Robinhood Chain (4663) is on GoPlus's supported-chains list.
   ============================================================ */
'use strict';

const GOPLUS_URL = 'https://api.gopluslabs.io/api/v1/transaction_simulation';

function allowedOrigin(req) {
  const o = (req.headers.origin || req.headers.referer || '').toLowerCase();
  if (!o) return true;
  return o.includes('stagwifhood') || o.includes('localhost') || o.includes('vercel.app');
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
  return await new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

// Heuristic verdict from GoPlus's result — schema-tolerant, tuned to only flag on
// STRONG signals so a legit mint is never falsely warned. Refine once we see live shapes.
function assess(result) {
  if (!result || typeof result !== 'object') return { risky: false, level: 'unknown', reasons: [] };
  const reasons = []; let risky = false;
  (function walk(o, path) {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      const kl = k.toLowerCase();
      const strong = kl.includes('malicious') || kl.includes('attack') || kl.includes('phishing') ||
        kl.includes('honeypot') || kl.includes('scam') || kl.includes('fraud') ||
        kl === 'risky_transaction' || kl === 'is_risk';
      if (strong) {
        const bad = v === true || v === 1 || v === '1' || (Array.isArray(v) && v.length > 0) ||
          (typeof v === 'string' && /high|danger|malicious|phish|scam|fraud|honeypot|true|yes/i.test(v) && !/none|safe|^no$|low|^0$/i.test(v));
        if (bad) { risky = true; reasons.push((path ? path + '.' : '') + k); }
      }
      if (v && typeof v === 'object') walk(v, (path ? path + '.' : '') + k);
    }
  })(result, '');
  return { risky, level: risky ? 'warning' : 'ok', reasons: reasons.slice(0, 6) };
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ scanned: false, reason: 'POST only' })); return; }
  if (!allowedOrigin(req)) { res.statusCode = 403; res.end(JSON.stringify({ scanned: false, reason: 'forbidden' })); return; }

  const key = process.env.GOPLUS_API_KEY;
  const body = (await readBody(req)) || {};
  const { chainId, from, to, data, value } = body;
  // fail OPEN — the UI treats scanned:false as "just proceed"
  if (!key) { res.end(JSON.stringify({ scanned: false, reason: 'not configured' })); return; }
  if (!to) { res.end(JSON.stringify({ scanned: false, reason: 'no tx' })); return; }

  try {
    const r = await fetch(GOPLUS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
      body: JSON.stringify({
        chain_id: String(chainId || 4663),
        from: from || '0x0000000000000000000000000000000000000000',
        to, data: data || '0x', value: String(value || '0'),
      }),
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || (typeof j.code !== 'undefined' && j.code !== 1 && j.code !== 0)) {
      res.end(JSON.stringify({ scanned: false, reason: (j && j.message) || ('http ' + r.status) }));
      return;
    }
    const result = j.result || j.data || j;
    res.end(JSON.stringify({ scanned: true, ...assess(result) }));
  } catch (e) {
    res.end(JSON.stringify({ scanned: false, reason: 'scan unavailable' }));
  }
};
