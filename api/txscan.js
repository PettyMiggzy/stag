/* ============================================================
   STAGWIFHOOD — GoPlus address-security pre-sign guard (Vercel serverless).

   Before a user signs, the browser sends the tx recipient; this endpoint asks
   GoPlus whether that address is flagged (phishing / blacklist / sanctioned /
   cybercrime / honeypot …) and returns a simple verdict for a "scanned safe"
   badge or a warning.

   • FREE + KEYLESS: uses GoPlus's public address_security API, which supports
     Robinhood Chain (4663). No API key, no signup. (GoPlus's transaction_simulation
     endpoint only covers ETH/BSC/Base, so it can't be used for 4663.)
   • Our OWN contracts are whitelisted → the guard can never false-block a real
     mint/stake/claim.
   • FAILS OPEN: any error/timeout → { scanned:false } and the tx proceeds.
   ============================================================ */
'use strict';

// STAG's own known-good contracts — always safe, never scanned (mirror js/hooded-config.js).
const OWN = new Set([
  '0x4384cb362d908d36266bdf3c31f18db95eb127dc', // HoodedTwenty
  '0x2faa6672546912e7cdec4e1aacf1eef52ba524ff', // StagStaking
  '0x1f6d791108635ac4522b1cfad86fd7b435adfe2a', // RevenueSplitter
  '0xc36662d2db9432702f018963abdab19432aa488b', // SherwoodPact
  '0x5c309bc7d137ca4c5ac450b68d1a1d896ef28327', // SherwoodSaints
  '0x101a344172f15abe969027ea06624305f4a63082', // SaintsSplitter
  '0x9eee6efe6540c3e3ac515d052c99ad4b389a344c', // SherwoodVault
  '0x35c57109217319df9fef0499f56b3f6a68d50931', // SherwoodWanted
  '0x5b0038579c066447bc23ad7819d77fbc9cf146da', // WantedBounty
  '0x6dfb9800864bd483ffe17052b28e9a50ee81b6e7', // SherwoodMarket
  '0xd43d5aa252077d0cfd2cfdcd13f9b8e85c5c1392', // SherwoodSwap
  '0x689988a1adb3da7554ba1ffc256904498aaf1f54', // SherwoodOrders
  '0xcC142366735c882F7885d3c747db99e45E13E453', // $STAG token
]);

// address_security fields that are a REAL red flag when "1" (skip soft/noisy ones).
const RISK = {
  blacklist_doubt: 'on a blacklist',
  phishing_activities: 'linked to phishing',
  sanctioned: 'sanctioned address',
  cybercrime: 'linked to cybercrime',
  money_laundering: 'linked to money laundering',
  financial_crime: 'linked to financial crime',
  darkweb_transactions: 'darkweb activity',
  stealing_attack: 'linked to a stealing attack',
  blackmail_activities: 'linked to blackmail',
  malicious_mining_activities: 'malicious mining',
  honeypot_related_address: 'honeypot-related',
  fake_token: 'fake token',
  fake_kyc: 'fake KYC',
};

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

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ scanned: false, reason: 'POST only' })); return; }
  if (!allowedOrigin(req)) { res.statusCode = 403; res.end(JSON.stringify({ scanned: false, reason: 'forbidden' })); return; }

  const body = (await readBody(req)) || {};
  const to = (body.to || '').toLowerCase();
  const chainId = String(body.chainId || 4663);
  if (!to || !/^0x[0-9a-f]{40}$/.test(to)) { res.end(JSON.stringify({ scanned: false, reason: 'no address' })); return; }
  if (OWN.has(to)) { res.end(JSON.stringify({ scanned: true, risky: false, level: 'ok', reasons: [], own: true })); return; }

  try {
    const r = await fetch('https://api.gopluslabs.io/api/v1/address_security/' + to + '?chain_id=' + encodeURIComponent(chainId),
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.code !== 1 || !j.result) { res.end(JSON.stringify({ scanned: false, reason: (j && j.message) || ('http ' + r.status) })); return; }
    const reasons = [];
    for (const [field, label] of Object.entries(RISK)) {
      const v = j.result[field];
      if (v === '1' || v === 1 || v === true) reasons.push(label);
    }
    const risky = reasons.length > 0;
    res.end(JSON.stringify({ scanned: true, risky, level: risky ? 'warning' : 'ok', reasons: reasons.slice(0, 6) }));
  } catch (e) {
    res.end(JSON.stringify({ scanned: false, reason: 'scan unavailable' }));
  }
};
