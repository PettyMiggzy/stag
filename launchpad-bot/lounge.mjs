// Hood Rich Club lounge: wallet-gated multiplayer room. HTTP login (sign a message, no gas), a WebSocket for presence + chat,
// and LiveKit voice passes. Everything is free to use for now. No wallet balances or Telegram details are ever sent to other players.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { PokerRoom, initChips, pokerLeaders, claimDaily } from "./pokerroom.mjs";
import { Casino } from "./casino.mjs";
import { Duels } from "./duels.mjs";
import { WebSocketServer } from "ws";
import { ethers } from "ethers";

export function initLounge(X) {
  const { q, tierFor, bal, founderCount, totalFor, log, rpc, secretSeed } = X;
  initChips(q);
  const SECRET = crypto.createHash("sha256").update("lounge:" + secretSeed).digest(); // signs session tokens; derived from the bot token so no new env var is needed
  const MIN_TOTAL = parseFloat(process.env.LOUNGE_MIN || process.env.WHALE_MIN || "10000000"); // same bar as the Hood Rich Club: 10M $STAG, or any Founder NFT
  const EPOCH = Date.now();
  const HEX = (n) => crypto.randomBytes(n).toString("hex");
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const sign = (obj) => { const p = b64u(JSON.stringify(obj)); return p + "." + crypto.createHmac("sha256", SECRET).update(p).digest("base64url"); };
  const unsign = (tok) => {
    try { const [p, s] = String(tok).split("."); const good = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
      if (!s || s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
      const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
  };
  const loginMsg = (nonce, addr) => `Enter the Hood Rich Club lounge.\nNonce: ${nonce}\nWallet: ${addr}\nThis signs a message only. It costs no gas and gives no access to funds.`;
  const nonces = new Map(); // nonce -> expiry
  const guestHits = new Map(); // ip -> times a new guest pass was issued in the last hour
  const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

  let openAt = 0, openVal = false; // the doors-open switch (bot_state.loungeOpen = '1'), cached for 15 seconds
  async function isOpen() { if (Date.now() - openAt < 15000) return openVal; try { const [r] = await q("select v from bot_state where k='loungeOpen'"); openVal = !!r && r.v === "1"; } catch {} openAt = Date.now(); return openVal; }
  async function resolve(addr) { // what does this wallet hold, counting every wallet linked to the same Telegram account
    const [l] = await q("select tg_id from wallet_links where address=$1 limit 1", [addr]).catch(() => []);
    let total, founders;
    if (l) { const r = await totalFor(l.tg_id); total = r.total; founders = r.founders; }
    else { total = bal(addr); founders = await founderCount(addr); }
    const base = tierFor(total).replace(/^\S+\s/, ""); // "Royal Stag"
    return { total, founders, tier: base || (founders > 0 ? "" : ""), founder: founders > 0, ok: total >= MIN_TOTAL || founders > 0 };
  }
  const LEVEL = { "": 0, Fawn: 1, Buck: 2, Stag: 3, "Royal Stag": 4 };

  // ---- LiveKit voice pass, signed with the key stored in bot_state ----
  let lk = null, lkAt = 0;
  async function lkConf() { if (lk && Date.now() - lkAt < 60000) return lk; try { const [r] = await q("select v from bot_state where k='livekit'"); lk = r ? JSON.parse(r.v) : null; lkAt = Date.now(); } catch { lk = null; } return lk; }
  async function voicePass(p) {
    const c = await lkConf(); if (!c) return null;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64u(JSON.stringify({ iss: c.key, sub: p.id, name: p.name, nbf: now - 5, exp: now + 7200, metadata: JSON.stringify({ tier: p.tier }), video: { room: "hood-rich-lounge-" + (p.room ? p.room.n : 1), roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false } }));
    const sig = crypto.createHmac("sha256", c.secret).update(head + "." + body).digest("base64url");
    return { url: c.url, token: head + "." + body + "." + sig };
  }

  // ---- HTTP: called from the bot's web server ----
  const json = (res, code, o) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const readBody = (req, max = 8000) => new Promise((ok) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > max) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch { ok({}); } }); });
  async function http(req, res, u) {
    if (!u.pathname.startsWith("/api/lounge/")) return false;
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" }); res.end(); return true; }
    if (u.pathname === "/api/lounge/status") { const all = rooms.flatMap((r) => [...r.players.values()]); json(res, 200, { open: await isOpen(), online: all.length, rooms: rooms.map((r) => ({ n: r.n, count: r.players.size, cap: ROOM_CAP })), names: all.slice(0, 12).map((p) => ({ name: p.name, tier: p.tier })), dj: djState() }); return true; }
    if (u.pathname === "/api/lounge/poker/leaders") { json(res, 200, { week: true, leaders: await pokerLeaders(10) }); return true; }
    if (u.pathname === "/api/lounge/nonce") {
      const n = HEX(12); nonces.set(n, Date.now() + 300000); for (const [k, v] of nonces) if (v < Date.now()) nonces.delete(k);
      json(res, 200, { nonce: n }); return true;
    }
    if (u.pathname === "/api/lounge/login" && req.method === "POST") {
      const b = await readBody(req); const n = String(b.nonce || ""); const addr = String(b.address || "");
      if (!nonces.has(n) || !/^0x[0-9a-fA-F]{40}$/.test(addr)) { json(res, 200, { ok: false, error: "That sign-in expired. Reload and try again." }); return true; }
      nonces.delete(n); const a = addr.toLowerCase(); const msg = loginMsg(n, addr);
      let rec = ""; try { rec = ethers.verifyMessage(msg, String(b.signature || "")).toLowerCase(); } catch {}
      if (rec !== a) { let ok1271 = false; try { if ((await rpc.getCode(a)).length > 2) { const c = new ethers.Contract(a, ["function isValidSignature(bytes32,bytes) view returns (bytes4)"], rpc); ok1271 = (await c.isValidSignature(ethers.hashMessage(msg), String(b.signature || ""))) === "0x1626ba7e"; } } catch {} if (!ok1271) { json(res, 200, { ok: false, error: "Signature did not match that wallet." }); return true; } }
      const r = await resolve(a);
      const open = await isOpen(); if (!r.ok && open) { r.ok = true; if (!r.tier) r.tier = "Guest"; } // open doors: smaller holders still wear their real herd rank
      if (!r.ok) { json(res, 200, { ok: false, locked: true, error: "The lounge opens at 10,000,000 $STAG (across your linked wallets) or with a Hooded 20, Sherwood Saints or WANTED NFT. Link wallets with /hoodrich in the Telegram bot." }); return true; }
      const tier = r.tier || "Founder";
      const tok = sign({ a, tier, founder: r.founder, lvl: LEVEL[r.tier] ?? 0, guest: r.tier === "Guest", exp: Date.now() + 12 * 3600e3 });
      json(res, 200, { ok: true, token: tok, tier, founder: r.founder, short: a.slice(0, 6) + "…" + a.slice(-4) }); return true;
    }
    if (u.pathname === "/api/lounge/guest" && req.method === "POST") { // walk in without a wallet: only while the doors are open, limited per connection, no rank and no voice
      if (!(await isOpen())) { json(res, 200, { ok: false, error: "Guest entry is closed right now. Sign in with a holder wallet." }); return true; }
      const b = await readBody(req); const old = b.token ? unsign(b.token) : null;
      let a = old && old.nw && /^guest:[0-9a-f]{16}$/.test(old.a) ? old.a : "";
      if (!a) { // a new guest id: cap how many one connection can mint per hour
        const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "?"); const now = Date.now();
        const h = (guestHits.get(ip) || []).filter((t) => now - t < 3600e3); if (h.length >= 8) { json(res, 200, { ok: false, error: "Too many guest passes from this connection. Try again later, or sign in with a wallet." }); return true; }
        h.push(now); guestHits.set(ip, h); if (guestHits.size > 5000) guestHits.clear(); a = "guest:" + HEX(8);
      }
      const tok = sign({ a, tier: "Guest", founder: false, lvl: 0, guest: true, nw: true, exp: Date.now() + 30 * 24 * 3600e3 });
      json(res, 200, { ok: true, token: tok, tier: "Guest", short: "Guest " + a.slice(6, 10) }); return true;
    }
    json(res, 404, { ok: false }); return true;
  }

  // ---- WebSocket: presence and chat. The lounge is split into rooms of ROOM_CAP people so a crowd never melts one server or one phone. ----
  const ROOM_CAP = parseInt(process.env.LOUNGE_ROOM_CAP || "40", 10), MAX_ROOMS = 10;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const rooms = []; // [{ n, players: Map(addr -> player), tick }]
  const byAddr = new Map(); // addr -> player, so one wallet is in one place at a time
  const DRINKS = { champagne: "🥂 Champagne", whiskey: "🥃 Whiskey", mojito: "🍹 Mojito", gold: "✨ Gold Label" };
  const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const allIn = (room, o, except) => { const m = JSON.stringify(o); for (const p of room.players.values()) if (p.id !== except && p.ws.readyState === 1) p.ws.send(m); };
  const num = (v, lo, hi, d = 0) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  function pickRoom(want) { // a friend can ask for a specific room; otherwise the first one with space
    want = parseInt(want, 10); if (want >= 1 && rooms[want - 1] && rooms[want - 1].players.size < ROOM_CAP) return rooms[want - 1];
    for (const r of rooms) if (r.players.size < ROOM_CAP) return r;
    if (rooms.length >= MAX_ROOMS) return null;
    const r = { n: rooms.length + 1, players: new Map(), tick: 0 }; rooms.push(r); return r;
  }
  // ---- DJ: one shared playlist for the whole lounge, clocked by the server. Every client plays the same clip at the same point in it. ----
  let TRACKS = []; try { TRACKS = readFileSync(new URL("./clips/titles.txt", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => { const [n, ...t] = l.split("|"); return { n: n.trim(), title: t.join("|").trim(), dur: 40 }; }); } catch {}
  const dj = { idx: 0, start: Date.now(), votes: new Map() }; // votes: addr -> track index
  const tally = () => { const c = {}; for (const i of dj.votes.values()) c[i] = (c[i] || 0) + 1; return c; };
  const djState = () => ({ idx: dj.idx, start: dj.start, now: Date.now(), dur: (TRACKS[dj.idx] || { dur: 40 }).dur, titles: TRACKS.map((t) => t.title), nums: TRACKS.map((t) => t.n), votes: tally() });
  const broadcastAll = (o) => { const m = JSON.stringify(o); for (const r of rooms) for (const p of r.players.values()) if (p.ws.readyState === 1) p.ws.send(m); };
  setInterval(() => { // when a track ends, the most-voted track plays next, otherwise the next in order
    if (!TRACKS.length) return; const cur = TRACKS[dj.idx]; if (Date.now() < dj.start + cur.dur * 1000) return;
    const c = tally(); let next = (dj.idx + 1) % TRACKS.length, best = 0; for (const [i, n] of Object.entries(c)) if (n > best && +i !== dj.idx) { best = n; next = +i; }
    dj.idx = next; dj.start = Date.now(); dj.votes = new Map(); broadcastAll({ t: "dj", ...djState(), changed: true });
  }, 1000);
  function attach(server) {
    server.on("upgrade", (req, sock, head) => {
      if ((req.url || "").split("?")[0] !== "/ws/lounge") return; // other upgrades are not ours
      wss.handleUpgrade(req, sock, head, (ws) => onSocket(ws));
    });
  }
  function onSocket(ws) {
    let me = null; let lastChat = 0, lastDrink = 0, msgs = 0, win = Date.now();
    const joinTimer = setTimeout(() => { if (!me) ws.close(); }, 10000);
    ws.on("message", async (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (Date.now() - win > 5000) { win = Date.now(); msgs = 0; } if (++msgs > 150) { ws.close(); return; } // flood guard
      if (!me) {
        if (m.t !== "join") return; const s = unsign(m.token); if (!s) return send(ws, { t: "denied", why: "Session expired. Sign in again." });
        const old = byAddr.get(s.a); if (old) { try { send(old.ws, { t: "denied", why: "Opened in another tab." }); old.ws.close(); } catch {} old.room.players.delete(s.a); byAddr.delete(s.a); allIn(old.room, { t: "leave", id: old.id }); }
        const room = pickRoom(m.room); if (!room) return send(ws, { t: "denied", why: "The lounge is full right now. Try again in a bit." });
        const name = clean(m.name, 16) || (s.nw ? "Guest " + s.a.slice(6, 10) : s.a.slice(0, 6) + "…" + s.a.slice(-4));
        me = { id: HEX(4), addr: s.a, nw: !!s.nw, name, tier: s.tier, founder: !!s.founder, lvl: s.lvl, x: 0, z: 12, ry: Math.PI, anim: "idle", drink: "", ws, room };
        room.players.set(s.a, me); byAddr.set(s.a, me); clearTimeout(joinTimer);
        send(ws, { t: "welcome", id: me.id, room: room.n, cap: ROOM_CAP, epoch: EPOCH, now: Date.now(), dj: djState(), players: [...room.players.values()].filter((p) => p !== me).map(pub), you: pub(me) });
        claimDaily(me.addr, me.name, me.lvl || 0, !!me.founder).then((n) => { if (n) send(ws, { t: "sys", text: n > 500 ? `Holder daily gift: +${n} play chips for your herd rank${me.tier && me.tier !== "Guest" ? ` (${me.tier})` : ""}. Come back tomorrow for another.` : `Daily gift: +${n} play chips. Holders get up to 3,000 a day. Come back tomorrow for another.` }); }).catch(() => {});
        allIn(room, { t: "join", p: pub(me) }, me.id); log("lounge: join", name, s.tier, "room", room.n, "online", room.players.size); return;
      }
      if (m.t === "pos") { me.x = num(m.x, -11, 11, me.x); me.z = num(m.z, -14.5, 14.5, me.z); me.ry = num(m.ry, -7, 7, me.ry); me.anim = ["idle", "walk", "wave"].includes(m.a) ? m.a : "idle"; me.moved = true; }
      else if (m.t === "chat") {
        const text = clean(m.text, 160); if (!text || Date.now() - lastChat < (me.nw ? 4000 : 1200)) return;
        if (me.nw && /(https?:|www\.|t\.me|\.(com|io|xyz|fun|net|org|gg|app)\b)/i.test(text)) return send(ws, { t: "sys", text: "Guests can't post links. Sign in with a wallet to share one." });
        lastChat = Date.now();
        allIn(me.room, { t: "chat", id: me.id, name: me.name, tier: me.tier, text });
      } else if (m.t === "drink") {
        if (!DRINKS[m.id] || Date.now() - lastDrink < 15000) return; lastDrink = Date.now(); me.drink = m.id; me.moved = true;
        allIn(me.room, { t: "sys", text: `${DRINKS[m.id]} for ${me.name}` }); setTimeout(() => { if (me) { me.drink = ""; me.moved = true; } }, 60000);
      } else if (typeof m.t === "string" && m.t.startsWith("poker")) {
        const room = me.room; room.poker = room.poker || new PokerRoom({ send });
        if (m.vip) { // the high-roller table: any herd rank (100,000 $STAG or more) or a Founder NFT. Play chips only, bigger blinds.
          if (!((me.lvl || 0) >= 1 || me.founder)) return send(ws, { t: "pokererr", vip: true, why: "The VIP table is for holders: 100,000 $STAG or more, or a Founder NFT. Sign in with your holder wallet." });
          room.pokerVip = room.pokerVip || new PokerRoom({ send, vip: true });
          if (m.t === "pokersit" && room.poker.t.seatOf(me.addr) >= 0) return send(ws, { t: "pokererr", vip: true, why: "Stand up from the main table first." });
          await room.pokerVip.handle(me, m);
        } else { if (m.t === "pokersit" && room.pokerVip && room.pokerVip.t.seatOf(me.addr) >= 0) return send(ws, { t: "pokererr", why: "Stand up from the VIP table first." }); await room.poker.handle(me, m); }
      } else if (typeof m.t === "string" && m.t.startsWith("cg")) {
        const room = me.room; room.casino = room.casino || new Casino({ send }); await room.casino.handle(me, m);
      } else if (typeof m.t === "string" && m.t.startsWith("du")) {
        const room = me.room; room.duels = room.duels || new Duels({ send }); await room.duels.handle(me, m);
      } else if (m.t === "djvote") {
        const i = Math.floor(Number(m.i)); if (!(i >= 0 && i < TRACKS.length) || i === dj.idx || Date.now() - (me.lastVote || 0) < 800) return; me.lastVote = Date.now();
        dj.votes.set(me.addr, i); broadcastAll({ t: "dj", ...djState() }); send(ws, { t: "djack", i });
      } else if (m.t === "rec") {
        if (Date.now() - (me.lastRec || 0) < 1500) return; me.lastRec = Date.now(); me.rec = !!m.on; allIn(me.room, { t: "rec", id: me.id, name: me.name, on: me.rec }, me.id);
      } else if (m.t === "voice") {
        if (me.nw) return send(ws, { t: "voice", error: "Voice chat needs a wallet sign-in. Guests can listen to the room and use text chat." });
        const v = await voicePass(me); send(ws, v ? { t: "voice", ...v } : { t: "voice", error: "Voice is not available right now." });
      }
    });
    ws.on("close", () => { clearTimeout(joinTimer); if (me && byAddr.get(me.addr) === me) { try { me.room.poker && me.room.poker.drop(me); me.room.pokerVip && me.room.pokerVip.drop(me); me.room.casino && me.room.casino.drop(me); me.room.duels && me.room.duels.drop(me); } catch {} me.room.players.delete(me.addr); byAddr.delete(me.addr); allIn(me.room, { t: "leave", id: me.id }); log("lounge: leave", me.name, "room", me.room.n, "online", me.room.players.size); } });
    ws.on("error", () => {});
  }
  const pub = (p) => ({ id: p.id, name: p.name, tier: p.tier, founder: p.founder, lvl: p.lvl, x: p.x, z: p.z, ry: p.ry, anim: p.anim, drink: p.drink });
  const row = (p) => [p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2), p.anim, p.drink];
  setInterval(() => { // 8 updates a second per room: only the people who changed, plus a full refresh every 4 seconds so nobody drifts
    for (const r of rooms) {
      if (!r.players.size) continue; const full = ++r.tick % 32 === 0; const s = [];
      for (const p of r.players.values()) { if (full || p.moved) s.push(row(p)); p.moved = false; }
      if (s.length) allIn(r, { t: "state", s, full });
    }
  }, 125);
  const players = { get size() { return rooms.reduce((n, r) => n + r.players.size, 0); }, values: () => rooms.flatMap((r) => [...r.players.values()]) };
  return { http, attach, players };
}
