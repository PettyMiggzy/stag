/* ============================================================
   Sherwood Market — Telegram alert engine (shared lib).

   Dependency-free (raw JSON-RPC + Upstash Redis REST + Telegram Bot API).
   No npm packages, no build step — matches the rest of the site's serverless.

   ENV (set in Vercel → Settings → Environment Variables):
     TELEGRAM_BOT_TOKEN   from @BotFather
     TELEGRAM_CHANNEL_ID  public channel to post to (e.g. @stagmarket or -100123...)
     KV_REST_API_URL      Upstash Redis REST URL   (Vercel KV integration)
     KV_REST_API_TOKEN    Upstash Redis REST token
     CRON_SECRET          any random string — guards the /poll endpoint
     WHALE_ETH            optional; ETH-priced trade >= this = 🐋 (default 0.1)
     SITE                 optional; default https://stagwifhood.fun
   ============================================================ */
'use strict';

const MARKET = '0xa113238953b660230bF97237A2cc9b9f48Fe06A6';
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const ETH = '0x0000000000000000000000000000000000000000';
// Use the canonical www host in all outbound links — the apex 308-redirects here, and some
// mobile DNS resolvers fail on the apex even when www resolves fine.
const SITE = process.env.SITE || 'https://www.stagwifhood.fun';

// event topic0 (keccak256 of the signatures)
const T = {
  created:   '0x87fe93d79d983fe0c58212e2b0ffef6a47b3d30067aae73d04d7136301ac32d2',
  filled:    '0x7bb215d1c9c5ea6e380a9dd71f9b389efa1a23bc95fa628c98dfedba9b6f71a5',
  cancelled: '0x61b9399f2f0f32ca39ce8d7be32caed5ec22fe07a6daba3a467ed479ec606582',
};

/* ---------------- JSON-RPC ---------------- */
async function rpc(method, params) {
  const r = await fetch(PUBLIC_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + (j.error.message || 'rpc error'));
  return j.result;
}
const toBig = (hex) => BigInt(hex);
const addrFromWord = (w) => '0x' + w.slice(26); // last 20 bytes (40 hex) of a 32-byte word ('0x'+64hex)
const word = (data, i) => '0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64);

/* ---------------- token metadata (cached) ---------------- */
async function ethCall(to, selector) {
  try { return await rpc('eth_call', [{ to, data: selector }, 'latest']); }
  catch { return '0x'; }
}
function decodeString(ret) {
  if (!ret || ret === '0x' || ret.length < 130) {
    // maybe a bytes32-style symbol (non-standard older tokens)
    if (ret && ret.length >= 66) {
      const raw = ret.slice(2, 66).replace(/(00)+$/, '');
      try { return Buffer.from(raw, 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '') || null; } catch { return null; }
    }
    return null;
  }
  try {
    const len = Number(BigInt('0x' + ret.slice(66, 130)));
    const bytes = ret.slice(130, 130 + len * 2);
    return Buffer.from(bytes, 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '');
  } catch { return null; }
}
async function tokenMeta(kv, token) {
  const t = token.toLowerCase();
  if (t === ETH) return { symbol: 'ETH', decimals: 18 };
  const cached = await kv('GET', 'mkt:tok:' + t);
  if (cached) { try { return JSON.parse(cached); } catch {} }
  const symRet = await ethCall(token, '0x95d89b41'); // symbol()
  const decRet = await ethCall(token, '0x313ce567'); // decimals()
  const symbol = decodeString(symRet) || (t.slice(0, 6) + '…');
  let decimals = 18;
  try { const d = Number(BigInt(decRet || '0x12')); if (d >= 0 && d <= 36) decimals = d; } catch {}
  const meta = { symbol, decimals };
  await kv('SET', 'mkt:tok:' + t, JSON.stringify(meta));
  return meta;
}
function fmtAmount(raw, decimals) {
  const neg = raw < 0n; if (neg) raw = -raw;
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  let frac = (raw % base).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + w + (frac ? '.' + frac : '');
}

/* ---------------- Upstash Redis REST ---------------- */
// kv('SET','k','v') / kv('GET','k') / kv('SADD','set','m') / kv('SMEMBERS','set') / kv('SREM'...)
async function kvFactory() {
  // Accept whatever the Vercel/Upstash integration names them — no manual aliasing needed.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL;
  const tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;
  if (!url || !tok) throw new Error('KV not configured (add the Upstash Redis / Vercel KV store)');
  return async (...cmd) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
      body: JSON.stringify(cmd.map(String)),
    });
    const j = await r.json();
    if (j.error) throw new Error('kv: ' + j.error);
    return j.result;
  };
}

/* ---------------- Telegram ---------------- */
function tgFactory() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  return async (chatId, text, extra = {}) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML',
        disable_web_page_preview: true, ...extra,
      }),
    });
    return r.json();
  };
}

module.exports = {
  MARKET, PUBLIC_RPC, ETH, SITE, T,
  rpc, toBig, addrFromWord, word, tokenMeta, fmtAmount,
  kvFactory, tgFactory,
};
