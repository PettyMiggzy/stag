// ============================================================
//  $STAG — buy bot (Robinhood Chain / EVM, chainId 4663)
//  ------------------------------------------------------------
//  Watches a token's liquidity pool for BUYS and posts an alert
//  to Telegram and/or Discord. A "buy" = the token leaving the
//  pool to a wallet (Transfer where from == POOL).
//
//  Post targets (set either, both, or neither):
//    • Telegram : TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//    • Discord  : DISCORD_WEBHOOK_URL
//
//  No private keys. Read-only. Runs anywhere Node 18+ runs.
// ============================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { initExtras } from "./extras.mjs";
import { startTeamBuyer } from "./teambuyer.mjs";
let EX = null;

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- tiny .env loader (no dependency) ----
try {
  for (const line of readFileSync(path.join(DIR, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch { /* rely on real env */ }

// ethers is the only external dependency — if it's missing, say so plainly instead of
// dumping a module-not-found stack trace.
let ethers;
try {
  ({ ethers } = await import("ethers"));
} catch {
  console.error("\n✖ Missing dependency 'ethers'.\n  In the launchpad-bot folder run:  npm install\n  then start the bot again.\n");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Reject if a promise (e.g. a hung RPC call) doesn't settle in time, so we can retry instead of freeze.
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

const E = (k, d = "") => (process.env[k] ?? d).toString().trim();

const CFG = {
  rpcHttp: E("RPC_HTTP", "https://rpc.mainnet.chain.robinhood.com"),
  rpcWs: E("RPC_WS"),
  explorer: E("EXPLORER", "https://robinhoodchain.blockscout.com").replace(/\/$/, ""),
  launchpad: E("LAUNCHPAD_URL", "https://robinhoodchain.blockscout.com/token").replace(/\/$/, ""),
  token: E("TOKEN_ADDRESS").toLowerCase(),
  pool: E("POOL_ADDRESS").toLowerCase(),
  weth: E("WETH_ADDRESS").toLowerCase(),          // optional — measures ETH spent
  name: E("NAME"),                                 // optional label (else read on-chain)
  ticker: E("TICKER"),                             // optional label (else read on-chain)
  minBuyEth: parseFloat(E("MIN_BUY_ETH", "0")) || 0,
  ethUsd: parseFloat(E("ETH_USD", "0")) || 0,      // optional static ETH price for $ display
  emojiStepEth: parseFloat(E("EMOJI_STEP_ETH", "0.02")) || 0.02,
  buyEmoji: E("BUY_EMOJI", "🟩"),
  mediaUrl: E("MEDIA_URL"),
  videoFile: E("VIDEO_FILE", "buy.mp4"),
  chartUrl: E("CHART_URL"), buyUrl: E("BUY_URL"),
  links: E("EXTRA_BUTTONS", "🏹 Play Stag Shot|https://stagwifhood.fun/play/|success;🎵 Stag House Records|https://records.stagwifhood.fun|primary;🌐 stagwifhood.fun|https://stagwifhood.fun|danger"),                         // optional gif/image on each alert
  pollMs: Math.max(3000, parseInt(E("POLL_MS", "8000"), 10) || 8000),
  startBlock: parseInt(E("START_BLOCK", "0"), 10) || 0,
  tg: E("TELEGRAM_BOT_TOKEN"),
  tgChat: E("TELEGRAM_CHAT_ID"),
  discord: E("DISCORD_WEBHOOK_URL"),
};

const STATE_FILE = path.join(DIR, ".state.json");
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "?");
const fmt = (n, d = 2) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });
const usd = (n) => {
  n = Number(n || 0);
  if (n >= 1e9) return "$" + fmt(n / 1e9, 2) + "B";
  if (n >= 1e6) return "$" + fmt(n / 1e6, 2) + "M";
  if (n >= 1e3) return "$" + fmt(n / 1e3, 2) + "K";
  if (n >= 1) return "$" + fmt(n, 2);
  return "$" + n.toPrecision(3);
};

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
if (!isAddr(CFG.token) || !isAddr(CFG.pool)) {
  console.error(
    "\n✖ Missing/invalid config. Create launchpad-bot/.env (copy .env.example) and set:\n" +
    "    TOKEN_ADDRESS=0x…   (the coin's contract, 42 chars)\n" +
    "    POOL_ADDRESS=0x…    (its liquidity pool)\n" +
    `  Got: TOKEN_ADDRESS='${CFG.token || ""}'  POOL_ADDRESS='${CFG.pool || ""}'\n`
  );
  process.exit(1);
}
if (!CFG.tg && !CFG.discord) {
  log("WARN: no TELEGRAM_* and no DISCORD_WEBHOOK_URL set — alerts will only print to console.");
}

const provider = new ethers.JsonRpcProvider(CFG.rpcHttp, undefined, { staticNetwork: true });
const token = new ethers.Contract(CFG.token, ERC20, provider);

let META = { name: CFG.name, symbol: CFG.ticker, decimals: 18, supply: 0n };

let ETHUSD = CFG.ethUsd;
async function refreshEthUsd() {
  try {
    const r = await withTimeout(fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"), 8000, "price");
    const j = await r.json(); if (j?.ethereum?.usd) ETHUSD = j.ethereum.usd;
  } catch {}
}
setInterval(refreshEthUsd, 300000); refreshEthUsd();

async function loadMeta() {
  try {
    const [sym, nm, dec, sup] = await Promise.all([
      CFG.ticker ? Promise.resolve(CFG.ticker) : token.symbol().catch(() => "TOKEN"),
      CFG.name ? Promise.resolve(CFG.name) : token.name().catch(() => "Token"),
      token.decimals().catch(() => 18),
      token.totalSupply().catch(() => 0n),
    ]);
    META = { name: nm, symbol: sym, decimals: Number(dec), supply: sup };
    log(`watching $${META.symbol} (${META.name}) — token ${short(CFG.token)} pool ${short(CFG.pool)}`);
  } catch (e) { log("meta load failed, using defaults:", e.message); }
}

// Last scanned block is also kept in the database, so a rebuild or an outage never loses buys: on restart the bot resumes from there and posts what it missed.
let DBQ = null;
try { if (process.env.DATABASE_URL) { const { neon } = await import("@neondatabase/serverless"); const sql = neon(process.env.DATABASE_URL); DBQ = (q, a = []) => sql.query(q, a); await DBQ("create table if not exists bot_state(k text primary key, v text not null, updated_at timestamptz default now())"); } } catch (e) { console.error("db state off:", e.message); DBQ = null; }
const dbGetLast = async () => { try { const [r] = await DBQ("select v from bot_state where k='lastBlock'"); return r ? parseInt(r.v, 10) : 0; } catch { return 0; } };
const dbSetLast = async (n) => { try { await DBQ("insert into bot_state(k,v) values('lastBlock',$1) on conflict(k) do update set v=excluded.v, updated_at=now()", [String(n)]); } catch (e) { log("db state save fail:", e.message); } };
// One-time catch-up after the 2026-11-05 outage (last alert posted before it was ~block 106661119). Used only when the database has no saved block yet.
const ONE_TIME_CATCHUP_BLOCK = 106661119;
let CUR_HEAD = 0;
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(s) { try { writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { log("state save fail:", e.message); } }

// ---- ETH spent in a buy tx: sum WETH transfers into the pool, else tx.value ----
async function ethSpent(txHash) {
  try {
    const rc = await provider.getTransactionReceipt(txHash);
    if (CFG.weth && rc?.logs) {
      let wei = 0n;
      const poolTopic = ethers.zeroPadValue(CFG.pool, 32).toLowerCase();
      for (const lg of rc.logs) {
        if (lg.address.toLowerCase() !== CFG.weth) continue;
        if (lg.topics[0] !== TRANSFER_TOPIC) continue;
        if ((lg.topics[2] || "").toLowerCase() !== poolTopic) continue; // to == pool
        wei += BigInt(lg.data);
      }
      if (wei > 0n) return Number(ethers.formatEther(wei));
    }
    const tx = await provider.getTransaction(txHash);
    if (tx?.value) return Number(ethers.formatEther(tx.value));
    // Paid via an aggregator / other asset: read the ETH amount from the pool's own swap event
    if (rc?.logs) for (const lg of rc.logs) {
      if (lg.address.toLowerCase() === CFG.pool && lg.topics[0] === "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455" && lg.data.length >= 66) return Number(ethers.formatEther(BigInt(lg.data.slice(0, 66))));
    }
  } catch (e) { log("ethSpent err:", e.message); }
  return 0;
}

// Custom (3D) emoji: set EMOJI_STAG / EMOJI_CANDLE / EMOJI_COIN to the custom_emoji_id from our sticker set.
const em = (key, fallback) => { const id = process.env["EMOJI_" + key]; return id ? `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` : fallback; };
function buildAlert(b) {
  const steps = Math.max(1, Math.min(80, Math.floor((b.eth || 0) / CFG.emojiStepEth) || 1));
  const usdIn = ETHUSD && b.eth ? b.eth * ETHUSD : 0;
  const stagSteps = Math.max(1, Math.min(30, Math.floor(usdIn / 25) || 1));
  const emojis = em("STAG", "🦌").repeat(stagSteps);
  const tier = usdIn >= 1000 ? "🚨🐋 MEGA WHALE BUY" : usdIn >= 500 ? "🐋 WHALE BUY" : usdIn >= 100 ? "🔥 BIG BUY" : "";
  const priceEth = b.tokens > 0 && b.eth > 0 ? b.eth / b.tokens : 0;
  const priceUsd = ETHUSD && priceEth ? priceEth * ETHUSD : 0;
  const supply = Number(ethers.formatUnits(META.supply || 0n, META.decimals));
  const mcapUsd = priceUsd && supply ? priceUsd * supply : 0;
  const spentUsd = ETHUSD && b.eth ? b.eth * ETHUSD : 0;

  const txUrl = `${CFG.explorer}/tx/${b.tx}`;
  const buyerUrl = `${CFG.explorer}/address/${b.buyer}`;
  const chartUrl = `${CFG.launchpad}/${CFG.token}`;   // robinhoodchain.blockscout.com/token/<CA> — buy + chart

  return {
    emojis, tier,
    priceUsd, priceEth, mcapUsd, spentUsd,
    txUrl, buyerUrl, chartUrl,
    ...b,
  };
}

let VIDEO_ID = null;
const VIDEO_IDS = {};
let CLIPS = []; let CLIP_N = Math.floor(Math.random() * 8);
try { CLIPS = readFileSync(path.join(DIR, "clips", "titles.txt"), "utf8").split("\n").filter(Boolean).map((l) => { const [n, ...t] = l.split("|"); return { n, title: t.join("|") }; }); } catch {}
const SLUGS = ["","backongo","crown","heartbreak","money","nomellames","ridinslow","walkfire","whitetee"];
function buttons(a, clip) {
  const rows = [[
    { text: "Chart", url: CFG.chartUrl || a.chartUrl, style: "primary", ...(process.env.EMOJI_COIN ? { icon_custom_emoji_id: process.env.EMOJI_COIN } : {}) },
    { text: "Buy $STAG", url: CFG.buyUrl || a.chartUrl, style: "success", ...(process.env.EMOJI_STAG ? { icon_custom_emoji_id: process.env.EMOJI_STAG } : {}) },
  ]];
  for (const part of CFG.links.split(";")) {
    const [text, url, style] = part.split("|"); if (text && url) rows.push([{ text: text.trim(), url: url.trim(), ...(style ? { style: style.trim() } : {}) }]);
  }
  return { inline_keyboard: rows };
}
// A real Telegram music player under each alert: tap play in the chat, plays in the background, no web page.
const AUDIO_IDS = {};
async function sendSongReply(api, clip, replyTo, chatId = CFG.tgChat) {
  if (process.env.AUDIO_REPLY === "0") return;
  const f = path.join(DIR, "audio", clip.n + ".mp3");
  try {
    let res;
    if (AUDIO_IDS[clip.n]) {
      res = await fetch(`${api}/sendAudio`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, audio: AUDIO_IDS[clip.n], title: clip.title, performer: "Winslow Bankz · Stag House Records", reply_parameters: { message_id: replyTo }, disable_notification: true }) });
    } else if (existsSync(f)) {
      const fd = new FormData();
      fd.append("chat_id", chatId); fd.append("title", clip.title); fd.append("performer", "Winslow Bankz · Stag House Records");
      fd.append("duration", "40"); fd.append("disable_notification", "true");
      fd.append("reply_parameters", JSON.stringify({ message_id: replyTo }));
      fd.append("audio", new Blob([readFileSync(f)], { type: "audio/mpeg" }), `${clip.title}.mp3`);
      const tf = path.join(DIR, "thumbs", clip.n + ".jpg");
      if (existsSync(tf)) fd.append("thumbnail", new Blob([readFileSync(tf)], { type: "image/jpeg" }), "cover.jpg");
      res = await fetch(`${api}/sendAudio`, { method: "POST", body: fd });
    } else return;
    const j = await res.json();
    if (j.ok) { const id = j.result?.audio?.file_id; if (id) AUDIO_IDS[clip.n] = id; } else log("tg audio err:", j.description);
  } catch (e) { log("tg audio send err:", e.message); }
}
// ---- Entrance card: a holder's own animated NFT plays as the alert when their wallet buys (Telegram autoplays muted video, so the visual does the work) ----
// Collections: Hooded 20 (h), WANTED (w), Sherwood Saints (s). A wallet that holds several rotates through them, rarest first.
const NFT_COLS = [
  { k: "h", addr: process.env.HOODED_NFT || "0x4384cB362D908d36266bDF3C31F18DB95EB127dc", n: 20, label: "Hooded 20", em: "🏹" },
  { k: "w", addr: "0x35c57109217319Df9feF0499F56b3f6a68d50931", n: 21, label: "WANTED", em: "🤠" },
  { k: "s", addr: "0x5c309bC7D137cA4c5AC450B68D1A1d896eF28327", n: 5, label: "Sherwood Saint", em: "😇" },
];
const SAINTS_VAULT = "0x9eeE6eFe6540C3e3AC515D052c99ad4b389a344c";
let NFT_META = {}; try { NFT_META = JSON.parse(readFileSync(path.join(DIR, "nft", "collections.json"), "utf8")); } catch {}
let NFT_OWNERS = new Map(); const ANIM_IDS = {}; const NFT_ROT = new Map();
const RARITY = ["Mythic", "Legendary", "Saint", "Epic", "Rare", "Uncommon", "Common"];
const vaultStakers = new Map(); let vaultFrom = 20000000; // Saints sit inside the Vault while staked: the staker is whoever sent it
async function scanVaultStakers() {
  try {
    const head = await provider.getBlockNumber(); const pad = "0x" + SAINTS_VAULT.slice(2).toLowerCase().padStart(64, "0");
    while (vaultFrom <= head) {
      const to = Math.min(vaultFrom + 9000000, head);
      const ls = await provider.send("eth_getLogs", [{ address: NFT_COLS[2].addr, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", null, pad], fromBlock: "0x" + vaultFrom.toString(16), toBlock: "0x" + to.toString(16) }]);
      for (const l of ls) vaultStakers.set(parseInt(l.topics[3], 16), ("0x" + l.topics[1].slice(-40)).toLowerCase());
      vaultFrom = to + 1;
    }
  } catch (e) { log("vault stakers err:", e.message); }
}
async function refreshHooded() {
  try {
    const m = new Map(); await scanVaultStakers();
    for (const col of NFT_COLS) {
      const c = new ethers.Contract(col.addr, ["function ownerOf(uint256) view returns (address)"], provider);
      for (let id = 1; id <= col.n; id++) {
        try {
          let o = (await c.ownerOf(id)).toLowerCase();
          if (o === SAINTS_VAULT.toLowerCase()) o = vaultStakers.get(id) || "";
          if (!o) continue;
          if (!m.has(o)) m.set(o, []); m.get(o).push({ k: col.k, id });
        } catch {}
      }
    }
    NFT_OWNERS = m; log(`nft holders: ${m.size} wallets`);
  } catch (e) { log("nft refresh err:", e.message); }
}
const nftRank = (x) => { const r = RARITY.indexOf(NFT_META[x.k]?.[x.id]?.rarity); return (r < 0 ? 99 : r) * 1000 + NFT_COLS.findIndex((c) => c.k === x.k) * 100 + x.id; };
function pickNft(addr) { // rotate through this wallet's NFTs so the alert isn't always the same one
  const list = NFT_OWNERS.get((addr || "").toLowerCase()); if (!list || !list.length) return null;
  const sorted = [...list].sort((x, y) => nftRank(x) - nftRank(y)); const i = NFT_ROT.get(addr.toLowerCase()) || 0; NFT_ROT.set(addr.toLowerCase(), i + 1);
  const x = sorted[i % sorted.length]; const col = NFT_COLS.find((c) => c.k === x.k); return { ...x, col, key: `${x.k}${x.id}`, meta: NFT_META[x.k]?.[x.id] || {} };
}
const SONG_REPLY = process.env.SONG_REPLY === "1"; // the separate 'tap to play' song message after each buy: off unless SONG_REPLY=1
async function sendTelegram(a) {
  if (!CFG.tg || !CFG.tgChat) return;
  const sym = esc(META.symbol);
  const pk = pickNft(a.buyer);
  const holdLine = a.holds ? `👛 Holds ${fmt(a.holds, 0)} ${sym}${a.holdsUsd ? ` (${usd(a.holdsUsd)})` : ""} · ${a.isNew ? "🆕 <b>New holder</b>" : `Position <b>+${fmt(a.posPct, 0)}%</b>`}` : "";
  const lines = [
    process.env.ALERT_TAG ? `<b>🧪 ${esc(process.env.ALERT_TAG)}</b>` : "",
    a.late ? `<i>⏪ Posted late: the bot was offline when this buy happened</i>` : "",
    a.ex?.record ? `<b>🏆 NEW BIGGEST BUY</b>` : "",
    a.ex?.herd ? `<b>${a.ex.herd}</b> just bought` : "",
    pk ? `${pk.col.em} <b>${pk.col.label} #${pk.id} · ${esc(pk.meta.title || "")}</b>${pk.meta.rarity ? ` (${esc(pk.meta.rarity)})` : ""} enters the forest` : "",
    a.tier ? `<b>${a.tier}</b>` : "",
    `<b>$${sym} · BUY</b>`,
    `${em("COIN", "💵")} <b>${a.spentUsd ? usd(a.spentUsd) : ""}</b> · ${fmt(a.eth, 4)} ETH`,
    `${em("CANDLE", "🟩")} Got <b>${fmt(a.tokens, 0)}</b> ${sym}`,
    a.emojis,
    a.priceUsd ? `Price <b>${usd(a.priceUsd)}</b>${a.mcapUsd ? ` · MC <b>${usd(a.mcapUsd)}</b>` : ""}` : "",
    holdLine,
    a.bondEth != null ? (() => {
      const goal = parseFloat(process.env.BOND_ETH || "4.2") || 4.2;
      const pct = Math.max(0, Math.min(100, a.bondEth / goal * 100)); const f = Math.round(pct / 10);
      return `🎯 Bonding: <b>${fmt(a.bondEth, 2)} / ${fmt(goal, 1)} ETH</b> (${fmt(pct, 1)}%)\n${"▰".repeat(f)}${"▱".repeat(10 - f)}`;
    })() : "",
    a.bondEth != null && a.bondEth < (parseFloat(process.env.BOND_ETH || "4.2") || 4.2) ? `⏳ <b>${fmt(Math.max(0, (parseFloat(process.env.BOND_ETH || "4.2") || 4.2) - a.bondEth), 2)} ETH</b> left to graduate` : "",
    a.ex?.buys10m >= 3 ? `⚡ <b>${a.ex.buys10m}</b> buys in the last 10 min` : "",
    a.ex?.streak ? `🔁 <b>${a.ex.streak}${a.ex.streak === 2 ? "nd" : a.ex.streak === 3 ? "rd" : "th"} buy today</b> from this wallet` : "",
    a.isNew && a.ex?.holderCount ? `🆕 Holder <b>#${a.ex.holderCount}</b>` : "",
    a.st && a.st.mult >= 1.005 ? `📈 <b>${a.st.mult >= 10 ? fmt(a.st.mult, 0) : fmt(a.st.mult, 2)}x</b> from launch price` : "",
    a.st ? `🔥 24h: <b>${a.st.buys24}</b> buys · <b>${fmt(a.st.vol24, 2)} ETH</b> volume · Buy <b>#${a.st.buyNo}</b>` : "",
    a.st ? `👥 <b>${fmt(a.st.holderCount, 0)}</b> holders` : "",
    `👤 <a href="${a.buyerUrl}">${short(a.buyer)}</a> · <a href="${a.txUrl}">Tx</a>`,
  ].filter(Boolean);
  // rotate through the album: each buy plays a different Winslow Bankz clip
  let clip = null;
  if (CLIPS.length) { clip = CLIPS[CLIP_N % CLIPS.length]; CLIP_N++; lines.splice(lines.length - 1, 0, `🎵 Now playing: <b>${esc(clip.title)}</b> · Winslow Bankz`); }
  const caption = lines.join("\n");
  const api = `https://api.telegram.org/bot${CFG.tg}`;
  const vfile = clip ? path.join(DIR, "clips", clip.n + ".mp4") : path.join(DIR, CFG.videoFile);
  const vid = clip ? VIDEO_IDS[clip.n] : VIDEO_ID;
  try {
    if (pk) {
      const af = path.join(DIR, "nft", `${pk.key}.mp4`);
      if (ANIM_IDS[pk.key] || existsSync(af)) {
        try {
          let res;
          if (ANIM_IDS[pk.key]) res = await fetch(`${api}/sendAnimation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CFG.tgChat, animation: ANIM_IDS[pk.key], caption, parse_mode: "HTML", reply_markup: buttons(a, clip) }) });
          else { const fd = new FormData(); fd.append("chat_id", CFG.tgChat); fd.append("caption", caption); fd.append("parse_mode", "HTML"); fd.append("reply_markup", JSON.stringify(buttons(a, clip))); fd.append("animation", new Blob([readFileSync(af)], { type: "video/mp4" }), `${pk.key}.mp4`); res = await fetch(`${api}/sendAnimation`, { method: "POST", body: fd }); }
          const j = await res.json();
          if (j.ok) { const fid = j.result?.animation?.file_id || j.result?.video?.file_id; if (fid) ANIM_IDS[pk.key] = fid; if (clip && SONG_REPLY) await sendSongReply(api, clip, j.result.message_id); return; }
          log("tg animation err:", j.description);
        } catch (e) { log("tg animation send err:", e.message); }
      }
    }
    if (vid || existsSync(vfile)) {
      let res;
      if (vid) {
        res = await fetch(`${api}/sendVideo`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: CFG.tgChat, video: vid, caption, parse_mode: "HTML", reply_markup: buttons(a, clip) }) });
      } else {
        const fd = new FormData();
        fd.append("chat_id", CFG.tgChat); fd.append("caption", caption); fd.append("parse_mode", "HTML");
        fd.append("reply_markup", JSON.stringify(buttons(a, clip))); fd.append("supports_streaming", "true");
        fd.append("video", new Blob([readFileSync(vfile)], { type: "video/mp4" }), "buy.mp4");
        res = await fetch(`${api}/sendVideo`, { method: "POST", body: fd });
      }
      const j = await res.json();
      if (j.ok) {
        const fid = j.result?.video?.file_id; if (fid) { if (clip) VIDEO_IDS[clip.n] = fid; else VIDEO_ID = fid; }
        if (clip && SONG_REPLY) await sendSongReply(api, clip, j.result.message_id);
        return;
      }
      log("tg video err:", j.description);
    }
    if (CFG.mediaUrl) {
      await fetch(`${api}/sendPhoto`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CFG.tgChat, photo: CFG.mediaUrl, caption, parse_mode: "HTML", reply_markup: buttons(a, clip) }) });
    } else {
      await fetch(`${api}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CFG.tgChat, text: caption, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: buttons(a, clip) }) });
    }
  } catch (e) { log("tg send err:", e.message); if ((a._tries = (a._tries || 0) + 1) < 4) { await sleep(3000 * a._tries); return sendTelegram(a); } log("tg send gave up:", a.tx); }
}

async function sendDiscord(a) {
  if (!CFG.discord) return;
  const fields = [
    { name: "Spent", value: `${fmt(a.eth, 4)} ETH${a.spentUsd ? ` (${usd(a.spentUsd)})` : ""}`, inline: true },
    { name: "Got", value: `${fmt(a.tokens, 0)} ${META.symbol}`, inline: true },
    { name: "Buyer", value: `[${short(a.buyer)}](${a.buyerUrl})`, inline: true },
  ];
  if (a.priceUsd) fields.push({ name: "Price", value: usd(a.priceUsd), inline: true });
  if (a.mcapUsd) fields.push({ name: "Market cap", value: usd(a.mcapUsd), inline: true });
  const embed = {
    title: `🟩 $${META.symbol} BUY!`,
    url: a.chartUrl,
    description: a.emojis,
    color: 0x7db38f,
    fields,
    footer: { text: "$STAG · Robinhood Chain" },
  };
  if (CFG.mediaUrl) embed.thumbnail = { url: CFG.mediaUrl };
  const body = {
    username: "$STAG",
    embeds: [embed],
    components: [], // links go in the embed
  };
  // add a plain link line so it's clickable everywhere
  body.content = `[View tx](${a.txUrl}) · [Buy](${a.chartUrl})`;
  try {
    await fetch(CFG.discord, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { log("discord send err:", e.message); }
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

async function announce(raw) {
  const a = buildAlert(raw);
  log(`BUY ${fmt(a.eth, 4)} ETH → ${fmt(a.tokens, 0)} ${META.symbol} by ${short(a.buyer)}  ${a.txUrl}`);
  await Promise.all([sendTelegram(a), sendDiscord(a)]);
  if (a.late) await sleep(4000); // catching up: stay well under Telegram's per-group rate limit
}


// ---- on-chain stats (holders, top-10, 24h volume, price multiple) built from logs; idempotent ----
const CURVE_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
const BLOCKS_PER_DAY = parseInt(E("BLOCKS_PER_DAY", "830000"), 10);
const STATS_FROM = parseInt(E("STATS_FROM_BLOCK", "105516351"), 10);
const ST = { bal: new Map(), seen: new Set(), buys: [], firstPrice: 0, first: new Map(), out: new Map() };
function ingestTransfer(lg) {
  const k = lg.transactionHash + ":" + lg.index; if (ST.seen.has(k)) return; ST.seen.add(k);
  const from = ("0x" + lg.topics[1].slice(-40)).toLowerCase(), to = ("0x" + lg.topics[2].slice(-40)).toLowerCase(), v = BigInt(lg.data);
  if (from !== "0x0000000000000000000000000000000000000000") ST.bal.set(from, (ST.bal.get(from) || 0n) - v);
  ST.bal.set(to, (ST.bal.get(to) || 0n) + v);
  if (!ST.first.has(to)) ST.first.set(to, lg.blockNumber);
  if (from !== CFG.pool && from !== "0x0000000000000000000000000000000000000000") ST.out.set(from, lg.blockNumber);
}
function ingestBuy(lg) {
  const k = "b" + lg.transactionHash + ":" + lg.index; if (ST.seen.has(k)) return; ST.seen.add(k);
  const eth = Number(ethers.formatEther(BigInt("0x" + lg.data.slice(2, 66)))), tok = Number(ethers.formatUnits(BigInt("0x" + lg.data.slice(66, 130)), 18));
  if (eth > 0 && tok > 0) { ST.buys.push({ block: lg.blockNumber, tx: lg.transactionHash, eth, tok }); if (!ST.firstPrice) ST.firstPrice = eth / tok; }
}
async function ingestRange(from, to) {
  try {
    const [tl, bl] = await Promise.all([
      provider.getLogs({ address: CFG.token, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: to }),
      provider.getLogs({ address: CFG.pool, topics: [CURVE_BUY], fromBlock: from, toBlock: to }),
    ]);
    tl.forEach(ingestTransfer); bl.forEach(ingestBuy);
  } catch (e) { log("ingest err:", e.message); }
}
async function backfillStats(head) {
  for (let f = STATS_FROM; f <= head; f += 5000) await ingestRange(f, Math.min(f + 4999, head));
  log(`stats ready: ${ST.buys.length} buys, ${ST.bal.size} wallets`);
}
function statsFor(tx, block, price) {
  const dayAgo = block - BLOCKS_PER_DAY;
  const day = ST.buys.filter((b) => b.block > dayAgo && b.block <= block && !(EX && EX.isTeam(b.tx)));
  const idx = day.findIndex((b) => b.tx === tx);
  const holders = [...ST.bal.entries()].filter(([a, v]) => v > 0n && a !== CFG.pool);
  const sup = Number(ethers.formatUnits(META.supply || 0n, META.decimals)) || 1;
  const top = holders.map(([, v]) => Number(ethers.formatUnits(v, META.decimals))).sort((a, b) => b - a).slice(0, 10).reduce((x, y) => x + y, 0);
  return {
    buys24: day.length, vol24: day.reduce((x, b) => x + b.eth, 0), buyNo: idx >= 0 ? idx + 1 : day.length,
    holderCount: holders.length, top10: top / sup * 100,
    mult: ST.firstPrice && price ? price / ST.firstPrice : 0,
  };
}

// ---- scan a block range for buys (Transfer from == pool) ----
async function scan(fromBlock, toBlock) {
  const poolTopic = ethers.zeroPadValue(CFG.pool, 32).toLowerCase();
  let logs = [];
  try {
    logs = await provider.getLogs({
      address: CFG.token,
      topics: [TRANSFER_TOPIC, poolTopic], // from == pool
      fromBlock, toBlock,
    });
  } catch (e) {
    // some RPCs cap range; split on failure
    if (toBlock > fromBlock) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      await scan(fromBlock, mid); await scan(mid + 1, toBlock); return;
    }
    log("getLogs err:", e.message); return;
  }
  await ingestRange(fromBlock, toBlock);
  // One alert per transaction. On Pons the pool pays the token to a router, which forwards it to the buyer,
  // so the "to" of the pool transfer is the router - the real buyer is the wallet that sent the tx.
  const seen = new Set();
  for (const lg of logs) {
    if (seen.has(lg.transactionHash)) continue;
    seen.add(lg.transactionHash);
    let tx;
    try { tx = await provider.getTransaction(lg.transactionHash); } catch { tx = null; }
    const buyer = (tx?.from || "0x" + (lg.topics[2] || "").slice(-40)).toLowerCase();
    if (buyer === CFG.pool || buyer === "0x0000000000000000000000000000000000000000") continue;
    // tokens the buyer actually received in this tx (sum of token transfers to the buyer, else the pool outflow)
    let tokens = 0;
    try {
      const rc = await provider.getTransactionReceipt(lg.transactionHash);
      const buyerTopic = ethers.zeroPadValue(buyer, 32).toLowerCase();
      for (const l2 of rc.logs) {
        if (l2.address.toLowerCase() !== CFG.token || l2.topics[0] !== TRANSFER_TOPIC) continue;
        if ((l2.topics[2] || "").toLowerCase() === buyerTopic) tokens += Number(ethers.formatUnits(BigInt(l2.data), META.decimals));
      }
    } catch {}
    if (tokens <= 0) tokens = Number(ethers.formatUnits(BigInt(lg.data), META.decimals));
    if (tokens <= 0) continue;
    const eth = await ethSpent(lg.transactionHash);
    if (CFG.minBuyEth && eth < CFG.minBuyEth) continue;
    let holds = 0, posPct = 0, isNew = false;
    try {
      const bal = await token.balanceOf(buyer, { blockTag: lg.blockNumber });
      holds = Number(ethers.formatUnits(bal, META.decimals));
      const prior = holds - tokens;
      if (prior <= tokens * 0.001) isNew = true; else posPct = tokens / prior * 100;
    } catch {}
    // Pons bonding curve: the pool's ETH balance is the ETH raised so far; it graduates at BOND_ETH (4.2).
    let bondEth = null;
    try { bondEth = Number(ethers.formatEther(await provider.getBalance(CFG.pool))); } catch {}
    const px = tokens > 0 && eth > 0 && ETHUSD ? (eth / tokens) * ETHUSD : 0;
    const ex = EX ? await EX.cardExtras(lg.transactionHash, lg.blockNumber, buyer, eth) : {};
    await announce({ buyer, tokens, eth, holds, posPct, isNew, ex, holdsUsd: px * holds, bondEth, st: statsFor(lg.transactionHash, lg.blockNumber, tokens > 0 && eth > 0 ? eth / tokens : 0), tx: lg.transactionHash, block: lg.blockNumber, late: CUR_HEAD && CUR_HEAD - lg.blockNumber > 6000 });
  }
}

// Wait for the RPC to answer, retrying with backoff — never crash on a boot-time hiccup.
async function connectRpc() {
  for (let attempt = 1; ; attempt++) {
    try { return await withTimeout(provider.getBlockNumber(), 12000, "RPC getBlockNumber"); }
    catch (e) {
      const wait = Math.min(60, 2 ** attempt);
      log(`RPC not reachable yet (${e.shortMessage || e.code || e.message}); retry in ${wait}s — ${CFG.rpcHttp}`);
      await sleep(wait * 1000);
    }
  }
}

async function main() {
  const head = await connectRpc();   // blocks (with retries) until the chain answers
  await loadMeta();
  refreshHooded(); setInterval(refreshHooded, 600000);
  await backfillStats(head);
  if (process.env.EXTRAS !== "0" && CFG.tg && CFG.tgChat) {
    EX = initExtras({ provider, ethers, CFG, ST, fmt, usd, esc, short, log, DIR, BLOCKS_PER_DAY,
      META: () => META, ethUsd: () => ETHUSD, CLIPS: () => CLIPS,
      sendSong: (chatId, clip, replyTo) => sendSongReply(`https://api.telegram.org/bot${CFG.tg}`, clip, replyTo, chatId),
      sendVideoCard: async (caption, markup, clipN) => {
        const clip = clipN ? (CLIPS.find((c) => c.n === clipN) || null) : CLIPS.length ? CLIPS[CLIP_N++ % CLIPS.length] : null; const api = `https://api.telegram.org/bot${CFG.tg}`;
        const f = clip ? (clipN === "9" && existsSync(path.join(DIR, "wyteboyz.mp4")) ? path.join(DIR, "wyteboyz.mp4") : path.join(DIR, "clips", clip.n + ".mp4")) : null; // clip 9 announcements use the full WYTE BOYZ video
        if (f && existsSync(f)) {
          const fd = new FormData(); fd.append("chat_id", CFG.tgChat); fd.append("caption", caption); fd.append("parse_mode", "HTML"); fd.append("reply_markup", JSON.stringify(markup));
          fd.append("video", new Blob([readFileSync(f)], { type: "video/mp4" }), "stag.mp4"); const j = await fetch(`${api}/sendVideo`, { method: "POST", body: fd }).then((r) => r.json()).catch(() => null); if (clipN && j && j.ok) await sendSongReply(api, clip, j.result.message_id); // announcements get the song player (with its cover) under the video, like buy alerts
        } else await fetch(`${api}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: CFG.tgChat, text: caption, parse_mode: "HTML", reply_markup: markup }) });
      } });
    EX.start(head).catch((e) => log("extras start err:", e.message));
    try { const team = startTeamBuyer({ provider, CFG, ST, log, ethUsd: () => ETHUSD, BLOCKS_PER_DAY, buyerCached: (tx) => EX.buyerCached(tx) }); if (team) EX.setTeam(team); } catch (e) { log("team buyer init err:", e.message); }
  }
  const st = loadState();
  let dbLast = DBQ ? await dbGetLast() : 0;
  if (DBQ && !dbLast && !CFG.startBlock && !st.lastBlock) { dbLast = ONE_TIME_CATCHUP_BLOCK; await dbSetLast(dbLast); log(`one-time catch-up: scanning from block ${dbLast}`); }
  let last = dbLast || st.lastBlock || CFG.startBlock || head; // default: start now (don't spam history)
  let lastDbSave = 0;
  log(`starting at block ${last} (head ${head}); poll every ${CFG.pollMs}ms`);

  async function tick() {
    try {
      const h = await withTimeout(provider.getBlockNumber(), 12000, "RPC getBlockNumber");
      if (h > last) {
        CUR_HEAD = h;
        // scan in chunks of 2000 to be RPC-friendly
        let from = last + 1;
        while (from <= h) {
          const to = Math.min(from + 1999, h);
          await scan(from, to);
          from = to + 1;
          if (DBQ && Date.now() - lastDbSave > 20000) { lastDbSave = Date.now(); await dbSetLast(to); }
        }
        last = h;
        saveState({ lastBlock: last }); if (DBQ) { lastDbSave = Date.now(); await dbSetLast(last); }
      }
    } catch (e) { log("tick err:", e.message); }
    setTimeout(tick, CFG.pollMs);
  }
  tick();
}

// Don't let a stray async error (a dropped fetch, a bad RPC response) kill the bot — log and keep running.
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => log("uncaughtException:", e?.message || e));

main().catch((e) => { log("startup error, retrying in 10s:", e?.message || e); setTimeout(() => main(), 10000); });
