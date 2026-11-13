// Extras for the $STAG bot: commands, live pinned dashboard, bonding milestones, daily leaderboard, streaks, records.
// All numbers come from chain logs (ST) and the pool balance. Nothing here is invented.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { initWhale } from "./whale.mjs";
import { initBurn } from "./burn.mjs";
import { initStagme } from "./stagme.mjs";

export function initExtras(X) {
  const { provider, ethers, CFG, ST, fmt, usd, esc, short, log, DIR, BLOCKS_PER_DAY } = X;
  const api = `https://api.telegram.org/bot${CFG.tg}`;
  const chat = CFG.tgChat;
  const BOND = parseFloat(process.env.BOND_ETH || "4.2") || 4.2;
  const BUY = CFG.buyUrl || `${CFG.launchpad}/${CFG.token}`;
  const BLOCKS_10M = Math.round(BLOCKS_PER_DAY / 144);
  const tgPost = (method, body) => fetch(`${api}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
  const sendText = (text, extra = {}) => tgPost("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  const bar = (pct, n = 10) => { const f = Math.max(0, Math.min(n, Math.round((pct / 100) * n))); return "▰".repeat(f) + "▱".repeat(n - f); };
  const links = () => ({ inline_keyboard: [
    [{ text: "Chart", url: CFG.chartUrl || `${CFG.launchpad}/${CFG.token}`, style: "primary", ...(process.env.EMOJI_COIN ? { icon_custom_emoji_id: process.env.EMOJI_COIN } : {}) }, { text: "Buy $STAG", url: CFG.buyUrl || `${CFG.launchpad}/${CFG.token}`, style: "success", ...(process.env.EMOJI_STAG ? { icon_custom_emoji_id: process.env.EMOJI_STAG } : {}) }],
    [{ text: "🏹 Play Stag Shot", url: process.env.MINIAPP_URL || "https://stagwifhood.fun/play/", style: "success" }, { text: "🎵 Records", url: "https://records.stagwifhood.fun", style: "primary" }],
  ] });

  const API = { h: null };
  const W = initWhale({ CFG, ST, fmt, short, log, tgPost, ethUsd: X.ethUsd, api: API });
  // ---------- buyer lookup (cached) ----------
  const BUYER = new Map();
  let TEAM = "";
  const EP = new Set(["0x0000000071727de22e5e9d8baf0edac6f37da032", "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "0x4337084d9e255ff0702461cf8895ce9e3b5ff108"]); // ERC-4337 EntryPoint contracts
  // ---------- dev buyback alerts ----------
  // The dev wallets are saved from the owner's bot DM (/setdev) into the database: never in the code, the repo or a post.
  // Alerts stay OFF until the owner approves a draft (/buybackdraft, then /buyback on).
  let DEVS = new Set(), TEAMS = new Set(), DEVOWN = new Set(), BB_ON = false, bbLast = null; // TEAMS: wallets the owner labelled as team wallets (kept in the database, never in the code)
  const bbQ = (s, p) => W.q(s, p).catch(() => []);
  async function bbLoad() {
    await bbQ("create table if not exists bot_state(k text primary key, v text not null, updated_at timestamptz default now())");
    await bbQ("create table if not exists dev_buys(tx text primary key, eth double precision not null, tok double precision not null, at timestamptz not null default now())");
    const rows = await bbQ("select k, v from bot_state where k in ('devWallets','buybackOn','teamWallets','devOwnWallets')"); const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
    try { TEAMS = new Set(JSON.parse(m.teamWallets || "[]").map((x) => String(x).toLowerCase())); } catch { TEAMS = new Set(); }
    try { DEVOWN = new Set(JSON.parse(m.devOwnWallets || "[]").map((x) => String(x).toLowerCase())); } catch { DEVOWN = new Set(); }
    DEVS = new Set((m.devWallets || "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x))); BB_ON = m.buybackOn === "1";
    const [l] = await bbQ("select eth, tok, extract(epoch from at)::bigint as ts from dev_buys order by at desc limit 1"); bbLast = l ? { eth: Number(l.eth), tok: Number(l.tok), ts: Number(l.ts) } : null;
  }
  const bbWeek = async () => { const [w] = await bbQ("select count(*)::int as n, coalesce(sum(eth),0) as eth, coalesce(sum(tok),0) as tok from dev_buys where at > now() - interval '7 days'"); return { n: w ? w.n : 0, eth: w ? Number(w.eth) : 0, tok: w ? Number(w.tok) : 0 }; };
  function bbCaption(a, wk, draft) {
    return [draft ? "<i>DRAFT with sample numbers. Not posted anywhere. Send /buyback on here to switch the alerts on.</i>\n" : "",
      "🦌🔥 <b>DEV BUYBACK</b> 🔥🦌", `💵 <b>${a.spentUsd ? usd(a.spentUsd) : ""}</b> · ${fmt(a.eth, 4)} ETH`, `🟩 Bought <b>${fmt(a.tokens, 0)}</b> $STAG off the market`,
      wk && wk.n ? `📅 Last 7 days: <b>${wk.n}</b> buyback${wk.n === 1 ? "" : "s"} · <b>${fmt(wk.eth, 3)} ETH</b> · <b>${fmt(wk.tok, 0)}</b> $STAG` : "",
      a.priceUsd ? `Price <b>${usd(a.priceUsd)}</b>${a.mcapUsd ? ` · MC <b>${usd(a.mcapUsd)}</b>` : ""}` : "",
      `👤 Dev wallet${a.txUrl ? ` · <a href="${a.txUrl}">Tx</a>` : ""}`].filter(Boolean).join("\n");
  }
  async function bbSend(to, caption) {
    try {
      const f = path.join(DIR, "buyback.mp4"); const markup = JSON.stringify({ inline_keyboard: [[{ text: "Buy $STAG", url: BUY, style: "success" }]] });
      if (!existsSync(f)) { const r = await tgPost("sendMessage", { chat_id: to, text: caption, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: JSON.parse(markup) }); return !!(r && r.ok); }
      const fd = new FormData(); fd.append("chat_id", String(to)); fd.append("caption", caption); fd.append("parse_mode", "HTML"); fd.append("reply_markup", markup);
      fd.append("video", new Blob([readFileSync(f)], { type: "video/mp4" }), "buyback.mp4");
      const r = await (await fetch(`${api}/sendVideo`, { method: "POST", body: fd })).json(); if (!r.ok) log("buyback send err:", r.description); return !!r.ok;
    } catch (e) { log("buyback send err:", e.message); return false; }
  }
  // every dev buy in the last 24 hours as one card. Reads the chain history the bot already holds, so it also covers buys from before the wallet was saved.
  async function bbToday(to, draft) {
    const head = await provider.getBlockNumber(); const day = ST.buys.filter((b) => b.block > head - BLOCKS_PER_DAY);
    for (let i = 0; i < day.length; i += 6) await Promise.all(day.slice(i, i + 6).map((b) => buyerOf(b.tx)));
    const mine = day.filter((b) => DEVS.has(String(BUYER.get(b.tx) || "").toLowerCase())); if (!mine.length) return 0;
    const secs = 86400 / BLOCKS_PER_DAY;
    for (const b of mine) await bbQ("insert into dev_buys(tx, eth, tok, at) values ($1,$2,$3, now() - ($4::text || ' seconds')::interval) on conflict do nothing", [b.tx, b.eth || 0, b.tok || 0, String(Math.max(0, Math.round((head - b.block) * secs)))]);
    const eth = mine.reduce((x, b) => x + (b.eth || 0), 0), tok = mine.reduce((x, b) => x + (b.tok || 0), 0); const m = await market();
    const cap = [draft ? "<i>DRAFT. Not posted anywhere. Send /buybacktoday post here to post it to the main group.</i>\n" : "",
      "🦌🔥 <b>DEV BUYBACKS · LAST 24 HOURS</b> 🔥🦌", `🟩 <b>${mine.length}</b> buyback${mine.length === 1 ? "" : "s"}`, `💵 <b>${m.ethUsd ? usd(eth * m.ethUsd) : ""}</b> · ${fmt(eth, 4)} ETH`, `🪙 <b>${fmt(tok, 0)}</b> $STAG bought off the market`,
      m.priceUsd ? `Price <b>${usd(m.priceUsd)}</b>${m.mcUsd ? ` · MC <b>${usd(m.mcUsd)}</b>` : ""}` : "", "👤 Dev wallet"].filter(Boolean).join("\n");
    const [l] = await bbQ("select eth, tok, extract(epoch from at)::bigint as ts from dev_buys order by at desc limit 1"); if (l) bbLast = { eth: Number(l.eth), tok: Number(l.tok), ts: Number(l.ts) }; tokAt = 0;
    return (await bbSend(to, cap)) ? mine.length : -1;
  }
  // called for every buy card: true = this was a dev buyback and its own card went out, so the normal card is skipped
  async function sendBuyback(a) {
    try {
      if (!DEVS.has(String(a.buyer || "").toLowerCase())) return false;
      const tx = String(a.txUrl || "").split("/").pop();
      await bbQ("insert into dev_buys(tx, eth, tok) values ($1,$2,$3) on conflict do nothing", [tx, a.eth || 0, a.tokens || 0]); bbLast = { eth: a.eth || 0, tok: a.tokens || 0, ts: Math.floor(Date.now() / 1000) }; tokAt = 0;
      if (!BB_ON || a.late) return false;
      return await bbSend(chat, bbCaption(a, await bbWeek(), false));
    } catch (e) { log("buyback err:", e.message); return false; }
  }
  const isTeam = (tx) => !!TEAM && BUYER.get(tx) === TEAM;
  async function buyerOf(tx) {
    if (BUYER.has(tx)) return BUYER.get(tx);
    try {
      const t = await provider.getTransaction(tx); let b = (t?.from || "").toLowerCase();
      if (EP.has((t?.to || "").toLowerCase())) { // a smart wallet's buy is sent by a relayer: the buyer is the wallet the pool paid the tokens to
        const rc = await provider.getTransactionReceipt(tx); const poolT = ethers.zeroPadValue(CFG.pool, 32).toLowerCase();
        const lg = rc.logs.filter((l) => l.address.toLowerCase() === CFG.token.toLowerCase() && l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && (l.topics[1] || "").toLowerCase() === poolT).pop();
        if (lg) b = ("0x" + lg.topics[2].slice(-40)).toLowerCase();
      }
      BUYER.set(tx, b); return b;
    } catch { return ""; }
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
    const dayAll = ST.buys.filter((b) => b.block > dayAgo);
    const teamDay = dayAll.filter((b) => isTeam(b.tx));
    const day = dayAll.filter((b) => !isTeam(b.tx));
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
      lastBlock: last?.block || 0, buys10m: ST.buys.filter((b) => b.block > head - BLOCKS_10M && !isTeam(b.tx)).length, vol10m: ST.buys.filter((b) => b.block > head - BLOCKS_10M && !isTeam(b.tx)).reduce((x, b) => x + b.eth, 0),
      newHolders24: [...ST.first.entries()].filter(([a, b]) => b > dayAgo && (ST.bal.get(a) || 0n) > 0n && a !== CFG.pool).length,
      volPrev24: ST.buys.filter((b) => b.block > head - 2 * BLOCKS_PER_DAY && b.block <= dayAgo && !isTeam(b.tx)).reduce((x, b) => x + b.eth, 0),
      athPrice: ST.buys.reduce((mx, b) => Math.max(mx, b.eth / b.tok), 0),
      teamBuys: teamDay.length, teamEth: teamDay.reduce((x, b) => x + b.eth, 0),
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
      `👥 <b>${fmt(m.holders, 0)}</b> holders${m.newHolders24 ? ` · <b>+${m.newHolders24}</b> new today` : ""}`,
      m.volPrev24 > 0 ? `📈 Volume ${m.vol24 >= m.volPrev24 ? "up" : "down"} <b>${fmt(Math.abs((m.vol24 / m.volPrev24 - 1) * 100), 0)}%</b> vs the day before` : "",
      m.teamBuys ? `🏦 Team wallet (disclosed, not counted above): <b>${m.teamBuys}</b> buys · ${fmt(m.teamEth, 4)} ETH in 24h` : "",
      `🎯 Bonding <b>${fmt(m.bondEth, 2)} / ${fmt(BOND, 1)} ETH</b> (${fmt(m.bondPct, 1)}%)`,
      bar(m.bondPct, 12),
      m.bondPct < 100 ? `⏳ <b>${fmt(left, 2)} ETH</b> (~${usd(left * m.ethUsd)}) left to graduate` : `🎓 <b>GRADUATED</b>`,
    ].filter(Boolean).join("\n");
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
      out.rank = holderRank(buyer); out.herd = W.tierOf(buyer);
      const head = await provider.getBlockNumber();
      out.buys10m = ST.buys.filter((b) => b.block > head - BLOCKS_10M).length;
    } catch {}
    return out;
  }

  // ---------- /stagme avatar pictures ----------
  const tgFile = async (method, fields, fileField, buf, fname) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append(fileField, new Blob([buf], { type: "image/png" }), fname); try { return await (await fetch(`${api}/${method}`, { method: "POST", body: f })).json(); } catch (e) { return { ok: false, description: e.message }; } };
  const STAGME = initStagme({ q: W.q, log, tgFile, adminTg: process.env.ADMIN_TG_ID || "6820752140" });

  // ---------- burn counter ----------
  const BURN = initBurn({ provider, ethers, CFG, q: W.q, log, fmt, usd, tgPost, chat, market, adminTg: process.env.ADMIN_TG_ID || "6820752140",
    stGet: async (k) => { try { const [r] = await W.q("select v from bot_state where k=$1", [k]); return r ? r.v : null; } catch { return null; } },
    stSet: async (k, v) => { try { await W.q("insert into bot_state(k,v) values($1,$2) on conflict(k) do update set v=excluded.v, updated_at=now()", [k, String(v)]); } catch {} } });

  // ---------- commands ----------
  let offset = 0;
  const wordAt = new Map();
  async function handle(msg) {
    let text = (msg.text || "").trim();
    if (!text.startsWith("/")) {
      const w = text.toLowerCase().replace(/^[$#]/, "").replace(/[?!.]+$/, "");
      const WORDS = { ca: "ca", contract: "ca", "contract address": "ca", price: "price", mc: "price", chart: "chart", links: "links", website: "links", site: "links", lounge: "lounge", app: "app", invite: "invite", invites: "invites", "invite link": "invite", referral: "invite", buybacks: "buybacks" };
      if (!WORDS[w]) return; const k = msg.chat.id + ":" + WORDS[w], now = Date.now(); if (now - (wordAt.get(k) || 0) < 20000) return; wordAt.set(k, now); text = "/" + WORDS[w];
    }
    const [raw, ...args] = text.split(/\s+/); const cmd = raw.slice(1).split("@")[0].toLowerCase();
    const reply = (t, extra = {}) => tgPost("sendMessage", { chat_id: msg.chat.id, text: t, parse_mode: "HTML", disable_web_page_preview: true, reply_parameters: { message_id: msg.message_id }, reply_markup: links(), ...extra });
    try {
      if (["price", "mc", "stats", "stag", "p"].includes(cmd)) return reply(marketText(await market()));
      if (cmd === "bonding" || cmd === "grad") { const m = await market(); return reply(`🎯 <b>Bonding</b> ${fmt(m.bondEth, 2)} / ${fmt(BOND, 1)} ETH (${fmt(m.bondPct, 1)}%)\n${bar(m.bondPct, 12)}\n⏳ ${fmt(Math.max(0, BOND - m.bondEth), 2)} ETH (~${usd(Math.max(0, BOND - m.bondEth) * m.ethUsd)}) left to graduate`); }
      if (cmd === "holders") { const m = await market(); return reply(`👥 <b>${fmt(m.holders, 0)}</b> holders of $STAG`); }
      if (cmd === "comp" || cmd === "contest") { const c = await compGet(); if (!c || !c.on) return reply(c && c.endedAt ? await compText(c, true) : "No buy comp is running right now. 🦌"); return reply(await compText(c)); }
      if ((cmd === "compstart" || cmd === "compend") && String(msg.from.id) === ADMIN_TG) {
        if (cmd === "compend") { const c = await compGet(); if (c) { c.endTs = Date.now() - 1; await compSet(c); await compCheckEnd(); } return; }
        const days = parseFloat(args[0]) || 7, minEth = parseFloat(args[1]) || 0.005; const head = await provider.getBlockNumber(); const now = Date.now();
        await compSet({ on: true, startBlock: head, startTs: now, endTs: now + days * 86400000, minEth, prize: args.slice(2).join(" ") || "Hooded 20 #1 · Golden Sovereign (Mythic)" }); return reply(`Comp started: ${days} days, min ${minEth} ETH.`);
      }
      if (cmd === "loungeopen" && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140") && msg.chat.type === "private") { // admin only: open the lounge doors to every wallet, or put the 10M gate back
        const on = (args[0] || "").toLowerCase() === "on"; await W.q("insert into bot_state(k,v) values('loungeOpen',$1) on conflict(k) do update set v=excluded.v, updated_at=now()", [on ? "1" : "0"]);
        return reply(on ? "🚪 Lounge is OPEN to every wallet (free entry). Send /loungeopen off to put the 10M $STAG / Founder NFT gate back." : "🔒 Lounge gate is back: 10,000,000 $STAG or a Founder NFT.");
      }
      if ((cmd === "chatid" || cmd === "setclub") && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140")) { // admin only, run inside a group
        if (msg.chat.type === "private") return reply("Run this inside the group, not here.");
        if (cmd === "setclub") { await W.q("create table if not exists bot_state(k text primary key, v text not null, updated_at timestamptz default now())"); await W.q("insert into bot_state(k,v) values('whaleChat',$1) on conflict(k) do update set v=excluded.v, updated_at=now()", [String(msg.chat.id)]); return reply(`✅ This group is now the Hood Rich Club chat (id <code>${msg.chat.id}</code>). Invites will use it from the next check.`, { reply_markup: undefined }); }
        return reply(`Chat id: <code>${msg.chat.id}</code> · ${esc(msg.chat.title || "")}`, { reply_markup: undefined });
      }
      if (cmd === "keysdraft" && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140") && msg.chat.type === "private") { const ok = await keysSend(msg.chat.id, true); return ok ? null : reply("The draft failed to send."); } // admin only: resend the Who Got the Keys draft to this DM
      if (cmd === "keyspost" && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140") && msg.chat.type === "private") { // admin only, in the bot DM: posts the Who Got the Keys announcement to the main group, once
        const [c] = await W.q("insert into bot_state(k,v) values('keysAnnounced','1') on conflict(k) do nothing returning k"); if (!c) return reply("Already posted to the main group once. Not posting again.");
        const ok = await keysSend(chat, false); if (!ok) { await W.q("delete from bot_state where k='keysAnnounced'"); return reply("The post failed, nothing was marked as sent. Try again."); } return reply("✅ Posted to the main group.");
      }
      if (cmd === "wytedraft" && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140") && msg.chat.type === "private") { const ok = await wyteSend(msg.chat.id, true); return ok ? null : reply("The draft failed to send."); } // admin only: resend the WYTE BOYZ draft to this DM
      if (cmd === "wytepost" && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140") && msg.chat.type === "private") { // admin only, in the bot DM: posts the WYTE BOYZ sale announcement to the main group, once
        const [c] = await W.q("insert into bot_state(k,v) values('wyteAnnounced','1') on conflict(k) do nothing returning k"); if (!c) return reply("Already posted to the main group once. Not posting again.");
        const ok = await wyteSend(chat, false); if (!ok) { await W.q("delete from bot_state where k='wyteAnnounced'"); return reply("The post failed, nothing was marked as sent. Try again."); } return reply("✅ Posted to the main group.");
      }
      if (["setdev", "cleardev", "buybackdraft", "buyback", "buybacktoday"].includes(cmd) && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140")) { // owner only, and only in the bot DM
        if (msg.chat.type !== "private") return reply("Send that in my DM, not in a group.");
        if (cmd === "setdev") { const a = (args[0] || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return reply("Send it like this: /setdev 0x… (the full wallet address). You can add more than one wallet, one at a time.");
          DEVS.add(a); await stSet("devWallets", [...DEVS].join(",")); tgPost("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
          return tgPost("sendMessage", { chat_id: msg.chat.id, text: `Saved dev wallet …${a.slice(-4)} (${DEVS.size} saved). I deleted your message so the address is not sitting in this chat. Next: /buybackdraft to see the alert, then /buyback on.`, parse_mode: "HTML" }); }
        if (cmd === "cleardev") { DEVS = new Set(); await stSet("devWallets", ""); return reply("Dev wallets cleared. Buyback alerts will not fire until you add one with /setdev."); }
        if (cmd === "buybackdraft") { const m = await market(); const eth = 0.05, px = m.priceUsd || 0; const ok = await bbSend(msg.chat.id, bbCaption({ eth, spentUsd: eth * (m.ethUsd || 0), tokens: px && m.ethUsd ? eth * m.ethUsd / px : 0, priceUsd: px, mcapUsd: m.mcUsd, txUrl: "" }, { n: 3, eth: 0.15, tok: px && m.ethUsd ? 0.15 * m.ethUsd / px : 0 }, true)); return ok ? null : reply("Could not send the draft. Try again."); }
        if (cmd === "buybacktoday") { const post = (args[0] || "").toLowerCase() === "post"; const n = await bbToday(post ? chat : msg.chat.id, !post); return n > 0 ? (post ? reply(`Posted to the main group: ${n} dev buyback${n === 1 ? "" : "s"} from the last 24 hours.`) : null) : reply(n === 0 ? (DEVS.size ? "No buys from the saved dev wallet in the last 24 hours." : "No dev wallet is saved yet. Send /setdev 0x… first.") : "The post failed. Try again."); }
        const arg = (args[0] || "").toLowerCase(); if (arg !== "on" && arg !== "off") return reply(`Dev buyback alerts are ${BB_ON ? "ON" : "OFF"} · ${DEVS.size} dev wallet${DEVS.size === 1 ? "" : "s"} saved.\n/buyback on or /buyback off to change it.\n/buybacktoday shows a draft of the last 24 hours, /buybacktoday post sends it to the main group.`);
        const on = arg === "on"; BB_ON = on; await stSet("buybackOn", on ? "1" : "0");
        return reply(on ? (DEVS.size ? `🔥 Dev buyback alerts are ON for ${DEVS.size} wallet${DEVS.size === 1 ? "" : "s"}. The next dev buy posts the DEV BUYBACK card in the main group. /buyback off stops it.` : "Alerts are ON, but no dev wallet is saved yet. Send /setdev 0x… first.") : "Dev buyback alerts are OFF. Dev buys post as normal buy cards.");
      }
      if (cmd === "own" && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140")) { // owner only, private DM only: wallets that belong to the dev himself
        if (msg.chat.type !== "private") return; const a0 = (args[0] || "").toLowerCase(), a1 = (args[1] || "").toLowerCase();
        if (a0 === "add" && /^0x[0-9a-f]{40}$/.test(a1)) DEVOWN.add(a1); else if (a0 === "remove" && DEVOWN.has(a1)) DEVOWN.delete(a1); else if (a0 && a0 !== "list") return reply("Send it like this:\n/own add 0x…\n/own remove 0x…\n/own list");
        await stSet("devOwnWallets", JSON.stringify([...DEVOWN])); return reply(`🏷 ${DEVOWN.size} wallet${DEVOWN.size === 1 ? "" : "s"} labelled as the dev's own. My private alerts show that label next to them.` + (a0 === "list" || !a0 ? "\n\n" + [...DEVOWN].map((x) => wLink(x)).join("\n") : ""));
      }
      if (cmd === "team" && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140")) { // owner only, private DM only
        if (msg.chat.type !== "private") return; const a0 = (args[0] || "").toLowerCase(), a1 = (args[1] || "").toLowerCase();
        if (a0 === "add" && /^0x[0-9a-f]{40}$/.test(a1)) TEAMS.add(a1); else if (a0 === "remove" && TEAMS.has(a1)) TEAMS.delete(a1); else if (a0 && a0 !== "list") return reply("Send it like this:\n/team add 0x…\n/team remove 0x…\n/team list");
        await stSet("teamWallets", JSON.stringify([...TEAMS])); return reply(`🏷 ${TEAMS.size} wallet${TEAMS.size === 1 ? "" : "s"} labelled as team wallets. My private alerts show that label next to them.` + (a0 === "list" || !a0 ? "\n\n" + [...TEAMS].map((x) => wLink(x)).join("\n") : ""));
      }
      if ((cmd === "watch" || cmd === "unwatch" || cmd === "watching") && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140")) { // owner only, private DM only
        if (msg.chat.type !== "private") return; const list = await wlGet(); const a = (args[0] || "").toLowerCase();
        if (cmd === "watch" && /^0x[0-9a-f]{40}$/.test(a)) { list[a] = args.slice(1).join(" ").slice(0, 60); await stSet("watchList", JSON.stringify(list)); await stSet("wlEth:" + a, (await provider.getBalance(a)).toString()); await stSet("wlNonce:" + a, String(await provider.getTransactionCount(a))); }
        else if (cmd === "unwatch" && list[a] !== undefined) { delete list[a]; await stSet("watchList", JSON.stringify(list)); }
        else if (cmd !== "watching") return reply("Send it like this:\n/watch 0x… optional note\n/unwatch 0x…\n/watching");
        const keys = Object.keys(list); return reply(keys.length ? `👁 Watching ${keys.length} wallet${keys.length === 1 ? "" : "s"}. Any token in or out, and any ETH change, comes to this DM only:\n\n` + keys.map((k) => `${wLink(k)}${list[k] ? `\n   ${esc(list[k])}` : ""}`).join("\n") : "Not watching any wallets. /watch 0x… to add one.");
      }
      if (cmd === "alerts" && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140")) { // owner only, private DM only
        if (msg.chat.type !== "private") return; const a0 = (args[0] || "").toLowerCase(), n = parseFloat((args[1] || "").replace(/,/g, ""));
        if (a0 === "on" || a0 === "off") await stSet("watchOn", a0 === "on" ? "1" : "0"); else if (a0 === "sell" && n > 0) await stSet("watchSellMin", n); else if (a0 === "holder" && n > 0 && n < 100) { await stSet("watchHolderPct", n); await stSet("watchHolders", "{}"); }
        const c = await wCfg(); return reply(`Private alerts are ${c.on ? "ON" : "OFF"}. They only ever come to this DM.\n• Big sell: ${fmt(c.sell, 0)} $STAG or more in one sale (${fmt(c.sell / SUPPLY * 100, 2)}% of supply)\n• Big holder: any wallet at ${c.pct}% of supply or more\n\nChange them:\n/alerts sell 5000000\n/alerts holder 3\n/alerts off`);
      }
      if ((cmd === "invitedraft" || cmd === "invitepost") && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140")) { // owner only, in the bot DM
        if (msg.chat.type !== "private") return reply("Send that in my DM, not in a group.");
        if (cmd === "invitedraft") { const ok = await invitePromo(msg.chat.id, true); return ok ? null : reply("Could not send the draft. Try again."); }
        const arg = (args[0] || "").toLowerCase(), cur = (await stGet("invitePostOn")) === "1";
        if (arg === "now") { const ok = await inviteNow(); return reply(ok ? "Posted one invite reminder to the main group just now." : "The post failed. Try again in a minute."); }
        if (arg !== "on" && arg !== "off") return reply(`Invite reminders in the main group are ${cur ? "ON" : "OFF"}.\n/invitepost on or /invitepost off to change it. /invitepost now posts one right away. /invitedraft shows you one first.`);
        await stSet("invitePostOn", arg === "on" ? "1" : "0"); if (arg === "on") await stSet("invitePostNext", "0");
        return reply(arg === "on" ? "🤝 Invite reminders are ON. The first one posts in the main group within about an hour and a half, then one every 5 to 10 hours at random, day and night. Each new one replaces the last. /invitepost off stops them." : "Invite reminders are OFF.");
      }
      if (cmd === "start" && (args[0] || "").toLowerCase() === "invite" && msg.chat.type === "private") { // came from the "Get my invite link" button
        const link = await refLink(msg.from); return reply(link ? `🤝 Here is your personal invite link:\n${link}\n\nSend it to anyone. Everyone who joins the group through it counts for you. Type <b>invites</b> in the group to see the board.` : "I cannot make invite links yet. An admin needs to give me the 'invite users' right in the group.");
      }
      if (cmd === "invite" || cmd === "referral" || cmd === "ref") {
        if (!msg.from || msg.from.is_bot) return; const link = await refLink(msg.from);
        if (!link) return reply("I cannot make invite links yet. An admin needs to give me the 'invite users' right in the group.");
        const [n] = await bbQ("select count(*)::int as n from ref_joins where inviter_id=$1 and here", [msg.from.id]);
        return reply(`🤝 <b>${esc(refName(msg.from))}</b>, this is your personal invite link:\n${link}\n\nEveryone who joins through it counts for you${n && n.n ? ` (you have brought in <b>${n.n}</b> so far)` : ""}. Type <b>invites</b> to see the board.`);
      }
      if (cmd === "invites" || cmd === "referrals" || cmd === "inviteboard") return reply(await refBoard());
      if (cmd === "buybacks") { const wk = await bbWeek(); return reply(BB_ON && wk.n ? `🦌🔥 <b>DEV BUYBACKS</b>\nLast 7 days: <b>${wk.n}</b> buyback${wk.n === 1 ? "" : "s"} · <b>${fmt(wk.eth, 3)} ETH</b> · <b>${fmt(wk.tok, 0)}</b> $STAG` : "No dev buybacks tracked in the last 7 days."); }
      if (cmd === "stagme") return STAGME.command(msg, args, reply);
      if (cmd === "burn" || cmd === "burned" || cmd === "burns") return reply(await BURN.text());
      if ((cmd === "burndraft" || cmd === "burnpost") && String(msg.from.id) === String(process.env.ADMIN_TG_ID || "6820752140") && msg.chat.type === "private") { // admin only, in the bot DM
        if (cmd === "burndraft") { await BURN.sync(); return reply("<b>Draft of the daily burn post:</b>\n\n" + await BURN.text(true) + "\n\n<i>Not posted anywhere. Send /burnpost on to start posting it once a day, /burnpost off to stop.</i>"); }
        const on = (args[0] || "").toLowerCase() === "on"; await W.q("insert into bot_state(k,v) values('burnPostOn',$1) on conflict(k) do update set v=excluded.v, updated_at=now()", [on ? "1" : "0"]); return reply(on ? "✅ Daily burn post is ON (once a day at 15:00 UTC in the main group)." : "⏹ Daily burn post is OFF.");
      }
      if (cmd === "top" || cmd === "leaderboard") return reply(await leaderboardText("🏆 TOP BUYERS · 24H"));
      if (cmd === "last") { const m = await market(); const l = ST.buys[ST.buys.length - 1]; return reply(l ? `🕒 Last buy: <b>${fmt(l.eth, 3)} ETH</b> (${usd(l.eth * m.ethUsd)}) · ${fmt((m.head - l.block) / (BLOCKS_PER_DAY / 86400), 0)}s ago · <a href="${CFG.explorer}/tx/${l.tx}">Tx</a>` : "No buys yet."); }
      if (cmd === "me") {
        const a = (args[0] || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return reply("Use: <code>/me 0xYourWallet</code>");
        const v = ST.bal.get(a) || 0n; const m = await market(); const bal = Number(ethers.formatUnits(v, X.META().decimals)); const rank = holderRank(a);
        return reply(bal > 0 ? `👛 <b>${short(a)}</b>\nHolds <b>${fmt(bal, 0)}</b> $STAG (${usd(bal * m.priceUsd)})\nRank <b>#${rank}</b> of ${fmt(m.holders, 0)} holders` : `👛 ${short(a)} holds no $STAG yet.`);
      }
      if (cmd === "song") { const c = X.CLIPS(); if (!c.length) return; const k = c[Math.floor(Math.random() * c.length)]; return X.sendSong(msg.chat.id, k, msg.message_id); }
      if (["whale", "ballerz", "hoodrich", "link", "wallets", "rank", "unlink", "perks", "discount"].includes(cmd) || (cmd === "start" && (args[0] === "whale" || args[0] === "ballerz" || args[0] === "hoodrich"))) return W.command(msg, cmd, args, reply);
      if (cmd === "diamond" || cmd === "diamonds") {
        const head = await provider.getBlockNumber();
        let c = [...ST.first.entries()].filter(([a, b]) => (ST.bal.get(a) || 0n) > 0n && a !== CFG.pool && !ST.out.has(a)).sort((x, y) => x[1] - y[1]).slice(0, 12);
        const keep = []; for (const [a, b] of c) { try { if ((await provider.getCode(a)) === "0x") keep.push([a, b]); } catch {} if (keep.length >= 5) break; }
        if (!keep.length) return reply("💎 No diamond hands yet. Buy and hold. Never sold = on the list.");
        const med = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
        return reply(["<b>💎 DIAMOND HANDS · never sold</b>", ...keep.map(([a, b], i) => `${med[i]} <a href="${CFG.explorer}/address/${a}">${short(a)}</a> · <b>${fmt(Number(ethers.formatUnits(ST.bal.get(a) || 0n, 18)), 0)}</b> $STAG · held ${fmt((head - b) / (BLOCKS_PER_DAY / 24), 1)}h`)].join("\n"));
      }
      if (cmd === "archers" || cmd === "arcade") {
        if (!W.hasDb) return reply("Leaderboard isn't on yet.");
        const rows = await W.topArchers(5); if (!rows.length) return reply("🏹 No Stag Shot scores today yet. Play: https://stagwifhood.fun/play/");
        const med = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"]; return reply(["<b>🏹 TOP ARCHERS · TODAY</b>", ...rows.map((r, i) => `${med[i]} ${esc(r.name)} · <b>${r.s}</b>`), "", "Play: https://stagwifhood.fun/play/"].join("\n"));
      }
      if (cmd === "ca" || cmd === "contract" || cmd === "address") return reply(`<b>$STAG contract (Robinhood Chain)</b>\n<code>${CFG.token}</code>\n<i>tap to copy</i>\n\n<a href="${CFG.explorer}/token/${CFG.token}">Explorer</a> · <a href="${BUY}">Buy on Pons</a>`);
      if (cmd === "lounge" || cmd === "club") return reply("🍸 <b>Hood Rich Club</b>\nThe 3D lounge: DJ, bar, poker, casino tables, chess and trivia. Walk in as a guest, no wallet needed. Play chips only.\nhttps://stagwifhood.fun/lounge/", { reply_markup: { inline_keyboard: [[{ text: "🍸 Enter the lounge", url: "https://stagwifhood.fun/lounge/" }]] } });
      if (cmd === "records" || cmd === "music" || cmd === "album") return reply("🎵 <b>Stag House Records</b> · Winslow Bankz\n💿 Hood Rich album: https://records.stagwifhood.fun/album/\n🎸 WYTE BOYZ and singles: https://records.stagwifhood.fun/songs/\n🎤 Artist page: https://records.stagwifhood.fun/artist/", { reply_markup: { inline_keyboard: [[{ text: "🎧 Hear the clips", url: "https://records.stagwifhood.fun/" }]] } });
      if (cmd === "app" || cmd === "stagr" || cmd === "crm") return reply("📱 <b>StagR</b> · the CRM for any service business and its crew\nOn Google Play: https://play.google.com/store/apps/details?id=com.stagr.app\nMore: https://stagwifhood.fun/stagr/", { reply_markup: { inline_keyboard: [[{ text: "📱 Get it on Google Play", url: "https://play.google.com/store/apps/details?id=com.stagr.app" }]] } });
      if (cmd === "buy") return reply(`🟩 <b>Buy $STAG</b> on Pons (Robinhood Chain)\n${BUY}\n\nCA: <code>${CFG.token}</code>`, { reply_markup: { inline_keyboard: [[{ text: "🟩 Buy $STAG", url: BUY, style: "success" }]] } });
      if (cmd === "chart") return reply(`📈 <b>$STAG chart</b>\n${BUY}`, { reply_markup: { inline_keyboard: [[{ text: "📈 Open chart", url: CFG.chartUrl || BUY, style: "primary" }]] } });
      if (cmd === "links" || cmd === "socials" || cmd === "web") return reply(`<b>$STAG links</b>\n🟩 Buy: ${BUY}\n🌐 Site: https://stagwifhood.fun\n🏹 Game: https://stagwifhood.fun/play/\n🎵 Records: https://records.stagwifhood.fun\n🍸 Lounge: https://stagwifhood.fun/lounge/\n📱 StagR app: https://play.google.com/store/apps/details?id=com.stagr.app\n𝕏 X: https://x.com/stagwifhoodrh\n💬 Telegram: https://t.me/StagWifHood\n\nCA: <code>${CFG.token}</code>`);
      if (cmd === "game" || cmd === "play") return reply(`🏹 <b>Stag Shot</b> – 3D forest archery\n${process.env.MINIAPP_URL || "https://stagwifhood.fun/play/"}`);
      if (cmd === "help" || cmd === "start") return reply("<b>$STAG bot</b>\n<i>You can also just type: ca, price, chart, links</i>\n/ca – contract address\ninvite – your personal invite link · invites – the invite board\n/buy – buy link · /chart – chart\n/links – all links · /game – play Stag Shot\n/lounge – the 3D club · /records – the music · /app – StagR on Google Play\n/price · /mc · /stats – live market\n/bonding – progress to graduation\n/holders – holder count\n/top – top buyers (24h)\n/last – last buy\n/me 0x… – look up a wallet\n/song – play a Winslow Bankz clip\n/stagme <outfit or vibe> – make your own stag picture");
    } catch (e) { log("cmd err:", e.message); }
  }
  // ---------- owner-only watch: big sells and big holders ----------
  // Everything here goes to the owner's private DM with the bot and nowhere else. Nothing in this block ever posts to a group.
  const WT = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", SUPPLY = 1e9, STATS_START = parseInt(process.env.STATS_FROM_BLOCK || "105516351", 10);
  const wPad = (a) => ethers.zeroPadValue(a, 32).toLowerCase(), wAddr = (t) => ("0x" + t.slice(-40)).toLowerCase(), wAmt = (d) => Number(ethers.formatUnits(BigInt(d), 18));
  const ownerDM = (text) => tgPost("sendMessage", { chat_id: ADMIN_TG, text, parse_mode: "HTML", disable_web_page_preview: true });
  const wLink = (a) => `${TEAMS.has(String(a).toLowerCase()) ? "🏷 <b>team wallet</b> " : DEVOWN.has(String(a).toLowerCase()) ? "🏷 <b>dev's own wallet</b> " : ""}<a href="${CFG.explorer}/address/${a}">${a}</a>`;
  async function wLogs(filter, a, b, step = 2000000) { const out = []; for (let x = a; x <= b; x += step) { const to = Math.min(b, x + step - 1); try { out.push(...await provider.getLogs({ ...filter, fromBlock: x, toBlock: to })); } catch (e) { if (step > 20000) out.push(...await wLogs(filter, x, to, Math.floor(step / 5))); else throw e; } } return out; }
  // where a wallet's $STAG came from: bought on the curve, or sent in by another wallet
  async function wSources(w, head) {
    const pool = CFG.pool.toLowerCase(), token = CFG.token.toLowerCase(); let bought = 0; const from = new Map();
    const ins = (await wLogs({ address: CFG.token, topics: [WT, null, wPad(w)] }, STATS_START, head)).slice(-40);
    for (const l of ins) { const src = wAddr(l.topics[1]), a = wAmt(l.data); if (src === pool) { bought += a; continue; }
      let viaCurve = false; try { const rc = await provider.getTransactionReceipt(l.transactionHash); viaCurve = rc.logs.some((x) => x.address.toLowerCase() === token && x.topics[0] === WT && wAddr(x.topics[1]) === pool); } catch {}
      if (viaCurve) bought += a; else from.set(src, (from.get(src) || 0) + a); }
    const lines = []; if (bought > 0) lines.push(`• Bought on the market: <b>${fmt(bought, 0)}</b>`);
    for (const [a, v] of [...from.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)) lines.push(`• Sent in by ${DEVS.has(a) ? "<b>the dev wallet</b>" : wLink(a)}: <b>${fmt(v, 0)}</b>`);
    return lines.length ? lines.join("\n") : "• No incoming transfers found";
  }
  const wCfg = async () => ({ on: (await stGet("watchOn")) !== "0", sell: parseFloat((await stGet("watchSellMin")) || "5000000") || 5000000, pct: parseFloat((await stGet("watchHolderPct")) || "3") || 3 });
  let wBusy = false;
  async function watchSells() {
    if (wBusy) return; wBusy = true;
    try {
      const c = await wCfg(); const head = await provider.getBlockNumber(); const last = parseInt((await stGet("watchSellBlock")) || "0", 10);
      if (!last) { await stSet("watchSellBlock", head); return; } if (head <= last) return;
      const pool = CFG.pool.toLowerCase(), token = CFG.token.toLowerCase(); const logs = await wLogs({ address: CFG.token, topics: [WT, null, wPad(CFG.pool)] }, last + 1, head, 200000); await stSet("watchSellBlock", head);
      if (!c.on) return; const seen = new Set();
      for (const lg of logs) { if (seen.has(lg.transactionHash)) continue; seen.add(lg.transactionHash);
        const rc = await provider.getTransactionReceipt(lg.transactionHash); const tl = rc.logs.filter((l) => l.address.toLowerCase() === token && l.topics[0] === WT); const tos = new Set(tl.map((l) => wAddr(l.topics[2])));
        const first = tl.find((l) => !tos.has(wAddr(l.topics[1]))) || tl[0]; const seller = wAddr(first.topics[1]); const tok = tl.filter((l) => wAddr(l.topics[2]) === pool).reduce((x, l) => x + wAmt(l.data), 0);
        if (tok < c.sell || seller === pool) continue; const m = await market().catch(() => ({})); const left = Number(ethers.formatUnits(ST.bal.get(seller) || 0n, 18));
        await ownerDM([TEAMS.has(seller) ? `ℹ️ <b>Team wallet sale</b> (only you see this)` : `🚨 <b>BIG SELL</b> (only you see this)`, `Sold: <b>${fmt(tok, 0)}</b> $STAG · ${fmt(tok / SUPPLY * 100, 2)}% of supply${m.priceUsd ? ` · about ${usd(tok * m.priceUsd)}` : ""}`, `Wallet: ${DEVS.has(seller) ? "<b>the dev wallet</b>" : wLink(seller)}`, `Still holding: <b>${fmt(Math.max(0, left), 0)}</b>`, `<a href="${CFG.explorer}/tx/${lg.transactionHash}">Transaction</a>`, "", "<b>Where its $STAG came from</b>", await wSources(seller, head)].join("\n"));
      }
    } catch (e) { log("watch sells err:", e.shortMessage || e.message); } finally { wBusy = false; }
  }
  async function watchHolders() {
    try {
      const c = await wCfg(); if (!c.on) return; const skip = new Set([CFG.pool.toLowerCase(), "0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000", RS_ADDR]);
      let known = {}; try { known = JSON.parse((await stGet("watchHolders")) || "{}"); } catch {} const first = (await stGet("watchHoldersInit")) !== "1"; const head = await provider.getBlockNumber(); const cur = [];
      for (const [a, v] of ST.bal.entries()) { if (v <= 0n || skip.has(a) || DEVS.has(a)) continue; const bal = Number(ethers.formatUnits(v, 18)), pct = bal / SUPPLY * 100; if (pct >= c.pct) cur.push({ a, bal, pct, lvl: Math.floor(pct / c.pct) }); }
      cur.sort((x, y) => y.bal - x.bal);
      if (first) { await stSet("watchHoldersInit", "1"); for (const h of cur) known[h.a] = h.lvl; await stSet("watchHolders", JSON.stringify(known));
        await ownerDM(cur.length ? [`👀 <b>BIG HOLDERS RIGHT NOW</b> (only you see this)`, `Wallets holding ${c.pct}% of supply or more, not counting the curve or the dev wallet:`, "", ...cur.slice(0, 15).map((h) => `${wLink(h.a)}\n<b>${fmt(h.bal, 0)}</b> · ${fmt(h.pct, 2)}%`), "", "From now on I will message you when a new wallet crosses that line, and whenever a big sell hits."].join("\n") : `👀 Big-holder watch is on. No wallet other than the curve and the dev wallet holds ${c.pct}% of supply or more right now.`); return; }
      for (const h of cur) { if ((known[h.a] || 0) >= h.lvl) continue; known[h.a] = h.lvl;
        await ownerDM([`👀 <b>BIG HOLDER</b> (only you see this)`, `A wallet now holds <b>${fmt(h.pct, 2)}%</b> of supply: <b>${fmt(h.bal, 0)}</b> $STAG`, `Wallet: ${wLink(h.a)}`, "", "<b>Where its $STAG came from</b>", await wSources(h.a, head)].join("\n")); }
      for (const a of Object.keys(known)) if (!cur.find((h) => h.a === a)) delete known[a]; // dropped back under the line: alert again if they climb back
      await stSet("watchHolders", JSON.stringify(known));
    } catch (e) { log("watch holders err:", e.shortMessage || e.message); }
  }
  // ---------- watch list: any wallet the owner names, private DM alerts only ----------
  // Reports every ERC-20 transfer in or out (any token) and any change in ETH. Nothing here ever posts to a group.
  const WL_DEFAULT = { "0x1c0a3c077551bee6baa2e9919fcb21dca38451e9": "the wallet that got 15M $STAG from 0xa026" };
  const tokMeta = new Map(); let wlBusy = false;
  async function tokInfo(a) { a = a.toLowerCase(); if (!tokMeta.has(a)) { const c = new ethers.Contract(a, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], provider); let sym = "?", dec = 18; try { sym = await c.symbol(); } catch {} try { dec = Number(await c.decimals()); } catch {} tokMeta.set(a, { sym: String(sym).slice(0, 12), dec }); } return tokMeta.get(a); }
  async function wlGet() { try { return JSON.parse((await stGet("watchList")) || "{}"); } catch { return {}; } }
  async function wlTick() {
    if (wlBusy) return; wlBusy = true;
    try {
      if ((await stGet("wlSeeded")) !== "1") { const cur = await wlGet(); for (const [a, l] of Object.entries(WL_DEFAULT)) if (!cur[a]) cur[a] = l; await stSet("watchList", JSON.stringify(cur)); await stSet("wlSeeded", "1"); }
      const list = await wlGet(); const addrs = Object.keys(list); if (!addrs.length) return; const head = await provider.getBlockNumber(); const last = parseInt((await stGet("wlBlock")) || "0", 10);
      if (!last) { await stSet("wlBlock", head); for (const a of addrs) { await stSet("wlEth:" + a, (await provider.getBalance(a)).toString()); await stSet("wlNonce:" + a, String(await provider.getTransactionCount(a))); } return; } 
      const sentTx = {}; for (const a of addrs) { const n = await provider.getTransactionCount(a); const prev = parseInt((await stGet("wlNonce:" + a)) ?? String(n), 10); if (n !== prev) { sentTx[a] = { n, by: n - prev }; await stSet("wlNonce:" + a, String(n)); } }
      let ethMoved = {}; for (const a of addrs) { const now = await provider.getBalance(a); const prev = BigInt((await stGet("wlEth:" + a)) || now.toString()); if (now !== prev) { ethMoved[a] = { prev, now }; await stSet("wlEth:" + a, now.toString()); } }
      if (head > last) {
        const seen = new Set(); const events = [];
        for (const a of addrs) for (const dir of ["IN", "OUT"]) { const topics = dir === "IN" ? [WT, null, wPad(a)] : [WT, wPad(a)]; const ls = await wLogs({ topics }, last + 1, head, 200000); for (const l of ls) { if (l.topics.length !== 3) continue; const k = l.transactionHash + ":" + l.index + ":" + dir; if (seen.has(k)) continue; seen.add(k); events.push({ a, dir, l }); } }
        await stSet("wlBlock", head); events.sort((x, y) => x.l.blockNumber - y.l.blockNumber || x.l.index - y.l.index);
        for (const e of events) { const m = await tokInfo(e.l.address); const amount = Number(ethers.formatUnits(BigInt(e.l.data), m.dec)); const other = e.dir === "IN" ? wAddr(e.l.topics[1]) : wAddr(e.l.topics[2]); const pool = CFG.pool.toLowerCase();
          let what = e.dir === "IN" ? `⬇️ <b>RECEIVED</b> ${fmt(amount, amount < 1000 ? 4 : 0)} ${esc(m.sym)}` : `⬆️ <b>SENT</b> ${fmt(amount, amount < 1000 ? 4 : 0)} ${esc(m.sym)}`; const isStag = e.l.address.toLowerCase() === CFG.token.toLowerCase();
          if (isStag && other === pool) what = e.dir === "IN" ? `🟢 <b>BOUGHT</b> ${fmt(amount, 0)} $STAG on the curve` : `🔴 <b>SOLD</b> ${fmt(amount, 0)} $STAG on the curve`;
          let bal = ""; try { const c = new ethers.Contract(e.l.address, ["function balanceOf(address) view returns (uint256)"], provider); bal = `\nBalance now: <b>${fmt(Number(ethers.formatUnits(await c.balanceOf(e.a), m.dec)), amount < 1000 ? 4 : 0)}</b> ${esc(m.sym)}`; } catch {}
          await ownerDM([`👁 <b>WATCHED WALLET</b> (only you see this)`, what, `Wallet: ${wLink(e.a)}${list[e.a] ? ` · ${esc(list[e.a])}` : ""}`, `${e.dir === "IN" ? "From" : "To"}: ${other === pool ? "the curve" : DEVS.has(other) ? "<b>the dev wallet</b>" : wLink(other)}${bal}`, `<a href="${CFG.explorer}/tx/${e.l.transactionHash}">Transaction</a>`].join("\n")); }
      }
      for (const [a, v] of Object.entries(sentTx)) await ownerDM([`👁 <b>WATCHED WALLET</b> (only you see this)`, `✍️ This wallet just sent <b>${v.by}</b> transaction${v.by === 1 ? "" : "s"} of its own (total sent: ${v.n}). Any token movement from it follows in separate alerts.`, `Wallet: ${wLink(a)}${list[a] ? ` · ${esc(list[a])}` : ""}`].join("\n"));
      for (const [a, v] of Object.entries(ethMoved)) { const d = Number(ethers.formatEther(v.now - v.prev)); await ownerDM([`👁 <b>WATCHED WALLET</b> (only you see this)`, `${d > 0 ? "⬇️ ETH in" : "⬆️ ETH out"}: <b>${fmt(Math.abs(d), 5)} ETH</b>`, `Wallet: ${wLink(a)}${list[a] ? ` · ${esc(list[a])}` : ""}`, `ETH balance now: <b>${fmt(Number(ethers.formatEther(v.now)), 5)}</b>`].join("\n")); }
    } catch (e) { log("watchlist err:", e.shortMessage || e.message); } finally { wlBusy = false; }
  }
  // ---------- record launchpad: who is backing which record (read from the RecordStake contract's events) ----------
  // Off until RECORD_STAKE (the contract address) is set. Positions are rebuilt from Staked / Unstaked events only.
  const RS_ADDR = (process.env.RECORD_STAKE || "").toLowerCase(), RS_FROM = parseInt(process.env.RECORD_STAKE_FROM || "0", 10);
  const RS_IFACE = new ethers.Interface(["event Staked(address indexed user, uint256 indexed recordId, uint256 amount, uint256 newAmount, uint64 since)", "event Unstaked(address indexed user, uint256 indexed recordId, uint256 amount, uint256 newAmount)"]);
  let rsBusy = false, rsCache = null, rsAt = 0;
  async function rsSync() {
    if (!/^0x[0-9a-f]{40}$/.test(RS_ADDR) || rsBusy) return; rsBusy = true;
    try {
      await bbQ("create table if not exists rs_pos(addr text not null, record int not null, amount numeric not null, since bigint not null, primary key(addr, record))");
      const head = await provider.getBlockNumber(); let from = Math.max(RS_FROM, parseInt((await stGet("rsScanned")) || "0", 10) + 1);
      while (from <= head) {
        const to = Math.min(head, from + 49999); const logs = await provider.getLogs({ address: RS_ADDR, fromBlock: from, toBlock: to });
        for (const lg of logs) { let ev; try { ev = RS_IFACE.parseLog(lg); } catch { continue; } if (!ev) continue;
          const since = ev.name === "Staked" ? Number(ev.args.since) : (await provider.getBlock(lg.blockNumber)).timestamp;
          await W.q("insert into rs_pos(addr, record, amount, since) values ($1,$2,$3,$4) on conflict(addr, record) do update set amount=excluded.amount, since=excluded.since", [ev.args.user.toLowerCase(), Number(ev.args.recordId), ev.args.newAmount.toString(), since]); rsAt = 0; }
        await stSet("rsScanned", to); from = to + 1;
      }
    } catch (e) { log("record stake sync err:", e.shortMessage || e.message); } finally { rsBusy = false; }
  }
  async function rsBoards() {
    if (rsCache && Date.now() - rsAt < 30000) return rsCache; const out = {};
    if (/^0x[0-9a-f]{40}$/.test(RS_ADDR)) { const now = Math.floor(Date.now() / 1000);
      const rows = await bbQ("select addr, record, amount::text as amount, since from rs_pos where amount >= 1000000000000000000"); // a backer holds at least one whole token on the record
      for (const r of rows) { const amt = Number(ethers.formatUnits(BigInt(r.amount), 18)); (out[r.record] = out[r.record] || []).push({ who: r.addr.slice(0, 6) + "…" + r.addr.slice(-4), amount: amt, points: Math.floor(amt * Math.max(0, now - Number(r.since)) / 86400) }); }
      for (const k of Object.keys(out)) out[k] = out[k].sort((a, b) => b.points - a.points || b.amount - a.amount).slice(0, 25); }
    rsCache = { ok: true, records: out }; rsAt = Date.now(); return rsCache;
  }
  // ---------- invite links: every member gets a personal link, and the bot counts who they bring in ----------
  // Needs the bot to be an admin of the main group with the "invite users" right. A person only ever counts once, and stops counting if they leave.
  const refName = (u) => [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 40) || u.username || "Member";
  async function refInit() {
    await bbQ("create table if not exists ref_links(user_id bigint primary key, name text not null, link text not null unique, at timestamptz not null default now())");
    await bbQ("create table if not exists ref_joins(joined_id bigint primary key, inviter_id bigint not null, here boolean not null default true, at timestamptz not null default now())");
  }
  async function refLink(u) {
    const [have] = await bbQ("select link from ref_links where user_id=$1", [u.id]); if (have) return have.link;
    const r = await tgPost("createChatInviteLink", { chat_id: chat, name: ("ref " + refName(u)).slice(0, 32) }); if (!r || !r.ok) { log("invite link err:", r && r.description); return null; }
    await bbQ("insert into ref_links(user_id, name, link) values ($1,$2,$3) on conflict(user_id) do nothing", [u.id, refName(u), r.result.invite_link]); return r.result.invite_link;
  }
  async function refJoin(cm) {
    try {
      if (String(cm.chat.id) !== String(chat)) return; const who = cm.new_chat_member && cm.new_chat_member.user; if (!who || who.is_bot) return;
      const st = cm.new_chat_member.status, was = cm.old_chat_member && cm.old_chat_member.status;
      if (st === "left" || st === "kicked") { await bbQ("update ref_joins set here=false where joined_id=$1", [who.id]); return; }
      if (!["member", "restricted"].includes(st) || ["member", "administrator", "creator", "restricted"].includes(was)) return;
      const link = cm.invite_link && cm.invite_link.invite_link; if (!link) { await bbQ("update ref_joins set here=true where joined_id=$1", [who.id]); return; }
      const [own] = await bbQ("select user_id from ref_links where link=$1", [link]); if (!own || String(own.user_id) === String(who.id)) return;
      await bbQ("insert into ref_joins(joined_id, inviter_id) values ($1,$2) on conflict(joined_id) do update set here=true", [who.id, own.user_id]);
    } catch (e) { log("ref join err:", e.message); }
  }
  async function refBoard() {
    const rows = await bbQ("select l.name, count(*)::int as n, count(*) filter (where j.at > now() - interval '7 days')::int as wk from ref_joins j join ref_links l on l.user_id = j.inviter_id where j.here group by l.user_id, l.name order by n desc, min(j.at) limit 10");
    if (!rows.length) return "🤝 <b>INVITE BOARD</b>\nNobody is on the board yet. Type <b>invite</b> to get your own link and be first.";
    return ["🤝 <b>INVITE BOARD</b>", ...rows.map((r, i) => `${["🥇", "🥈", "🥉"][i] || `${i + 1}.`} <b>${esc(r.name)}</b> · ${r.n} brought in${r.wk ? ` (${r.wk} this week)` : ""}`), "", "Type <b>invite</b> to get your own link. People who leave stop counting."].join("\n");
  }
  // The bot reminds the group about invite links a few times a day, at random gaps, with a banner. OFF until the owner sends /invitepost on.
  const INV_LINES = [
    "🤝 <b>BRING THE HERD</b>\nType <b>invite</b> and I will give you your own link. Everyone who joins through it counts for you on the invite board.",
    "🦌 <b>Know someone who should be in here?</b>\nType <b>invite</b> for your personal link and send it to them. Every person you bring in goes on the board under your name.",
    "📣 <b>The invite board is open.</b>\nType <b>invite</b> to get your link, and <b>invites</b> to see who has brought in the most people.",
    "🔗 <b>Your own invite link is one word away.</b>\nType <b>invite</b>. Share it anywhere. The bot counts everyone who joins through it.",
  ];
  let botUser = "";
  async function invitePromo(to, draft) {
    try {
      if (!botUser) { const me = await tgPost("getMe", {}); botUser = (me && me.ok && me.result.username) || ""; }
      const top = await bbQ("select l.name, count(*)::int as n from ref_joins j join ref_links l on l.user_id = j.inviter_id where j.here group by l.user_id, l.name order by n desc, min(j.at) limit 3");
      const cap = (draft ? "<i>DRAFT. Not posted anywhere. Send /invitepost on here to start the reminders in the main group.</i>\n\n" : "") + INV_LINES[Math.floor(Math.random() * INV_LINES.length)]
        + (top.length ? "\n\n<b>On the board right now</b>\n" + top.map((r, i) => `${["🥇", "🥈", "🥉"][i]} ${esc(r.name)} · ${r.n}`).join("\n") : "");
      const markup = botUser ? JSON.stringify({ inline_keyboard: [[{ text: "Get my invite link", url: `https://t.me/${botUser}?start=invite` }]] }) : "";
      const f = path.join(DIR, "invite.jpg"); let r;
      if (existsSync(f)) { const fd = new FormData(); fd.append("chat_id", String(to)); fd.append("caption", cap); fd.append("parse_mode", "HTML"); if (markup) fd.append("reply_markup", markup); fd.append("photo", new Blob([readFileSync(f)], { type: "image/jpeg" }), "invite.jpg"); r = await (await fetch(`${api}/sendPhoto`, { method: "POST", body: fd })).json(); }
      else r = await tgPost("sendMessage", { chat_id: to, text: cap, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: JSON.parse(markup) } : {}) });
      if (!r || !r.ok) { log("invite promo err:", r && r.description); return 0; } return r.result.message_id;
    } catch (e) { log("invite promo err:", e.message); return 0; }
  }
  async function inviteNow() { // post one reminder right away, whatever the hour, and start the random gap from here
    const prev = await stGet("invitePostMsg"); const id = await invitePromo(chat, false); if (!id) return false;
    await stSet("invitePostMsg", id); await stSet("invitePostNext", Date.now() + (5 + Math.random() * 5) * 3600000); if (prev) tgPost("deleteMessage", { chat_id: chat, message_id: Number(prev) }); log("invite reminder sent (now)"); return true;
  }
  async function inviteTick() { // random gap of 5 to 10 hours between reminders, round the clock (the group spans every time zone), and the previous reminder is removed so they never pile up
    try {
      if ((await stGet("invitePostOn")) !== "1" || !chat) return; const now = Date.now(), next = parseInt((await stGet("invitePostNext")) || "0", 10);
      if (!next) { await stSet("invitePostNext", now + (20 + Math.random() * 70) * 60000); return; } if (now < next) return;
      await stSet("invitePostNext", now + (5 + Math.random() * 5) * 3600000); const prev = await stGet("invitePostMsg");
      const id = await invitePromo(chat, false); if (id) { await stSet("invitePostMsg", id); if (prev) tgPost("deleteMessage", { chat_id: chat, message_id: Number(prev) }); log("invite reminder sent"); }
    } catch (e) { log("invite tick err:", e.message); }
  }
  async function pollCommands() {
    await refInit();
    for (;;) {
      try {
        const r = await fetch(`${api}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message","chat_member"]')}`).then((x) => x.json());
        for (const u of r.result || []) { offset = u.update_id + 1; if (u.message) handle(u.message); else if (u.chat_member) refJoin(u.chat_member); }
      } catch (e) { await new Promise((r) => setTimeout(r, 3000)); }
    }
  }

  // ---------- pinned live dashboard ----------
  let dashId = 0;
  async function updateDashboard() {
    try {
      const base = marketText(await market(), "$STAG · LIVE DASHBOARD");
      let text = base + `\n\n<i>updated <tg-time unix="${Math.floor(Date.now() / 1000)}" format="r">just now</tg-time> · refreshes hourly</i>`;
      if (!dashId) {
        const c = await tgPost("getChat", { chat_id: chat });
        const pm = c.result?.pinned_message; if (pm?.from?.is_bot && pm.text?.includes("LIVE DASHBOARD")) dashId = pm.message_id;
      }
      if (dashId) {
        let r = await tgPost("editMessageText", { chat_id: chat, message_id: dashId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: links() });
        if (!r.ok && /parse|entit|tag/i.test(r.description || "")) { text = base + `\n\n<i>refreshes hourly</i>`; r = await tgPost("editMessageText", { chat_id: chat, message_id: dashId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: links() }); }
        if (r.ok || /not modified/i.test(r.description || "")) return;
        dashId = 0;
      }
      const s = await sendText(text, { reply_markup: links(), disable_notification: true });
      if (s.ok) { dashId = s.result.message_id; await tgPost("pinChatMessage", { chat_id: chat, message_id: dashId, disable_notification: true }); }
    } catch (e) { log("dash err:", e.message); }
  }

  // ---------- buy competition (/comp): biggest total of qualifying buys wins; state in bot_state.comp ----------
  const ADMIN_TG = String(process.env.ADMIN_TG_ID || "6820752140");
  const COMP_EXCLUDE = new Set(["0xb6a5059356332a0b222e9d21b1f72f3617d12516", ...(process.env.COMP_EXCLUDE || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean)]);
  const compGet = async () => { try { const [r] = await W.q("select v from bot_state where k='comp'"); return r ? JSON.parse(r.v) : null; } catch { return null; } };
  const compSet = async (o) => { await W.q("insert into bot_state(k,v) values('comp',$1) on conflict(k) do update set v=excluded.v, updated_at=now()", [JSON.stringify(o)]); };
  async function compRows(c) {
    const win = ST.buys.filter((b) => b.block >= c.startBlock && b.eth >= c.minEth);
    for (let i = 0; i < win.length; i += 6) await Promise.all(win.slice(i, i + 6).map((b) => buyerOf(b.tx)));
    const map = new Map();
    for (const b of win) { const w = BUYER.get(b.tx); if (!w || COMP_EXCLUDE.has(w) || w === (TEAM || "x") || isTeam(b.tx)) continue; const e = map.get(w) || { eth: 0, n: 0, tok: 0 }; e.eth += b.eth; e.n++; e.tok += b.tok; map.set(w, e); }
    const dec = X.META().decimals;
    return [...map.entries()].map(([w, e]) => { const bal = Number(ethers.formatUnits(ST.bal.get(w) || 0n, dec)); return { w, ...e, bal, ok: bal >= e.tok * 0.9 }; }).sort((a, b) => b.eth - a.eth);
  }
  async function compText(c, final = false) {
    const rows = await compRows(c); const m = await market(); const elig = rows.filter((r) => r.ok); const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const lines = elig.slice(0, 5).map((r, i) => `${medals[i]} <a href="${CFG.explorer}/address/${r.w}">${short(r.w)}</a> · <b>${fmt(r.eth, 3)} ETH</b> (${usd(r.eth * m.ethUsd)}) · ${r.n} buy${r.n > 1 ? "s" : ""}`);
    const out = rows.filter((r) => !r.ok).length;
    const head = final ? `<b>BUY COMP · FINAL RESULT</b>` : `<b>BUY COMP · WEEKLY BIGGEST BUYER</b>`;
    const body = lines.length ? lines.join("\n") : "No qualifying buys yet. Be the first. 🦌";
    const win = final && elig[0] ? `\n\n🎉 <b>Winner: <a href="${CFG.explorer}/address/${elig[0].w}">${short(elig[0].w)}</a></b>\nPrize: <b>${c.prize}</b>` : "";
    const rules = `\n\n<b>PRIZE</b>  ${c.prize}\n<b>RULES</b>\nEvery single buy of <b>${c.minEth} ETH or more</b> counts toward your total.\nBiggest total wins.\nYou must still hold <b>90%+</b> of what you bought, so no buy-and-dump.\nTeam wallets are excluded.${out ? `\n<i>${out} wallet${out > 1 ? "s" : ""} not counted for selling.</i>` : ""}`;
    const when = final ? "" : `\nEnds <tg-time unix="${Math.floor(c.endTs / 1000)}" format="r">soon</tg-time>`;
    return `${head}\n${body}${win}${final ? "" : rules}${when}`;
  }
  let compTimer = null;
  async function compCheckEnd() {
    const c = await compGet(); if (!c || !c.on || Date.now() < c.endTs) return;
    c.on = false; c.endedAt = Date.now(); await compSet(c);
    try { await sendText(await compText(c, true), { reply_markup: links() }); } catch (e) { log("comp end err:", e.message); }
    log("comp ended");
  }

  // every ~5h while a comp is on (and bot_state.compPostOn = '1'): banner + live standings, replacing the previous post
  const stGet = async (k) => { try { const [r] = await W.q("select v from bot_state where k=$1", [k]); return r ? r.v : null; } catch { return null; } };
  const stSet = async (k, v) => { try { await W.q("insert into bot_state(k,v) values($1,$2) on conflict(k) do update set v=excluded.v, updated_at=now()", [k, String(v)]); } catch {} };
  async function compPost() {
    try {
      const c = await compGet(); if (!c || !c.on || (await stGet("compPostOn")) !== "1") return;
      const every = (parseFloat((await stGet("compPostHours")) || process.env.COMP_POST_HOURS || "6") || 6) * 3600e3; const last = parseInt((await stGet("compPostAt")) || "0", 10);
      if (Date.now() - last < every) return; await stSet("compPostAt", Date.now());
      const prev = await stGet("compPostMsg");
      const fd = new FormData(); fd.append("chat_id", chat); fd.append("caption", await compText(c)); fd.append("parse_mode", "HTML");
      fd.append("reply_markup", JSON.stringify({ inline_keyboard: [[{ text: "Buy $STAG", url: BUY, style: "success" }]] }));
      fd.append("animation", new Blob([readFileSync(path.join(DIR, "comp.mp4"))], { type: "video/mp4" }), "comp.mp4");
      const r = await (await fetch(`${api}/sendAnimation`, { method: "POST", body: fd })).json();
      if (r.ok) { await stSet("compPostMsg", r.result.message_id); if (prev) tgPost("deleteMessage", { chat_id: chat, message_id: Number(prev) }); log("comp post sent"); } else log("comp post err:", r.description);
    } catch (e) { log("comp post err:", e.message); }
  }

  // ---------- milestones ----------
  const TIERS = [25, 50, 75, 90, 100];
  let lastTier = -1; let lastHolderMs = 0; let lastMcTier = -1; let lastAth = 0; let lastAthPost = 0;
  const MC_TIERS = [10e3, 25e3, 50e3, 100e3, 250e3, 500e3, 1e6, 2.5e6, 5e6];
  async function watchMilestones() {
    try {
      const m = await market();
      const tier = TIERS.filter((t) => m.bondPct >= t).length;
      if (lastTier < 0) { lastMcTier = MC_TIERS.filter((t) => m.mcUsd >= t).length; lastAth = m.athPrice; lastTier = tier; lastHolderMs = [100, 250, 500, 1000, 2500, 5000].filter((h) => m.holders >= h).length; return; }
      if (tier > lastTier) {
        lastTier = tier; const t = TIERS[tier - 1];
        const head = t >= 100 ? "🎓🚀 <b>$STAG HAS GRADUATED!</b>" : `🚨 <b>$STAG IS ${t}% BONDED!</b>`;
        await X.sendVideoCard(`${head}\n\n${marketText(m, "STATUS")}`, links());
      }
      const mt = MC_TIERS.filter((t) => m.mcUsd >= t).length;
      if (mt > lastMcTier) { lastMcTier = mt; await X.sendVideoCard(`🚀 <b>$STAG just crossed a ${usd(MC_TIERS[mt - 1])} market cap!</b>\n\n${marketText(m, "STATUS")}`, links()); }
      if (m.athPrice > lastAth * 1.005 && lastAth > 0 && Date.now() - lastAthPost > 15 * 60000) { lastAth = m.athPrice; lastAthPost = Date.now(); await sendText(`📈 <b>NEW ALL-TIME HIGH!</b>\nPrice <b>${usd(m.priceUsd)}</b> · MC <b>${usd(m.mcUsd)}</b>\n\n${marketText(m, "$STAG")}`, { reply_markup: links() }); } else if (m.athPrice > lastAth) lastAth = Math.max(lastAth, m.athPrice * 0.995);
      const hs = [100, 250, 500, 1000, 2500, 5000].filter((h) => m.holders >= h).length;
      if (hs > lastHolderMs) { lastHolderMs = hs; const h = [100, 250, 500, 1000, 2500, 5000][hs - 1]; await sendText(`🦌 <b>${fmt(h, 0)} HOLDERS!</b> The herd is growing.\n\n${marketText(m, "$STAG")}`, { reply_markup: links() }); }
    } catch (e) { log("milestone err:", e.message); }
  }

  // ---------- daily leaderboard (00:00 UTC) ----------
  let lastDay = new Date().toISOString().slice(0, 10);
  async function dailyCheck() {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== lastDay) {
      lastDay = d;
      try { await sendText(await leaderboardText("🏆 DAILY TOP BUYERS · $STAG"), { reply_markup: links() }); } catch (e) { log("daily err:", e.message); }
      if (W.hasDb) { try { const rows = await W.topArchers(5); if (rows.length) { const med = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"]; await sendText(["<b>🏹 TOP ARCHERS · YESTERDAY'S GAME</b>", ...rows.map((r, i) => `${med[i]} ${esc(r.name)} · <b>${r.s}</b>`), "", "Play: https://stagwifhood.fun/play/"].join("\n")); } } catch (e) { log("archers err:", e.message); } }
      if (new Date().getUTCDay() === 0) { try { await weeklyRecap(); } catch (e) { log("weekly err:", e.message); } }
    }
  }

  async function weeklyRecap() {
    const m = await market(); const head = m.head; const wk = ST.buys.filter((b) => b.block > head - 7 * BLOCKS_PER_DAY && !isTeam(b.tx));
    const newH = [...ST.first.entries()].filter(([a, b]) => b > head - 7 * BLOCKS_PER_DAY && (ST.bal.get(a) || 0n) > 0n && a !== CFG.pool).length;
    const big = wk.reduce((mx, b) => (b.eth > (mx?.eth || 0) ? b : mx), null);
    await X.sendVideoCard(["<b>📅 $STAG · WEEKLY RECAP</b>", `🔥 <b>${wk.length}</b> buys · <b>${fmt(wk.reduce((x, b) => x + b.eth, 0), 2)} ETH</b> volume`, `👥 <b>+${newH}</b> new holders · <b>${fmt(m.holders, 0)}</b> total`, big ? `🏆 Biggest buy: <b>${fmt(big.eth, 3)} ETH</b> (${usd(big.eth * m.ethUsd)})` : "", `💰 MC <b>${usd(m.mcUsd)}</b> · Bonding <b>${fmt(m.bondPct, 1)}%</b>`, "", "Vote below for next week's featured song 👇"].filter(Boolean).join("\n"), links());
    const songs = X.CLIPS(); if (songs.length >= 4) { const pick = [...songs].sort(() => Math.random() - 0.5).slice(0, 4).map((s) => s.title.slice(0, 90)); await tgPost("sendPoll", { chat_id: chat, question: "🎵 Which Winslow Bankz song should we feature next week?", options: pick, is_anonymous: true }); }
  }

  const WYTE_CAP = "🎸🔥 <b>NEW DROP: “WYTE BOYZ”</b> 🦌\n<b>Winslow Bankz</b> ft. <b>Jelly Roll</b> &amp; <b>Pyrexx</b>\nOut now on <b>Stag House Records</b>. Limited to <b>100 copies at $24.99</b> (0.01117 ETH on Robinhood Chain).\n🔥 <b>50% of sales go to $STAG buyback and burn.</b>\n\n🛒 Collect: https://records.stagwifhood.fun/songs/\n🎧 Hear it in the lounge DJ rotation: https://stagwifhood.fun/lounge/";
  const WYTE_KB = { inline_keyboard: [[{ text: "🛒 Collect WYTE BOYZ", url: "https://records.stagwifhood.fun/songs/" }]] };
  const KEYS_CAP = "🔑🔥 <b>NEW SINGLE: “WHO GOT THE KEYS”</b> 🦌\n<b>Winslow Bankz</b> · out now on <b>Stag House Records</b>\nLimited to <b>100 copies at $25</b> (0.0122 ETH on Robinhood Chain).\n\n🛒 Collect: https://records.stagwifhood.fun/songs/\n🎤 Meet the artist: https://records.stagwifhood.fun/artist/";
  const KEYS_KB = { inline_keyboard: [[{ text: "🛒 Collect Who Got the Keys", url: "https://records.stagwifhood.fun/songs/" }]] };
  async function keysSend(to, draft) { try { await X.sendVideoCard((draft ? "<i>DRAFT, not posted anywhere. Send /keyspost here to post it to the main group.</i>\n\n" : "") + KEYS_CAP, KEYS_KB, "keys", to); return true; } catch (e) { log("keys send err:", e.message); return false; } }
  async function wyteSend(to, draft) { try { await X.sendVideoCard((draft ? "<i>DRAFT, not posted anywhere. Send /wytepost here to post it to the main group.</i>\n\n" : "") + WYTE_CAP, WYTE_KB, "9", to); return true; } catch (e) { log("wyte send err:", e.message); return false; } }
  // ---------- song NFT sale alerts: every purchase on the Stag House Records song shop gets announced in the main chat ----------
  const SONGS = (process.env.SONGS_CONTRACT || "0x895c3c2cC2790Db976EB03b0Fae17EB5594aaCA4");
  const SONG_NAMES = { 1: "Money on My Mind", 2: "Crown Too Heavy", 3: "First Heartbreak at School (Remix)", 4: "No Me Llames", 5: "Fresh Cut, White Tee", 6: "Back On Go", 7: "Walk Me Through the Fire", 8: "Still Ridin' Slow", 9: "Hood Rich (the full album)", 10: "WYTE BOYZ (feat. Jelly Roll & Pyrexx)", 11: "Who Got the Keys", 12: "Who Got the Keys" };
  const SONG_IFACE = new ethers.Interface(["event Bought(address indexed buyer, uint256 indexed id, uint256 price)", "function songInfo(uint256) view returns (uint256 price, uint256 cap, uint256 minted, bool open, bool frozen, string metadataURI)"]);
  const BOUGHT_TOPIC = SONG_IFACE.getEvent("Bought").topicHash;
  const songContract = new ethers.Contract(SONGS, SONG_IFACE, provider);
  async function songTitle(id, uri) {
    if (SONG_NAMES[id]) return SONG_NAMES[id];
    try { const j = await fetch(uri, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()); if (j && j.name) return String(j.name).replace(/\s*-\s*Winslow Bankz$/, "").slice(0, 80); } catch {}
    return "song #" + id;
  }
  let songBusy = false;
  async function songSales() {
    if (songBusy) return; songBusy = true;
    try {
      await W.q("create table if not exists bot_state(k text primary key, v text not null, updated_at timestamptz default now())");
      const head = await provider.getBlockNumber(); const [r] = await W.q("select v from bot_state where k='songSaleBlock'");
      if (!r) { await W.q("insert into bot_state(k,v) values('songSaleBlock',$1) on conflict(k) do nothing", [String(head)]); log("song sale alerts: watching from block", head); return; } // first run starts now, no history spam
      let from = Number(r.v) + 1; if (from > head) return; const to = Math.min(head, from + 20000);
      const logs = await provider.getLogs({ address: SONGS, topics: [BOUGHT_TOPIC], fromBlock: from, toBlock: to });
      for (const lg of logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
        const ev = SONG_IFACE.parseLog(lg); const id = Number(ev.args.id); const buyer = ev.args.buyer; const eth = Number(ethers.formatEther(ev.args.price));
        try { await W.q("insert into song_sales(tx, idx, song_id, buyer, eth, block) values ($1,$2,$3,$4,$5,$6) on conflict do nothing", [lg.transactionHash, lg.index, id, buyer.toLowerCase(), eth, lg.blockNumber]); } catch (e) { log("song sale save err:", e.message); }
        let left = "", title = SONG_NAMES[id] || "song #" + id;
        try { const si = await songContract.songInfo(id, { blockTag: lg.blockNumber }); const cap = Number(si.cap), minted = Number(si.minted); left = cap - minted <= 0 ? "🔥 <b>SOLD OUT</b>" : `🔥 <b>${cap - minted}</b> of ${cap} left`; title = await songTitle(id, si.metadataURI); } catch {}
        const ethUsd = X.ethUsd ? X.ethUsd() : 0;
        const text = ["🎟️ <b>NEW COLLECTOR</b>", `<a href="${CFG.explorer}/address/${buyer}">${short(buyer)}</a> just collected <b>${esc(title)}</b>`, `💰 <b>${fmt(eth, 4)} ETH</b>${ethUsd ? " (~" + usd(eth * ethUsd) + ")" : ""}${left ? " · " + left : ""}`, `🦌 Stag House Records · Winslow Bankz`].join("\n");
        const res = await tgPost("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "🛒 Collect yours", url: "https://records.stagwifhood.fun/songs/" }, { text: "🔗 Tx", url: `${CFG.explorer}/tx/${lg.transactionHash}` }]] } });
        if (!res.ok) { log("song sale post failed:", res.description); await W.q("update bot_state set v=$1, updated_at=now() where k='songSaleBlock'", [String(lg.blockNumber - 1)]); return; } // retry from this block next poll
        log("song sale announced:", title, short(buyer));
      }
      await W.q("update bot_state set v=$1, updated_at=now() where k='songSaleBlock'", [String(to)]);
    } catch (e) { log("song sale watch err:", e.message); } finally { songBusy = false; }
  }
  // ---------- public read-only numbers for the websites (cached; no wallet or Telegram details) ----------
  let tokCache = null, tokAt = 0; const colCache = new Map();
  const sendJson = (res, obj, age) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=" + age, "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); };
  API.h = async (req, res, u) => {
    if (u.pathname === "/api/token") {
      if (!tokCache || Date.now() - tokAt > 20000) { try { const m = await market(); tokCache = { ok: true, token: CFG.token, priceUsd: m.priceUsd, mcUsd: m.mcUsd, ch24: m.ch24, holders: m.holders, buys24: m.buys24, vol24Eth: m.vol24, vol24Usd: m.vol24 * m.ethUsd, bondPct: m.bondPct, lastBuyBlock: m.lastBlock, head: m.head, buyUrl: CFG.buyUrl || CFG.chartUrl || `${CFG.launchpad}/${CFG.token}`, updated: Date.now() }; if (BB_ON && bbLast) { const wk = await bbWeek(); tokCache.buyback = { ts: bbLast.ts, eth: bbLast.eth, tok: bbLast.tok, weekN: wk.n, weekEth: wk.eth, weekTok: wk.tok }; } tokAt = Date.now(); } catch (e) { if (!tokCache) { sendJson(res, { ok: false }, 5); return true; } } }
      sendJson(res, tokCache, 15); return true;
    }
    if (u.pathname === "/api/backers") { sendJson(res, await rsBoards(), 20); return true; }
    if (u.pathname === "/api/collectors") {
      const id = parseInt(u.searchParams.get("id") || "0", 10) || 0; const k = String(id); const c = colCache.get(k);
      if (c && Date.now() - c.at < 20000) { sendJson(res, c.v, 15); return true; }
      let v = { ok: true, total: 0, recent: [] };
      try {
        const rows = id ? await W.q("select song_id, buyer, eth, tx, extract(epoch from at)::bigint as ts from song_sales where song_id=$1 order by block desc, idx desc limit 12", [id]) : await W.q("select song_id, buyer, eth, tx, extract(epoch from at)::bigint as ts from song_sales order by block desc, idx desc limit 12");
        const [n] = id ? await W.q("select count(*)::int as n from song_sales where song_id=$1", [id]) : await W.q("select count(*)::int as n from song_sales");
        v = { ok: true, total: n ? n.n : 0, recent: rows.map((r) => ({ id: Number(r.song_id), buyer: r.buyer.slice(0, 6) + "…" + r.buyer.slice(-4), eth: Number(r.eth), tx: r.tx, ts: Number(r.ts) })) };
      } catch (e) { v = { ok: false, total: 0, recent: [] }; }
      colCache.set(k, { at: Date.now(), v }); sendJson(res, v, 15); return true;
    }
    return false;
  };
  async function start(head) {
    await bbLoad();
    setInterval(inviteTick, 5 * 60000);
    setTimeout(wlTick, 30000); setInterval(wlTick, 60000);
    setTimeout(watchSells, 45000); setInterval(watchSells, 60000); setTimeout(watchHolders, 150000); setInterval(watchHolders, 10 * 60000);
    setTimeout(async () => { // the owner switched reminders on during quiet hours and asked for the first one straight away: post it once
      try { if ((await stGet("invitePostOn")) !== "1" || (await stGet("invitePostMsg"))) return; const [c] = await W.q("insert into bot_state(k,v) values('inviteFirstNow','1') on conflict(k) do nothing returning k"); if (!c) return;
        const ok = await inviteNow(); if (!ok) await W.q("delete from bot_state where k='inviteFirstNow'"); tgPost("sendMessage", { chat_id: ADMIN_TG, text: ok ? "Posted the first invite reminder to the main group. The next ones come at random, 5 to 10 hours apart, day and night." : "The first invite reminder failed to post. Send /invitepost now to try again." });
      } catch (e) { log("invite first err:", e.message); }
    }, 75000);
    setTimeout(async () => { // one draft of the invite reminder to the owner's DM, so it can be approved before anything posts
      try { const [c] = await W.q("insert into bot_state(k,v) values('inviteDraftDM','1') on conflict(k) do nothing returning k"); if (!c) return; const ok = await invitePromo(ADMIN_TG, true); if (!ok) await W.q("delete from bot_state where k='inviteDraftDM'"); } catch (e) { log("invite draft err:", e.message); }
    }, 60000);
    if (RS_ADDR) { setTimeout(rsSync, 20000); setInterval(rsSync, 60000); }
    setTimeout(async () => { // the owner asked for today's dev buybacks in the main group: post that summary once
      try { const [c] = await W.q("insert into bot_state(k,v) values('bbTodayOnce','1') on conflict(k) do nothing returning k"); if (!c) return;
        const n = await bbToday(chat, false); if (n < 0) await W.q("delete from bot_state where k='bbTodayOnce'");
        tgPost("sendMessage", { chat_id: ADMIN_TG, text: n > 0 ? `Posted to the main group: ${n} dev buyback${n === 1 ? "" : "s"} from the last 24 hours.` : n === 0 ? "I looked for buys from the saved dev wallet in the last 24 hours and found none, so nothing was posted to the main group." : "The buyback post failed. Send /buybacktoday post to try again." });
      } catch (e) { log("bb today once err:", e.message); }
    }, 90000);
    try { await W.q("create table if not exists song_sales(tx text not null, idx int not null, song_id int not null, buyer text not null, eth double precision not null, block bigint not null, at timestamptz default now(), primary key(tx, idx))"); } catch (e) { log("song_sales table err:", e.message); }
    await prefetchDay(head);
    W.startWeb(); W.refreshTiers(); setInterval(W.refreshTiers, 300000); setInterval(W.sweep, 20 * 60000);
    if (process.env.COMMANDS !== "0") pollCommands();
    if (process.env.SONG_SALES !== "off") { setTimeout(songSales, 15000); setInterval(songSales, 20000); }
    (async () => { // Who Got the Keys: a one-time DRAFT to the owner's bot DM; the main group only gets it on /keyspost
      try { const [c] = await W.q("insert into bot_state(k,v) values('keysDraftDM','1') on conflict(k) do nothing returning k"); if (!c) return;
        const r = await keysSend(ADMIN_TG, true); if (!r) { await W.q("delete from bot_state where k='keysDraftDM'"); log("keys draft dm failed"); } else log("keys draft sent to admin dm");
      } catch (e) { log("keys draft err:", e.message); }
    })();
    (async () => { // WYTE BOYZ sale announcement: a one-time DRAFT goes to the owner's bot DM; the main group only gets it when the owner sends /wytepost
      try { const [c] = await W.q("insert into bot_state(k,v) values('wyteDraftDM','1') on conflict(k) do nothing returning k"); if (!c) return;
        const r = await wyteSend(ADMIN_TG, true); if (!r) { await W.q("delete from bot_state where k='wyteDraftDM'"); log("wyte draft dm failed"); } else log("wyte draft sent to admin dm");
      } catch (e) { log("wyte draft err:", e.message); }
    })();
    (async () => { // dashboard is OFF unless bot_state.dashboardOn = '1'; when off, take down the pinned one
      let on = false; try { const [r] = await W.q("select v from bot_state where k='dashboardOn'"); on = !!r && r.v === "1"; } catch {}
      if (on) { updateDashboard(); setInterval(updateDashboard, 3600000); return; }
      try {
        const c = await tgPost("getChat", { chat_id: chat }); const pm = c.result?.pinned_message;
        if (pm?.from?.is_bot && pm.text?.includes("LIVE DASHBOARD")) { await tgPost("unpinChatMessage", { chat_id: chat, message_id: pm.message_id }); const d = await tgPost("deleteMessage", { chat_id: chat, message_id: pm.message_id }); log("dashboard removed:", d.ok ? "deleted" : d.description); }
        else log("dashboard off");
      } catch (e) { log("dashboard cleanup err:", e.message); }
    })();
    BURN.start();     watchMilestones(); setInterval(watchMilestones, 30000); setInterval(compCheckEnd, 60000); setInterval(compPost, 10 * 60000); setTimeout(compPost, 120000);
    setInterval(dailyCheck, 60000);
    log("extras ready: commands, milestones, leaderboard (dashboard off)");
  }
  return { start, sendBuyback, cardExtras, market, leaderboardText, isTeam, buyerCached: (tx) => BUYER.get(tx), setTeam: (a) => { TEAM = (a || "").toLowerCase(); } };
}
