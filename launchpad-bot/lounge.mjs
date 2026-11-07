// Hood Rich Club lounge: wallet-gated multiplayer room. HTTP login (sign a message, no gas), a WebSocket for presence + chat,
// and LiveKit voice passes. Everything is free to use for now. No wallet balances or Telegram details are ever sent to other players.
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { ethers } from "ethers";

export function initLounge(X) {
  const { q, tierFor, bal, founderCount, totalFor, log, rpc, secretSeed } = X;
  const SECRET = crypto.createHash("sha256").update("lounge:" + secretSeed).digest(); // signs session tokens; derived from the bot token so no new env var is needed
  const MIN_TOTAL = parseFloat(process.env.LOUNGE_MIN || process.env.WHALE_MIN || "10000000"); // same bar as the Hood Rich Club: 10M $STAG, or any Founder NFT
  const MAX_PLAYERS = 60;
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
  const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

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
    const body = b64u(JSON.stringify({ iss: c.key, sub: p.id, name: p.name, nbf: now - 5, exp: now + 7200, metadata: JSON.stringify({ tier: p.tier }), video: { room: "hood-rich-lounge", roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false } }));
    const sig = crypto.createHmac("sha256", c.secret).update(head + "." + body).digest("base64url");
    return { url: c.url, token: head + "." + body + "." + sig };
  }

  // ---- HTTP: called from the bot's web server ----
  const json = (res, code, o) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  const readBody = (req, max = 8000) => new Promise((ok) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > max) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch { ok({}); } }); });
  async function http(req, res, u) {
    if (!u.pathname.startsWith("/api/lounge/")) return false;
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" }); res.end(); return true; }
    if (u.pathname === "/api/lounge/status") { json(res, 200, { online: players.size, names: [...players.values()].slice(0, 12).map((p) => ({ name: p.name, tier: p.tier })) }); return true; }
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
      if (!r.ok) { json(res, 200, { ok: false, locked: true, error: "The lounge opens at 10,000,000 $STAG (across your linked wallets) or with a Hooded 20, Sherwood Saints or WANTED NFT. Link wallets with /hoodrich in the Telegram bot." }); return true; }
      const tier = r.tier || "Founder";
      const tok = sign({ a, tier, founder: r.founder, lvl: LEVEL[r.tier] ?? 0, exp: Date.now() + 12 * 3600e3 });
      json(res, 200, { ok: true, token: tok, tier, founder: r.founder, short: a.slice(0, 6) + "…" + a.slice(-4) }); return true;
    }
    json(res, 404, { ok: false }); return true;
  }

  // ---- WebSocket: presence and chat ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const players = new Map(); // id -> player
  const DRINKS = { champagne: "🥂 Champagne", whiskey: "🥃 Whiskey", mojito: "🍹 Mojito", gold: "✨ Gold Label" };
  const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const all = (o, except) => { const m = JSON.stringify(o); for (const p of players.values()) if (p.id !== except && p.ws.readyState === 1) p.ws.send(m); };
  const num = (v, lo, hi, d = 0) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  function attach(server) {
    server.on("upgrade", (req, sock, head) => {
      if ((req.url || "").split("?")[0] !== "/ws/lounge") return; // other upgrades are not ours
      wss.handleUpgrade(req, sock, head, (ws) => onSocket(ws));
    });
  }
  function onSocket(ws) {
    let me = null; const t0 = Date.now(); let lastChat = 0, lastDrink = 0, msgs = 0, win = Date.now();
    const joinTimer = setTimeout(() => { if (!me) ws.close(); }, 10000);
    ws.on("message", async (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (Date.now() - win > 5000) { win = Date.now(); msgs = 0; } if (++msgs > 150) { ws.close(); return; } // flood guard
      if (!me) {
        if (m.t !== "join") return; const s = unsign(m.token); if (!s) return send(ws, { t: "denied", why: "Session expired. Sign in again." });
        if (players.size >= MAX_PLAYERS && !players.has(s.a)) return send(ws, { t: "denied", why: "The lounge is full right now." });
        const old = players.get(s.a); if (old) { try { send(old.ws, { t: "denied", why: "Opened in another tab." }); old.ws.close(); } catch {} players.delete(s.a); all({ t: "leave", id: old.id }); }
        const name = clean(m.name, 16) || s.a.slice(0, 6) + "…" + s.a.slice(-4);
        me = { id: HEX(4), addr: s.a, name, tier: s.tier, founder: !!s.founder, lvl: s.lvl, x: 0, z: 12, ry: Math.PI, anim: "idle", drink: "", ws };
        players.set(s.a, me); clearTimeout(joinTimer);
        send(ws, { t: "welcome", id: me.id, epoch: EPOCH, now: Date.now(), players: [...players.values()].filter((p) => p !== me).map(pub), you: pub(me) });
        all({ t: "join", p: pub(me) }, me.id); log("lounge: join", name, s.tier, "online", players.size); return;
      }
      if (m.t === "pos") { me.x = num(m.x, -11, 11, me.x); me.z = num(m.z, -14.5, 14.5, me.z); me.ry = num(m.ry, -7, 7, me.ry); me.anim = ["idle", "walk", "wave"].includes(m.a) ? m.a : "idle"; me.moved = true; }
      else if (m.t === "chat") {
        const text = clean(m.text, 160); if (!text || Date.now() - lastChat < 1200) return; lastChat = Date.now();
        all({ t: "chat", id: me.id, name: me.name, tier: me.tier, text });
      } else if (m.t === "drink") {
        if (!DRINKS[m.id] || Date.now() - lastDrink < 15000) return; lastDrink = Date.now(); me.drink = m.id;
        const line = { t: "sys", text: `${DRINKS[m.id]} for ${me.name}` }; all(line); setTimeout(() => { if (me) me.drink = ""; }, 60000);
      } else if (m.t === "voice") {
        const v = await voicePass(me); send(ws, v ? { t: "voice", ...v } : { t: "voice", error: "Voice is not available right now." });
      }
    });
    ws.on("close", () => { clearTimeout(joinTimer); if (me && players.get(me.addr) === me) { players.delete(me.addr); all({ t: "leave", id: me.id }); log("lounge: leave", me.name, "online", players.size); } });
    ws.on("error", () => {});
  }
  const pub = (p) => ({ id: p.id, name: p.name, tier: p.tier, founder: p.founder, lvl: p.lvl, x: p.x, z: p.z, ry: p.ry, anim: p.anim, drink: p.drink });
  setInterval(() => { // 8 snapshots a second, only when somebody moved
    let any = false; const s = []; for (const p of players.values()) { s.push([p.id, +p.x.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2), p.anim, p.drink]); if (p.moved) { any = true; p.moved = false; } }
    if (any) all({ t: "state", s });
  }, 125);
  return { http, attach, players };
}
