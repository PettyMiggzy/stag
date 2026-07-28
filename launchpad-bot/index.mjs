// ============================================================
//  HOOD ✕ CHANGE — buy bot (Robinhood Chain / EVM, chainId 4663)
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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
  launchpad: E("LAUNCHPAD_URL", "https://stagwifhood.fun/launchpad").replace(/\/$/, ""),
  token: E("TOKEN_ADDRESS").toLowerCase(),
  pool: E("POOL_ADDRESS").toLowerCase(),
  weth: E("WETH_ADDRESS").toLowerCase(),          // optional — measures ETH spent
  name: E("NAME"),                                 // optional label (else read on-chain)
  ticker: E("TICKER"),                             // optional label (else read on-chain)
  minBuyEth: parseFloat(E("MIN_BUY_ETH", "0")) || 0,
  ethUsd: parseFloat(E("ETH_USD", "0")) || 0,      // optional static ETH price for $ display
  emojiStepEth: parseFloat(E("EMOJI_STEP_ETH", "0.02")) || 0.02,
  buyEmoji: E("BUY_EMOJI", "🟩"),
  mediaUrl: E("MEDIA_URL"),                         // optional gif/image on each alert
  pollMs: Math.max(3000, parseInt(E("POLL_MS", "8000"), 10) || 8000),
  startBlock: parseInt(E("START_BLOCK", "0"), 10) || 0,
  tg: E("TELEGRAM_BOT_TOKEN"),
  tgChat: E("TELEGRAM_CHAT_ID"),
  discord: E("DISCORD_WEBHOOK_URL"),
};

const STATE_FILE = path.join(DIR, ".state.json");
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ERC20 = [
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
  } catch (e) { log("ethSpent err:", e.message); }
  return 0;
}

function buildAlert(b) {
  const steps = Math.max(1, Math.min(80, Math.floor((b.eth || 0) / CFG.emojiStepEth) || 1));
  const emojis = CFG.buyEmoji.repeat(steps);
  const priceEth = b.tokens > 0 && b.eth > 0 ? b.eth / b.tokens : 0;
  const priceUsd = CFG.ethUsd && priceEth ? priceEth * CFG.ethUsd : 0;
  const supply = Number(ethers.formatUnits(META.supply || 0n, META.decimals));
  const mcapUsd = priceUsd && supply ? priceUsd * supply : 0;
  const spentUsd = CFG.ethUsd && b.eth ? b.eth * CFG.ethUsd : 0;

  const txUrl = `${CFG.explorer}/tx/${b.tx}`;
  const buyerUrl = `${CFG.explorer}/address/${b.buyer}`;
  const chartUrl = `${CFG.launchpad}#/token/${CFG.token}`;

  return {
    emojis,
    priceUsd, priceEth, mcapUsd, spentUsd,
    txUrl, buyerUrl, chartUrl,
    ...b,
  };
}

async function sendTelegram(a) {
  if (!CFG.tg || !CFG.tgChat) return;
  const lines = [
    a.emojis,
    `<b>$${esc(META.symbol)} BUY!</b>`,
    `💵 ${fmt(a.eth, 4)} ETH${a.spentUsd ? ` (${usd(a.spentUsd)})` : ""}`,
    `🪙 ${fmt(a.tokens, 0)} ${esc(META.symbol)}`,
    `👤 <a href="${a.buyerUrl}">${short(a.buyer)}</a>`,
    a.priceUsd ? `📈 ${usd(a.priceUsd)}${a.mcapUsd ? ` · MCap ${usd(a.mcapUsd)}` : ""}` : "",
    `🔗 <a href="${a.txUrl}">Tx</a> · <a href="${a.chartUrl}">Chart</a>`,
  ].filter(Boolean);
  const text = lines.join("\n");
  try {
    if (CFG.mediaUrl) {
      await fetch(`https://api.telegram.org/bot${CFG.tg}/sendPhoto`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CFG.tgChat, photo: CFG.mediaUrl, caption: text, parse_mode: "HTML" }),
      });
    } else {
      await fetch(`https://api.telegram.org/bot${CFG.tg}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CFG.tgChat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
    }
  } catch (e) { log("tg send err:", e.message); }
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
    footer: { text: "HOOD ✕ CHANGE · Robinhood Chain" },
  };
  if (CFG.mediaUrl) embed.thumbnail = { url: CFG.mediaUrl };
  const body = {
    username: "HOOD ✕ CHANGE",
    embeds: [embed],
    components: [], // links go in the embed
  };
  // add a plain link line so it's clickable everywhere
  body.content = `[View tx](${a.txUrl}) · [Chart](${a.chartUrl})`;
  try {
    await fetch(CFG.discord, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { log("discord send err:", e.message); }
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

async function announce(raw) {
  const a = buildAlert(raw);
  log(`BUY ${fmt(a.eth, 4)} ETH → ${fmt(a.tokens, 0)} ${META.symbol} by ${short(a.buyer)}  ${a.txUrl}`);
  await Promise.all([sendTelegram(a), sendDiscord(a)]);
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
  for (const lg of logs) {
    const to = "0x" + (lg.topics[2] || "").slice(-40);
    const buyer = to.toLowerCase();
    if (buyer === CFG.pool || buyer === "0x0000000000000000000000000000000000000000") continue;
    const tokens = Number(ethers.formatUnits(BigInt(lg.data), META.decimals));
    if (tokens <= 0) continue;
    const eth = await ethSpent(lg.transactionHash);
    if (CFG.minBuyEth && eth < CFG.minBuyEth) continue;
    await announce({ buyer, tokens, eth, tx: lg.transactionHash, block: lg.blockNumber });
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
  const st = loadState();
  let last = st.lastBlock || CFG.startBlock || head; // default: start now (don't spam history)
  log(`starting at block ${last} (head ${head}); poll every ${CFG.pollMs}ms`);

  async function tick() {
    try {
      const h = await withTimeout(provider.getBlockNumber(), 12000, "RPC getBlockNumber");
      if (h > last) {
        // scan in chunks of 2000 to be RPC-friendly
        let from = last + 1;
        while (from <= h) {
          const to = Math.min(from + 1999, h);
          await scan(from, to);
          from = to + 1;
        }
        last = h;
        saveState({ lastBlock: last });
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
