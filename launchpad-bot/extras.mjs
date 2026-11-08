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

  const W = initWhale({ CFG, ST, fmt, short, log, tgPost, ethUsd: X.ethUsd });
  // ---------- buyer lookup (cached) ----------
  const BUYER = new Map();
  let TEAM = "";
  const isTeam = (tx) => !!TEAM && BUYER.get(tx) === TEAM;
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
  async function handle(msg) {
    const text = (msg.text || "").trim(); if (!text.startsWith("/")) return;
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
      if (cmd === "buy") return reply(`🟩 <b>Buy $STAG</b> on Pons (Robinhood Chain)\n${BUY}\n\nCA: <code>${CFG.token}</code>`, { reply_markup: { inline_keyboard: [[{ text: "🟩 Buy $STAG", url: BUY, style: "success" }]] } });
      if (cmd === "chart") return reply(`📈 <b>$STAG chart</b>\n${BUY}`, { reply_markup: { inline_keyboard: [[{ text: "📈 Open chart", url: CFG.chartUrl || BUY, style: "primary" }]] } });
      if (cmd === "links" || cmd === "socials" || cmd === "web") return reply(`<b>$STAG links</b>\n🟩 Buy: ${BUY}\n🌐 Site: https://stagwifhood.fun\n🏹 Game: https://stagwifhood.fun/play/\n🎵 Records: https://records.stagwifhood.fun\n💬 Telegram: https://t.me/StagWifHood\n\nCA: <code>${CFG.token}</code>`);
      if (cmd === "game" || cmd === "play") return reply(`🏹 <b>Stag Shot</b> – 3D forest archery\n${process.env.MINIAPP_URL || "https://stagwifhood.fun/play/"}`);
      if (cmd === "help" || cmd === "start") return reply("<b>$STAG bot</b>\n/ca – contract address\n/buy – buy link · /chart – chart\n/links – all links · /game – play Stag Shot\n/price · /mc · /stats – live market\n/bonding – progress to graduation\n/holders – holder count\n/top – top buyers (24h)\n/last – last buy\n/me 0x… – look up a wallet\n/song – play a Winslow Bankz clip\n/stagme <outfit or vibe> – make your own stag picture");
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

  async function start(head) {
    await prefetchDay(head);
    W.startWeb(); W.refreshTiers(); setInterval(W.refreshTiers, 300000); setInterval(W.sweep, 20 * 60000);
    if (process.env.COMMANDS !== "0") pollCommands();
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
  return { start, cardExtras, market, leaderboardText, isTeam, buyerCached: (tx) => BUYER.get(tx), setTeam: (a) => { TEAM = (a || "").toLowerCase(); } };
}
