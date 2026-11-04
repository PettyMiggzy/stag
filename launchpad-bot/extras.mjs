// Extras for the $STAG bot: commands, live pinned dashboard, bonding milestones, daily leaderboard, streaks, records.
// All numbers come from chain logs (ST) and the pool balance. Nothing here is invented.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export function initExtras(X) {
  const { provider, ethers, CFG, ST, fmt, usd, esc, short, log, DIR, BLOCKS_PER_DAY } = X;
  const api = `https://api.telegram.org/bot${CFG.tg}`;
  const chat = CFG.tgChat;
  const BOND = parseFloat(process.env.BOND_ETH || "4.2") || 4.2;
  const BLOCKS_10M = Math.round(BLOCKS_PER_DAY / 144);
  const tgPost = (method, body) => fetch(`${api}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
  const sendText = (text, extra = {}) => tgPost("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  const bar = (pct, n = 10) => { const f = Math.max(0, Math.min(n, Math.round((pct / 100) * n))); return "▰".repeat(f) + "▱".repeat(n - f); };
  const links = () => ({ inline_keyboard: [
    [{ text: "📈 Chart", url: CFG.chartUrl || `${CFG.launchpad}/${CFG.token}`, style: "primary" }, { text: "🟩 Buy $STAG", url: CFG.buyUrl || `${CFG.launchpad}/${CFG.token}`, style: "success" }],
    [{ text: "🏹 Play Stag Shot", url: "https://stagwifhood.fun/play/", style: "success" }, { text: "🎵 Records", url: "https://records.stagwifhood.fun", style: "primary" }],
  ] });

  // ---------- buyer lookup (cached) ----------
  const BUYER = new Map();
  async function buyerOf(tx) {
    if (BUYER.has(tx)) return BUYER.get(tx);
    try { const t = await provider.getTransaction(tx); const b = (t?.from || "").toLowerCase(); BUYER.set(tx, b); return b; } catch { return ""; }
  }
  async function prefetchDay(head) {
    const day = ST.buys.filter((b) => b.block > head - BLOCKS_PER_DAY);
    for (let i = 0; i < day.length; i += 6) await Promise.all(day.slice(i, i + 6).map((b) => buyerOf(b.tx)));
  }

  // ---------- market snapshot ----------
  async function market() {
    const head = await provider.getBlockNumber();
    const ethUsd = X.ethUsd();
    const supply = Number(ethers.formatUnits(X.META().supply || 0n, X.META().decimals)) || 1;
    const last = ST.buys[ST.buys.length - 1];
    const price = last ? last.eth / last.tok : 0;
    const dayAgo = head - BLOCKS_PER_DAY;
    const day = ST.buys.filter((b) => b.block > dayAgo);
    const before = [...ST.buys].reverse().find((b) => b.block <= dayAgo) || ST.buys[0];
    const first = before ? before.eth / before.tok : price;
    const hourAgo = [...ST.buys].reverse().find((b) => b.block <= head - BLOCKS_PER_DAY / 24) || ST.buys[0];
    const hp = hourAgo ? hourAgo.eth / hourAgo.tok : price;
    const bondEth = Number(ethers.formatEther(await provider.getBalance(CFG.pool)));
    const holders = [...ST.bal.entries()].filter(([a, v]) => v > 0n && a !== CFG.pool).length;
    return {
      head, price, priceUsd: price * ethUsd, mcUsd: price * supply * ethUsd, ethUsd,
      ch24: first ? (price / first - 1) * 100 : 0, ch1h: hp ? (price / hp - 1) * 100 : 0,
      buys24: day.length, vol24: day.reduce((x, b) => x + b.eth, 0), holders, bondEth, bondPct: Math.min(100, (bondEth / BOND) * 100),
      lastBlock: last?.block || 0, buys10m: ST.buys.filter((b) => b.block > head - BLOCKS_10M).length, vol10m: ST.buys.filter((b) => b.block > head - BLOCKS_10M).reduce((x, b) => x + b.eth, 0),
    };
  }
  const chg = (n) => `${n >= 0 ? "🟢 +" : "🔴 "}${fmt(n, 1)}%`;
  function marketText(m, title = "$STAG · LIVE") {
    const left = Math.max(0, BOND - m.bondEth);
    return [
      `<b>${title}</b>`,
      `💰 Price <b>${usd(m.priceUsd)}</b> · MC <b>${usd(m.mcUsd)}</b>`,
      `📊 1h ${chg(m.ch1h)} · 24h ${chg(m.ch24)}`,
      `🔥 24h: <b>${m.buys24}</b> buys · <b>${fmt(m.vol24, 2)} ETH</b>`,
      `⚡ Last 10 min: <b>${m.buys10m}</b> buys · <b>${fmt(m.vol10m, 2)} ETH</b>`,
      `👥 <b>${fmt(m.holders, 0)}</b> holders`,
      `🎯 Bonding <b>${fmt(m.bondEth, 2)} / ${fmt(BOND, 1)} ETH</b> (${fmt(m.bondPct, 1)}%)`,
      bar(m.bondPct, 12),
      m.bondPct < 100 ? `⏳ <b>${fmt(left, 2)} ETH</b> (~${usd(left * m.ethUsd)}) left to graduate` : `🎓 <b>GRADUATED</b>`,
    ].join("\n");
  }

  // ---------- leaderboard / streaks ----------
  async function dayBuyers(head) {
    await prefetchDay(head);
    const map = new Map();
    for (const b of ST.buys.filter((x) => x.block > head - BLOCKS_PER_DAY)) {
      const w = BUYER.get(b.tx); if (!w) continue; const e = map.get(w) || { eth: 0, n: 0, tok: 0 }; e.eth += b.eth; e.n++; e.tok += b.tok; map.set(w, e);
    }
    return [...map.entries()].sort((a, b) => b[1].eth - a[1].eth);
  }
  async function leaderboardText(title) {
    const head = await provider.getBlockNumber(); const m = await market(); const rows = await dayBuyers(head);
    if (!rows.length) return `<b>${title}</b>\nNo buys in the last 24h yet. Be the first. 🦌`;
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const lines = rows.slice(0, 5).map(([w, e], i) => `${medals[i]} <a href="${CFG.explorer}/address/${w}">${short(w)}</a> · <b>${fmt(e.eth, 3)} ETH</b> (${usd(e.eth * m.ethUsd)}) · ${e.n} buy${e.n > 1 ? "s" : ""}`);
    return [`<b>${title}</b>`, ...lines, "", `24h volume <b>${fmt(m.vol24, 2)} ETH</b> · <b>${m.buys24}</b> buys · <b>${fmt(m.holders, 0)}</b> holders`].join("\n");
  }
  async function streakFor(buyer, block) {
    await prefetchDay(block);
    return ST.buys.filter((b) => b.block > block - BLOCKS_PER_DAY && b.block <= block && BUYER.get(b.tx) === buyer.toLowerCase()).length;
  }
  function biggestBefore(tx, block) {
    let max = 0; for (const b of ST.buys) if (b.tx !== tx && b.block <= block && b.eth > max) max = b.eth; return max;
  }
  function holderRank(addr) { // 1 = biggest holder
    const arr = [...ST.bal.entries()].filter(([a, v]) => v > 0n && a !== CFG.pool).sort((a, b) => (b[1] > a[1] ? 1 : -1));
    const i = arr.findIndex(([a]) => a === addr.toLowerCase()); return i < 0 ? 0 : i + 1;
  }
  // extra card info for one buy
  async function cardExtras(tx, block, buyer, eth) {
    const out = {};
    try {
      const n = await streakFor(buyer, block); if (n >= 2) out.streak = n;
      const prevMax = biggestBefore(tx, block); if (eth >= 0.05 && eth > prevMax && prevMax > 0) out.record = true;
      out.holderCount = [...ST.bal.entries()].filter(([a, v]) => v > 0n && a !== CFG.pool).length;
      out.rank = holderRank(buyer);
      const head = await provider.getBlockNumber();
      out.buys10m = ST.buys.filter((b) => b.block > head - BLOCKS_10M).length;
    } catch {}
    return out;
  }

  // ---------- commands ----------
  let offset = 0;
  async function handle(msg) {
    const text = (msg.text || "").trim(); if (!text.startsWith("/")) return;
    const [raw, ...args] = text.split(/\s+/); const cmd = raw.slice(1).split("@")[0].toLowerCase();
    const reply = (t, extra = {}) => tgPost("sendMessage", { chat_id: msg.chat.id, text: t, parse_mode: "HTML", disable_web_page_preview: true, reply_parameters: { message_id: msg.message_id }, reply_markup: links(), ...extra });
    try {
      if (["price", "mc", "stats", "stag", "p"].includes(cmd)) return reply(marketText(await market()));
      if (cmd === "bonding" || cmd === "grad") { const m = await market(); return reply(`🎯 <b>Bonding</b> ${fmt(m.bondEth, 2)} / ${fmt(BOND, 1)} ETH (${fmt(m.bondPct, 1)}%)\n${bar(m.bondPct, 12)}\n⏳ ${fmt(Math.max(0, BOND - m.bondEth), 2)} ETH (~${usd(Math.max(0, BOND - m.bondEth) * m.ethUsd)}) left to graduate`); }
      if (cmd === "holders") { const m = await market(); return reply(`👥 <b>${fmt(m.holders, 0)}</b> holders of $STAG`); }
      if (cmd === "top" || cmd === "leaderboard") return reply(await leaderboardText("🏆 TOP BUYERS · 24H"));
      if (cmd === "last") { const m = await market(); const l = ST.buys[ST.buys.length - 1]; return reply(l ? `🕒 Last buy: <b>${fmt(l.eth, 3)} ETH</b> (${usd(l.eth * m.ethUsd)}) · ${fmt((m.head - l.block) / (BLOCKS_PER_DAY / 86400), 0)}s ago · <a href="${CFG.explorer}/tx/${l.tx}">Tx</a>` : "No buys yet."); }
      if (cmd === "me") {
        const a = (args[0] || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return reply("Use: <code>/me 0xYourWallet</code>");
        const v = ST.bal.get(a) || 0n; const m = await market(); const bal = Number(ethers.formatUnits(v, X.META().decimals)); const rank = holderRank(a);
        return reply(bal > 0 ? `👛 <b>${short(a)}</b>\nHolds <b>${fmt(bal, 0)}</b> $STAG (${usd(bal * m.priceUsd)})\nRank <b>#${rank}</b> of ${fmt(m.holders, 0)} holders` : `👛 ${short(a)} holds no $STAG yet.`);
      }
      if (cmd === "song") { const c = X.CLIPS(); if (!c.length) return; const k = c[Math.floor(Math.random() * c.length)]; return X.sendSong(msg.chat.id, k, msg.message_id); }
      if (cmd === "help" || cmd === "start") return reply("<b>$STAG bot</b>\n/price · /mc · /stats – live market\n/bonding – progress to graduation\n/holders – holder count\n/top – top buyers (24h)\n/last – last buy\n/me 0x… – look up a wallet\n/song – play a Winslow Bankz clip");
    } catch (e) { log("cmd err:", e.message); }
  }
  async function pollCommands() {
    for (;;) {
      try {
        const r = await fetch(`${api}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`).then((x) => x.json());
        for (const u of r.result || []) { offset = u.update_id + 1; if (u.message) handle(u.message); }
      } catch (e) { await new Promise((r) => setTimeout(r, 3000)); }
    }
  }

  // ---------- pinned live dashboard ----------
  let dashId = 0;
  async function updateDashboard() {
    try {
      const text = marketText(await market(), "$STAG · LIVE DASHBOARD") + `\n\n<i>updates every hour</i>`;
      if (!dashId) {
        const c = await tgPost("getChat", { chat_id: chat });
        const pm = c.result?.pinned_message; if (pm?.from?.is_bot && pm.text?.includes("LIVE DASHBOARD")) dashId = pm.message_id;
      }
      if (dashId) {
        const r = await tgPost("editMessageText", { chat_id: chat, message_id: dashId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: links() });
        if (r.ok || /not modified/i.test(r.description || "")) return;
        dashId = 0;
      }
      const s = await sendText(text, { reply_markup: links(), disable_notification: true });
      if (s.ok) { dashId = s.result.message_id; await tgPost("pinChatMessage", { chat_id: chat, message_id: dashId, disable_notification: true }); }
    } catch (e) { log("dash err:", e.message); }
  }

  // ---------- milestones ----------
  const TIERS = [25, 50, 75, 90, 100];
  let lastTier = -1; let lastHolderMs = 0;
  async function watchMilestones() {
    try {
      const m = await market();
      const tier = TIERS.filter((t) => m.bondPct >= t).length;
      if (lastTier < 0) { lastTier = tier; lastHolderMs = [100, 250, 500, 1000, 2500, 5000].filter((h) => m.holders >= h).length; return; }
      if (tier > lastTier) {
        lastTier = tier; const t = TIERS[tier - 1];
        const head = t >= 100 ? "🎓🚀 <b>$STAG HAS GRADUATED!</b>" : `🚨 <b>$STAG IS ${t}% BONDED!</b>`;
        await X.sendVideoCard(`${head}\n\n${marketText(m, "STATUS")}`, links());
      }
      const hs = [100, 250, 500, 1000, 2500, 5000].filter((h) => m.holders >= h).length;
      if (hs > lastHolderMs) { lastHolderMs = hs; const h = [100, 250, 500, 1000, 2500, 5000][hs - 1]; await sendText(`🦌 <b>${fmt(h, 0)} HOLDERS!</b> The herd is growing.\n\n${marketText(m, "$STAG")}`, { reply_markup: links() }); }
    } catch (e) { log("milestone err:", e.message); }
  }

  // ---------- daily leaderboard (00:00 UTC) ----------
  let lastDay = new Date().toISOString().slice(0, 10);
  async function dailyCheck() {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== lastDay) { lastDay = d; try { await sendText(await leaderboardText("🏆 DAILY TOP BUYERS · $STAG"), { reply_markup: links() }); } catch (e) { log("daily err:", e.message); } }
  }

  async function start(head) {
    await prefetchDay(head);
    if (process.env.COMMANDS !== "0") pollCommands();
    updateDashboard(); setInterval(updateDashboard, 3600000);
    watchMilestones(); setInterval(watchMilestones, 30000);
    setInterval(dailyCheck, 60000);
    log("extras ready: commands, dashboard, milestones, leaderboard");
  }
  return { start, cardExtras, market, leaderboardText };
}
