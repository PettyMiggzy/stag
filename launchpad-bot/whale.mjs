// Wallet linking (sign a message, no gas, no approvals), Herd ranks, whale-group gate, and the arcade score API.
// A holder links one or more wallets by signing a message. Balances come from the on-chain Transfer logs the bot already tracks.
import http from "node:http";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { ethers } from "ethers";

export function initWhale(X) {
  const { CFG, ST, fmt, short, log, tgPost, ethUsd } = X;
  const DB = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null; // HTTPS driver, no TCP port needed
  const q = async (sql, args = []) => { if (!DB) throw new Error("no database"); return await DB.query(sql, args); };
  const WHALE_MIN = parseFloat(process.env.WHALE_MIN || "10000000");
  let WHALE_CHAT = process.env.WHALE_CHAT_ID || ""; // the Hood Rich Club chat id: env wins, else bot_state in the database (so it can be set without touching env vars)
  async function loadChat() { if (!DB || process.env.WHALE_CHAT_ID) return; try { await q("create table if not exists bot_state(k text primary key, v text not null, updated_at timestamptz default now())"); const [r] = await q("select v from bot_state where k='whaleChat'"); if (r && r.v && r.v !== WHALE_CHAT) { WHALE_CHAT = r.v; log("club chat id:", WHALE_CHAT); } } catch (e) { log("club chat load err:", e.message); } }
  const migrateChat = async (resp) => { const to = resp?.parameters?.migrate_to_chat_id; if (!to) return false; WHALE_CHAT = String(to); try { await q("insert into bot_state(k,v) values('whaleChat',$1) on conflict(k) do update set v=excluded.v, updated_at=now()", [WHALE_CHAT]); } catch {} log("club chat upgraded to supergroup:", WHALE_CHAT); return true; };
  const PUBLIC = (process.env.PUBLIC_URL || "https://buybot.stagwifhood.fun").replace(/\/$/, "");
  const BOT_USER = process.env.BOT_USERNAME || "stagzbuybot";
  const TIERS = [[WHALE_MIN, "👑 Royal Stag"], [5_000_000, "🦌 Stag"], [1_000_000, "🐂 Buck"], [100_000, "🍃 Fawn"]].sort((a, b) => b[0] - a[0]);
  const tierFor = (n) => (TIERS.find(([min]) => n >= min) || [0, ""])[1];
  const bal = (a) => Number(ethers.formatUnits(ST.bal.get(a.toLowerCase()) || 0n, 18));
  // Founders pass: holding a Hooded 20 NFT (the original collection) counts as the top herd rank and opens the Hood Rich Club.
  // Any of these collections gets you in free: The Hooded 20, Sherwood Saints (add WANTED etc. with FOUNDER_NFTS=addr1,addr2,...).
  const FOUNDER_NFTS = (process.env.FOUNDER_NFTS || "0x4384cB362D908d36266bDF3C31F18DB95EB127dc,0x5c309bC7D137cA4c5AC450B68D1A1d896eF28327").split(",").map((x) => x.trim()).filter(Boolean);
  const rpc = new ethers.JsonRpcProvider(CFG.rpcHttp, undefined, { staticNetwork: true });
  const nfts = FOUNDER_NFTS.map((a) => new ethers.Contract(a, ["function balanceOf(address) view returns (uint256)"], rpc));
  const fCache = new Map(); // address -> { n, at }
  async function founderCount(addr) {
    const k = addr.toLowerCase(); const c = fCache.get(k); if (c && Date.now() - c.at < 300000) return c.n;
    try { let n = 0; for (const c of nfts) n += Number(await c.balanceOf(k)); fCache.set(k, { n, at: Date.now() }); return n; } catch (e) { log("founder check err:", e.shortMessage || e.message); return c ? c.n : 0; }
  }
  const founderTotal = async (addrs) => { let t = 0; for (const a of addrs) t += await founderCount(a); return t; };
  const FOUNDER = "🏹 Founder";
  const dm = (id, text, extra = {}) => tgPost("sendMessage", { chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

  // address -> herd tier cache (only wallets people chose to link)
  let tierCache = new Map();
  async function refreshTiers() {
    if (!DB) return;
    try {
      const rows = await q("select tg_id, address from wallet_links");
      const by = new Map(); for (const r of rows) (by.get(String(r.tg_id)) || by.set(String(r.tg_id), []).get(String(r.tg_id))).push(r.address);
      const m = new Map();
      for (const [, addrs] of by) { let t = tierFor(addrs.reduce((s, a) => s + bal(a), 0)); if (await founderTotal(addrs) > 0) t = t ? `${t} · ${FOUNDER}` : FOUNDER; for (const a of addrs) if (t) m.set(a, t); }
      tierCache = m;
    } catch (e) { log("tier refresh err:", e.message); }
  }
  const tierOf = (addr) => tierCache.get((addr || "").toLowerCase()) || "";

  async function totalFor(tg) {
    const rows = await q("select address from wallet_links where tg_id=$1", [tg]);
    const addrs = rows.map((r) => r.address); return { addrs, total: addrs.reduce((s, a) => s + bal(a), 0), founders: await founderTotal(addrs) };
  }

  async function newNonce(tg) {
    const n = crypto.randomBytes(16).toString("hex");
    await q("insert into link_nonces(nonce, tg_id, expires_at) values ($1,$2, now() + interval '30 minutes')", [n, tg]);
    return n;
  }
  const linkMsg = (tg, n, addr) => `Link this wallet to my $STAG Telegram account.\nTelegram ID: ${tg}\nNonce: ${n}\nWallet: ${addr}\nThis signs a message only. It costs no gas and gives no access to funds.`;

  async function sendLinkFlow(tg) {
    const n = await newNonce(tg);
    const r = await dm(tg, "🔗 <b>Link your wallet(s)</b>\n\nOpen the link below <b>inside your wallet app's browser</b> (MetaMask, Rabby, Coinbase Wallet…) and sign the message. It's a plain signature: no transaction, no gas, no approvals.\n\nYou can link several wallets. Their $STAG balances are added together.\n\nSend /wallets to see your linked wallets and rank.", { reply_markup: { inline_keyboard: [[{ text: "🔗 Link a wallet", url: `${PUBLIC}/verify?n=${n}` }]] } });
    return r.ok;
  }

  // ---- whale gate ----
  async function evaluate(tg) {
    if (!DB) return;
    try {
      const { addrs, total, founders } = await totalFor(tg); const base = tierFor(total); const tier = founders > 0 ? (base ? `${base} · ${FOUNDER}` : FOUNDER) : base; const pass = total >= WHALE_MIN || founders > 0;
      if (WHALE_CHAT) {
        const [m] = await q("select tg_id from whale_members where tg_id=$1", [tg]);
        if (pass && !m) {
          const inv = await tgPost("createChatInviteLink", { chat_id: WHALE_CHAT, member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 3600, name: `whale ${tg}` });
          if (inv.ok) {
            await q("insert into whale_members(tg_id) values ($1) on conflict do nothing", [tg]);
            await dm(tg, `👑 <b>Verified: ${founders > 0 ? `${founders} Founder NFT${founders > 1 ? "s" : ""}` : `${fmt(total, 0)} $STAG`}</b>\nWelcome to the Hood Rich Club, you're in. This invite works once and expires in 1 hour.`, { reply_markup: { inline_keyboard: [[{ text: "👑 Join the Hood Rich Club", url: inv.result.invite_link }]] } });
          } else { log("club invite err:", inv.description); await migrateChat(inv); }
        } else if (!pass && m) {
          await tgPost("banChatMember", { chat_id: WHALE_CHAT, user_id: tg }); await tgPost("unbanChatMember", { chat_id: WHALE_CHAT, user_id: tg, only_if_banned: true });
          await q("delete from whale_members where tg_id=$1", [tg]);
          await dm(tg, `Your linked wallets now hold ${fmt(total, 0)} $STAG, below the ${fmt(WHALE_MIN, 0)} needed for the Hood Rich Club (and no Hooded 20 / Sherwood Saints NFT is linked), so I removed you. Buy back in and send /hoodrich to rejoin.`);
        } else if (m) await q("update whale_members set last_ok=now() where tg_id=$1", [tg]);
      }
      if (process.env.TAG_CHAT_ID && tier) tgPost("setChatMemberTag", { chat_id: process.env.TAG_CHAT_ID, user_id: tg, tag: tier.replace(/^\S+\s/, "") }).then((r) => { if (!r.ok) log("tag err:", r.description); });
      return { addrs, total, tier };
    } catch (e) { log("evaluate err:", e.message); }
  }
  async function sweep() { try { await loadChat(); const ids = await q("select distinct tg_id from wallet_links"); for (const r of ids) await evaluate(Number(r.tg_id)); await refreshTiers(); } catch (e) { log("sweep err:", e.message); } }

  // ---- bot commands (called from extras) ----
  async function command(msg, cmd, args, reply) {
    const tg = msg.from.id; const priv = msg.chat.type === "private";
    if (!DB) return reply("Wallet linking isn't switched on yet.");
    if (cmd === "whale" || cmd === "ballerz" || cmd === "hoodrich" || (cmd === "start" && (args[0] === "whale" || args[0] === "ballerz" || args[0] === "hoodrich")) || cmd === "link") {
      if (priv) { const ok = await sendLinkFlow(tg); return ok ? null : reply("Couldn't send the link. Try again."); }
      const ok = await sendLinkFlow(tg);
      return reply(ok ? `👑 <b>Hood Rich Club access</b>\nHold ${fmt(WHALE_MIN, 0)}+ $STAG (across any wallets you link) or any Hooded 20 / Sherwood Saints NFT to get in.\nI sent you a DM with the link to verify.` : `👑 <b>Hood Rich Club access</b>\nHold ${fmt(WHALE_MIN, 0)}+ $STAG across your wallets. Tap below, press Start, then send /hoodrich again.`, ok ? {} : { reply_markup: { inline_keyboard: [[{ text: "Start the bot", url: `https://t.me/${BOT_USER}?start=whale`, style: "primary" }]] } });
    }
    if (cmd === "wallets" || cmd === "rank") {
      const info = await totalFor(tg);
      if (!info.addrs.length) return reply("You haven't linked a wallet yet. Send /hoodrich and follow the link.");
      const lines = info.addrs.map((a) => `• <code>${short(a)}</code> · ${fmt(bal(a), 0)} $STAG`);
      const t = tierFor(info.total);
      const fn = info.founders; return reply(`<b>Your herd rank: ${t || "none yet"}${fn > 0 ? ` · ${FOUNDER}` : ""}</b>${fn > 0 ? `\n🏹 ${fn} Founder NFT${fn > 1 ? "s" : ""} found (Hooded 20 / Sherwood Saints). Founders get into the Hood Rich Club.` : ""}\nTotal <b>${fmt(info.total, 0)}</b> $STAG across ${info.addrs.length} wallet${info.addrs.length > 1 ? "s" : ""}\n${lines.join("\n")}\n\nHood Rich Club needs ${fmt(WHALE_MIN, 0)}. Send /hoodrich to link another wallet.`);
    }
    if (cmd === "unlink") {
      const a = (args[0] || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return reply("Use: <code>/unlink 0xWallet</code>");
      await q("delete from wallet_links where tg_id=$1 and address=$2", [tg, a]); await evaluate(tg); await refreshTiers(); return reply("Unlinked.");
    }
    return undefined;
  }

  // ---- web: wallet signing page + score API ----
  const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Link wallet · $STAG</title>
<style>body{margin:0;background:#050a08;color:#e9f2e5;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}.c{max-width:420px;width:100%;text-align:center}h1{color:#39ff88;margin:0 0 6px}button{width:100%;padding:16px;border:0;border-radius:12px;background:#39ff88;color:#012;font-size:18px;font-weight:700;margin-top:14px;cursor:pointer}p{color:#9bb197;line-height:1.5}#s{margin-top:16px;word-break:break-word}</style>
<div class=c><h1>🦌 Link your wallet</h1><p>Sign a message to prove you own this wallet. No gas, no transaction, no approvals.</p><button id=b>Connect & sign</button><div id=s></div><p style="font-size:13px">Use your wallet app's built-in browser (MetaMask, Rabby, Coinbase Wallet). Linking more wallets adds them together.</p></div>
<script>
const n=new URLSearchParams(location.search).get('n');const s=document.getElementById('s'),b=document.getElementById('b');
b.onclick=async()=>{try{
 if(!window.ethereum){s.textContent='No wallet found. Open this page inside your wallet app\\'s browser.';return}
 const info=await (await fetch('/api/nonce?n='+n)).json();if(!info.ok){s.textContent='This link expired. Send /hoodrich in Telegram again.';return}
 const [a]=await window.ethereum.request({method:'eth_requestAccounts'});
 const msg='Link this wallet to my $STAG Telegram account.\\nTelegram ID: '+info.tg+'\\nNonce: '+n+'\\nWallet: '+a+'\\nThis signs a message only. It costs no gas and gives no access to funds.';
 const sig=await window.ethereum.request({method:'personal_sign',params:[msg,a]});
 const r=await (await fetch('/api/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nonce:n,address:a,signature:sig})})).json();
 s.textContent=r.ok?'✅ Linked! Go back to Telegram — I sent you a message.':'❌ '+(r.error||'failed');
}catch(e){s.textContent='❌ '+(e.message||e)}};
</script>`;
  const json = (res, code, obj, extra = {}) => { res.writeHead(code, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(obj)); };
  const body = (req, max = 20000) => new Promise((ok) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > max) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch { ok({}); } }); });
  function checkInitData(initData) {
    try {
      const p = new URLSearchParams(initData); const hash = p.get("hash"); p.delete("hash");
      const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
      const secret = crypto.createHmac("sha256", "WebAppData").update(CFG.tg).digest();
      const h = crypto.createHmac("sha256", secret).update(str).digest("hex");
      if (h !== hash) return null; if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
      return JSON.parse(p.get("user") || "null");
    } catch { return null; }
  }
  const CORS = { "access-control-allow-origin": "https://stagwifhood.fun", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST,OPTIONS" };
  const CARDS = new Map();
  function startWeb() {
    http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, "http://x");
        if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
        if (u.pathname === "/verify") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGE); }
        if (u.pathname === "/api/claimstats") { res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=10", "access-control-allow-origin": "*" }); return res.end(JSON.stringify(claimStatsJson())); }
        if (u.pathname === "/api/nonce") { const [r] = await q("select tg_id from link_nonces where nonce=$1 and expires_at>now()", [u.searchParams.get("n") || ""]); return json(res, 200, r ? { ok: true, tg: String(r.tg_id) } : { ok: false }); }
        if (u.pathname === "/api/verify" && req.method === "POST") {
          const b = await body(req); const [r] = await q("select tg_id from link_nonces where nonce=$1 and expires_at>now()", [String(b.nonce || "")]);
          if (!r) return json(res, 200, { ok: false, error: "link expired, send /hoodrich again" });
          const addr = String(b.address || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(addr)) return json(res, 200, { ok: false, error: "bad address" });
          let rec = ""; try { rec = ethers.verifyMessage(linkMsg(String(r.tg_id), b.nonce, b.address), String(b.signature || "")).toLowerCase(); } catch {}
          if (rec !== addr) { // smart-contract wallets (Safe etc.) sign via EIP-1271
            let ok1271 = false; try { if ((await rpc.getCode(addr)).length > 2) { const c = new ethers.Contract(addr, ["function isValidSignature(bytes32,bytes) view returns (bytes4)"], rpc); ok1271 = (await c.isValidSignature(ethers.hashMessage(linkMsg(String(r.tg_id), b.nonce, b.address)), String(b.signature || ""))) === "0x1626ba7e"; } } catch {}
            if (!ok1271) return json(res, 200, { ok: false, error: "signature does not match" });
          }
          await q("insert into wallet_links(tg_id, address) values ($1,$2) on conflict do nothing", [r.tg_id, addr]);
          const info = await evaluate(Number(r.tg_id)); await refreshTiers();
          dm(Number(r.tg_id), `✅ <b>Wallet linked:</b> <code>${short(addr)}</code>\nTotal <b>${fmt(info?.total || 0, 0)}</b> $STAG across ${info?.addrs.length || 1} wallet(s).\nHerd rank: <b>${info?.tier || "none yet"}</b>${WHALE_CHAT ? `\n\nHood Rich Club needs ${fmt(WHALE_MIN, 0)}.` : ""}`);
          return json(res, 200, { ok: true });
        }
        if (u.pathname === "/api/score" && req.method === "POST") {
          const b = await body(req); const user = checkInitData(String(b.initData || "")); const score = Math.floor(Number(b.score));
          if (!user || !(score >= 0 && score <= 2500)) return json(res, 200, { ok: false }, CORS);
          const name = [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 40) || user.username || "archer";
          await q("insert into game_scores(tg_id, name, score) values ($1,$2,$3)", [user.id, name, score]);
          const [rk] = await q("select count(*)::int as n from (select tg_id, max(score) s from game_scores where day=current_date group by tg_id) t where s > $1", [score]);
          return json(res, 200, { ok: true, rank: (rk?.n || 0) + 1 }, CORS);
        }
        if (u.pathname === "/api/card" && req.method === "POST") { // score-card image for Telegram Stories
          const b = await body(req, 1800000); const user = checkInitData(String(b.initData || ""));
          const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ""));
          if (!user || !m) return json(res, 200, { ok: false }, CORS);
          const buf = Buffer.from(m[1], "base64"); if (buf.length > 1500000) return json(res, 200, { ok: false }, CORS);
          const id = crypto.randomBytes(9).toString("hex"); CARDS.set(id, { buf, exp: Date.now() + 3600000 });
          for (const [k, v] of CARDS) if (v.exp < Date.now()) CARDS.delete(k);
          return json(res, 200, { ok: true, url: `${PUBLIC}/card/${id}.jpg` }, CORS);
        }
        if (u.pathname.startsWith("/card/")) { const c = CARDS.get(u.pathname.slice(6).replace(/\.jpg$/, "")); if (!c) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=600" }); return res.end(c.buf); }
        if (u.pathname === "/api/prepare" && req.method === "POST") { // prepared inline message so the player can challenge a friend
          const b = await body(req); const user = checkInitData(String(b.initData || "")); const score = Math.floor(Number(b.score));
          if (!user || !(score >= 0 && score <= 2500)) return json(res, 200, { ok: false }, CORS);
          const r = await tgPost("savePreparedInlineMessage", { user_id: user.id, result: { type: "article", id: crypto.randomBytes(6).toString("hex"), title: "Beat my Stag Shot score", input_message_content: { message_text: `🏹 I scored ${score} in Stag Shot, 3D forest archery by $STAG. Think you can beat me?` }, reply_markup: { inline_keyboard: [[{ text: "🏹 Play Stag Shot", url: process.env.MINIAPP_URL || "https://stagwifhood.fun/play/" }]] } }, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: false, allow_bot_chats: false });
          return json(res, 200, r.ok ? { ok: true, id: r.result.id } : { ok: false, error: r.description }, CORS);
        }
        res.writeHead(200, { "content-type": "text/plain" }); res.end("stag bot ok");
      } catch (e) { json(res, 500, { ok: false }); }
    }).listen(+process.env.PORT || 3000);
  }
  async function topArchers(limit = 5) { return q("select name, max(score) as s from game_scores where day=current_date group by tg_id, name order by s desc limit $1", [limit]); }

  // ---- old staking rewards: live totals (claimable now + lifetime claimed), read straight from chain events ----
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const CLAIMED_T = "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a"; // Claimed(address indexed user, uint256 ethAmount)
  const CPOOLS = [{ key: "hooded", to: "0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF" }, { key: "vault", to: "0x9eeE6eFe6540C3e3AC515D052c99ad4b389a344c" }]
    .map((p) => ({ ...p, from: 20000000, users: new Set(), claimedWei: 0n, claims: 0, claimableWei: 0n, claimableWallets: 0, last: 0 }));
  const CS = { ready: false, updated: 0 };
  const rcall = async (method, params) => { for (let i = 0; i < 6; i++) { try { return await rpc.send(method, params); } catch (e) { if (i === 5) throw e; await wait(1500 * (i + 1)); } } };
  let csBusy = false;
  async function refreshClaims() {
    if (csBusy) return; csBusy = true;
    try {
      const head = Number(await rcall("eth_blockNumber", [])) || await rpc.getBlockNumber();
      const VCOLS = ["0x5c309bC7D137cA4c5AC450B68D1A1d896eF28327", "0x35c57109217319Df9feF0499F56b3f6a68d50931"]; // Sherwood Saints + WANTED, the collections the Vault accepts
      const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      for (const p of CPOOLS) {
        let f = p.from;
        while (f <= head) {
          const t = Math.min(f + 9000000, head);
          const logs = await rcall("eth_getLogs", [{ address: p.to, fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16) }]);
          for (const l of logs) {
            if (l.topics[1]) p.users.add("0x" + l.topics[1].slice(-40));
            if (l.topics[0] === CLAIMED_T) { p.claimedWei += BigInt(l.data); p.claims++; p.last = Math.max(p.last, parseInt(l.blockNumber, 16)); }
          }
          f = t + 1;
        }
        p.from = f;
        if (p.key === "vault") { // the Vault emits almost no events of its own: stakers are whoever sent it an NFT, plus anyone who stakes in the other pool
          const vpad = "0x" + p.to.slice(2).toLowerCase().padStart(64, "0"); let g = p.colFrom || 20000000;
          while (g <= head) { const t2 = Math.min(g + 9000000, head); for (const c of VCOLS) { const ls = await rcall("eth_getLogs", [{ address: c, topics: [TRANSFER, null, vpad], fromBlock: "0x" + g.toString(16), toBlock: "0x" + t2.toString(16) }]); for (const l of ls) if (l.topics[1]) p.users.add("0x" + l.topics[1].slice(-40)); } g = t2 + 1; }
          p.colFrom = g;
          for (const q of CPOOLS) if (q.key !== "vault") for (const u of q.users) p.users.add(u);
        }
        let tot = 0n, n = 0;
        for (const u of p.users) { const e = BigInt(await rcall("eth_call", [{ to: p.to, data: "0x008cc262" + u.slice(2).padStart(64, "0") }, "latest"])); if (e > 0n) { tot += e; n++; } }
        p.claimableWei = tot; p.claimableWallets = n;
      }
      CS.updated = Date.now(); CS.ready = true;
    } catch (e) { log("claim stats err:", e.shortMessage || e.message); } finally { csBusy = false; }
  }
  const claimStatsJson = () => ({ ready: CS.ready, updated: CS.updated, ethUsd: Number((ethUsd && ethUsd()) || 0),
    claimableWei: CPOOLS.reduce((a, p) => a + p.claimableWei, 0n).toString(), claimableWallets: CPOOLS.reduce((a, p) => a + p.claimableWallets, 0),
    claimedWei: CPOOLS.reduce((a, p) => a + p.claimedWei, 0n).toString(), claims: CPOOLS.reduce((a, p) => a + p.claims, 0),
    pools: Object.fromEntries(CPOOLS.map((p) => [p.key, { claimableWei: p.claimableWei.toString(), claimedWei: p.claimedWei.toString(), claims: p.claims }])) });
  setTimeout(refreshClaims, 20000); setInterval(refreshClaims, 60000);

  // ---- Hood Rich Club recruitment post: every 4h in the main group, replaces its own previous post. Off until bot_state.clubPromoOn = '1'. ----
  const PROMO_MS = (parseFloat(process.env.CLUB_PROMO_HOURS || "4") || 4) * 3600e3;
  const stGet = async (k) => { const [r] = await q("select v from bot_state where k=$1", [k]); return r ? r.v : null; };
  const stSet = async (k, v) => { await q("insert into bot_state(k,v) values($1,$2) on conflict(k) do update set v=excluded.v, updated_at=now()", [k, String(v)]); };
  const PROMO_CAPTION = `👑 <b>HOOD RICH CLUB</b>\nThe private room for the herd's biggest holders.\n\nYou're in if you have:\n• <b>10,000,000+ $STAG</b> across your linked wallets, or\n• <b>any Hooded 20 or Sherwood Saints NFT</b>: free entry\n\nTap the button, link your wallet (a signature only: no gas, no approvals, no access to funds) and I'll DM your invite.`;
  async function clubPromo() {
    if (!DB || !CFG.tg || !CFG.tgChat) return;
    try {
      if ((await stGet("clubPromoOn")) !== "1") return;
      const last = parseInt((await stGet("clubPromoAt")) || "0", 10);
      if (Date.now() - last < PROMO_MS) return;
      await stSet("clubPromoAt", Date.now()); // claim the slot first so a restart or two instances never double-post
      const prev = await stGet("clubPromoMsg");
      const fd = new FormData(); fd.append("chat_id", CFG.tgChat); fd.append("caption", PROMO_CAPTION); fd.append("parse_mode", "HTML");
      fd.append("reply_markup", JSON.stringify({ inline_keyboard: [[{ text: "👑 Join the Hood Rich Club", url: `https://t.me/${BOT_USER}?start=hoodrich`, style: "success" }]] }));
      fd.append("photo", new Blob([readFileSync(new URL("./clubpromo.jpg", import.meta.url))], { type: "image/jpeg" }), "club.jpg");
      const r = await (await fetch(`https://api.telegram.org/bot${CFG.tg}/sendPhoto`, { method: "POST", body: fd })).json();
      if (r.ok) { await stSet("clubPromoMsg", r.result.message_id); if (prev) tgPost("deleteMessage", { chat_id: CFG.tgChat, message_id: Number(prev) }); log("club promo posted"); }
      else log("club promo err:", r.description);
    } catch (e) { log("club promo err:", e.message); }
  }
  setInterval(clubPromo, 10 * 60 * 1000); setTimeout(clubPromo, 90 * 1000);
  loadChat();
  return { founderCount, startWeb, command, tierOf, refreshTiers, sweep, topArchers, tierFor, hasDb: !!DB, q };
}
