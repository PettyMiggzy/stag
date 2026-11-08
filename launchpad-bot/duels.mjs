// Skill duels: head-to-head chess and trivia in the lounge. PLAY CHIPS ONLY.
// Both players' wagers are taken when the match starts and paid out when it ends. Nothing here touches real money:
// REAL_STAKES stays false until a lawyer clears skill-game stakes in writing, and the wager code only moves play chips.
import crypto from "node:crypto";
import { Chess } from "chess.js";
import { BANK } from "./trivia.mjs";
import { chipsFor, saveChips } from "./pokerroom.mjs";

export const REAL_STAKES = false;
const rnd = (n) => crypto.randomInt(n);
const WAGERS = [0, 100, 250, 500, 1000];
const FAST = process.env.DUEL_TEST_FAST === "1";
const CHESS_MS = FAST ? 4000 : 5 * 60 * 1000, CHESS_INC = FAST ? 0 : 2000;
const Q_COUNT = 10, Q_MS = FAST ? 1500 : 12000, REVEAL_MS = FAST ? 200 : 3200, GRACE_MS = FAST ? 600 : 45000;
const HOUSE = { addr: "house", name: "House bot", bot: true };

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function pickQuestions(n, recent) {
  const pool = BANK.map((q, i) => i).filter((i) => !recent.has(i)); const src = pool.length >= n ? pool : BANK.map((q, i) => i);
  return shuffle([...src]).slice(0, n).map((i) => { const [q, a, w] = BANK[i]; const opts = shuffle([a, ...w]); return { id: i, q, opts, c: opts.indexOf(a) }; });
}
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function material(ch, side) { let s = 0; for (const row of ch.board()) for (const p of row) if (p) s += (p.color === side ? 1 : -1) * VAL[p.type]; return s; }
function botMove(ch) { // a modest opponent: looks two plies ahead on material, with a little randomness
  const side = ch.turn(); let best = [], bv = -1e9;
  for (const m of ch.moves({ verbose: true })) {
    ch.move(m); let v;
    if (ch.isCheckmate()) v = 1000; else if (ch.isDraw()) v = 0;
    else { let worst = 1e9; for (const r of ch.moves({ verbose: true })) { ch.move(r); const e = ch.isCheckmate() ? -1000 : material(ch, side); ch.undo(); if (e < worst) worst = e; } v = worst === 1e9 ? 0 : worst; }
    ch.undo(); v += Math.random() * 0.35;
    if (v > bv + 1e-9) { bv = v; best = [m]; } else if (Math.abs(v - bv) < 0.2) best.push(m);
  }
  return best[rnd(best.length)] || null;
}

export class Duels {
  constructor(deps) { this.send = deps.send; this.open = new Map(); this.matches = new Map(); this.inMatch = new Map(); this.watch = new Map(); this.last = new Map(); this.seq = 0; this.recentQ = new Map(); }
  ok(me, ms = 150) { const n = Date.now(); if (n - (this.last.get(me.addr) || 0) < ms) return false; this.last.set(me.addr, n); return true; }
  push(me, o) { if (me && me.ws && me.ws.readyState === 1) this.send(me.ws, { t: "du", ...o }); }
  async handle(me, m) {
    if (!this.ok(me, 120)) return;
    if (m.t === "duwatch") { if (m.on) { this.watch.set(me.addr, me); this.resume(me); this.lobbyTo(me); } else this.watch.delete(me.addr); return; }
    if (m.t === "ducreate") return this.create(me, m);
    if (m.t === "dujoin") return this.join(me, String(m.id));
    if (m.t === "ducancel") { for (const [id, c] of this.open) if (c.by.addr === me.addr) this.open.delete(id); return this.lobbyAll(); }
    if (m.t === "dupractice") { if (this.inMatch.has(me.addr)) return; return this.startMatch(this.mkPlayer(me), { ...HOUSE }, m.game === "trivia" ? "trivia" : "chess", 0); }
    if (false) return this.startMatch(this.mkPlayer(me), { ...HOUSE }, m.game === "trivia" ? "trivia" : "chess", 0);
    const mt = this.matches.get(this.inMatch.get(me.addr)); if (!mt) return;
    if (m.t === "dumove" && mt.game === "chess") return this.chessMove(mt, me, m);
    if (m.t === "duresign") return this.finish(mt, mt.players[0].addr === me.addr ? 1 : 0, "resigned");
    if (m.t === "dudraw" && mt.game === "chess") return this.drawMsg(mt, me, m.a);
    if (m.t === "duans" && mt.game === "trivia") return this.answer(mt, me, Math.floor(Number(m.i)), Math.floor(Number(m.q)));
  }
  mkPlayer(me) { return { addr: me.addr, name: me.name, me }; }
  resume(me) { const id = this.inMatch.get(me.addr); const mt = id && this.matches.get(id); if (!mt) return; const p = mt.players.find((x) => x.addr === me.addr); if (p) { p.me = me; clearTimeout(p.dcTimer); p.dcTimer = null; this.state(mt, p); } }
  async create(me, m) {
    const game = m.game === "trivia" ? "trivia" : m.game === "chess" ? "chess" : ""; const wager = WAGERS.includes(Number(m.wager)) ? Number(m.wager) : -1; if (!game || wager < 0) return;
    if (this.inMatch.has(me.addr)) return this.push(me, { k: "err", why: "You are already in a match." });
    for (const c of this.open.values()) if (c.by.addr === me.addr) return this.push(me, { k: "err", why: "You already have an open challenge." });
    const c = await chipsFor(me.addr, me.name); if (c.chips < wager) return this.push(me, { k: "err", why: "Not enough play chips for that wager. Try the ATM or a smaller one." });
    // an open challenge of the same kind from someone else? join it instead of waiting
    for (const [id, o] of this.open) if (o.game === game && o.wager === wager && o.by.addr !== me.addr) return this.join(me, id);
    const id = "c" + (++this.seq); this.open.set(id, { id, game, wager, by: this.mkPlayer(me), at: Date.now() }); this.lobbyAll();
    this.push(me, { k: "waiting", id, game, wager });
  }
  async join(me, id) {
    const c = this.open.get(id); if (!c || c.by.addr === me.addr) return; if (this.inMatch.has(me.addr) || this.inMatch.has(c.by.addr)) return;
    const a = await chipsFor(c.by.addr, c.by.name), b = await chipsFor(me.addr, me.name);
    if (b.chips < c.wager) return this.push(me, { k: "err", why: "Not enough play chips for that wager." });
    if (a.chips < c.wager) { this.open.delete(id); this.lobbyAll(); return this.push(me, { k: "err", why: "That challenger no longer has the chips." }); }
    this.open.delete(id); this.lobbyAll(); return this.startMatch(c.by, this.mkPlayer(me), c.game, c.wager);
  }
  async startMatch(p0, p1, game, wager) {
    const id = "m" + (++this.seq);
    if (wager > 0) { for (const p of [p0, p1]) { const c = await chipsFor(p.addr, p.name); c.chips -= wager; saveChips(c); } }
    const order = rnd(2) ? [p0, p1] : [p1, p0]; // chess: first is white
    const mt = { id, game, wager, players: game === "chess" ? order : [p0, p1], over: false, drawOffer: -1 };
    this.matches.set(id, mt); for (const p of mt.players) if (!p.bot) this.inMatch.set(p.addr, id);
    if (game === "chess") { mt.ch = new Chess(); mt.clk = [CHESS_MS, CHESS_MS]; mt.turnAt = Date.now(); mt.last = null; this.armClock(mt); for (const p of mt.players) this.state(mt, p); this.botTurn(mt); }
    else this.triviaStart(mt);
  }
  // ---------------- chess ----------------
  side(mt) { return mt.ch.turn() === "w" ? 0 : 1; }
  armClock(mt) { clearTimeout(mt.timer); const s = this.side(mt); mt.timer = setTimeout(() => this.finish(mt, 1 - s, "time"), Math.max(50, mt.clk[s] - (Date.now() - mt.turnAt))); }
  chessMove(mt, me, m) {
    if (mt.over) return; const s = this.side(mt); const p = mt.players[s]; if (p.addr !== me.addr) return;
    const promo = "qrbn".includes(String(m.promo || "q")) ? String(m.promo || "q") : "q";
    this.applyMove(mt, { from: String(m.from), to: String(m.to), promotion: promo });
  }
  applyMove(mt, mv) {
    const s = this.side(mt); let mm; try { mm = mt.ch.move(mv); } catch { mm = null; } if (!mm) return false;
    const now = Date.now(); mt.clk[s] = mt.clk[s] - (now - mt.turnAt); if (mt.clk[s] <= 0) { mt.ch.undo(); return this.finish(mt, 1 - s, "time"), true; }
    mt.clk[s] += CHESS_INC; mt.turnAt = now; mt.last = { from: mm.from, to: mm.to, san: mm.san }; mt.drawOffer = -1;
    if (mt.ch.isCheckmate()) { this.finish(mt, s, "checkmate"); return true; }
    if (mt.ch.isDraw()) { this.finish(mt, -1, mt.ch.isStalemate() ? "stalemate" : mt.ch.isThreefoldRepetition() ? "repetition" : mt.ch.isInsufficientMaterial() ? "insufficient material" : "50-move rule"); return true; }
    this.armClock(mt); for (const p of mt.players) this.state(mt, p); this.botTurn(mt); return true;
  }
  botTurn(mt) {
    if (mt.over) return; const s = this.side(mt); if (!mt.players[s].bot) return;
    setTimeout(() => { if (mt.over || this.side(mt) !== s) return; const mv = botMove(mt.ch); if (mv) this.applyMove(mt, { from: mv.from, to: mv.to, promotion: mv.promotion || "q" }); }, FAST ? 30 : 700 + rnd(900));
  }
  drawMsg(mt, me, a) {
    if (mt.over) return; const i = mt.players.findIndex((p) => p.addr === me.addr); if (i < 0) return;
    if (mt.players[1 - i].bot) { if (a === "offer") { const up = material(mt.ch, i === 0 ? "w" : "b"); if (up <= 1) return this.finish(mt, -1, "draw agreed"); this.push(me, { k: "note", text: "The house bot declines the draw." }); } return; }
    if (a === "offer") { mt.drawOffer = i; this.state(mt, mt.players[1 - i]); this.push(me, { k: "note", text: "Draw offered." }); }
    else if (a === "accept" && mt.drawOffer === 1 - i) this.finish(mt, -1, "draw agreed");
    else if (a === "decline" && mt.drawOffer === 1 - i) { mt.drawOffer = -1; this.state(mt, mt.players[1 - i]); this.push(me, { k: "note", text: "Draw declined." }); }
  }
  legal(mt) { const o = {}; for (const m of mt.ch.moves({ verbose: true })) (o[m.from] = o[m.from] || []).push(m.to); return o; }
  state(mt, p) {
    if (p.bot) return; const i = mt.players.indexOf(p); const opp = mt.players[1 - i];
    if (mt.game === "chess") {
      const s = this.side(mt), now = Date.now(); const clk = mt.clk.map((v, k) => (k === s && !mt.over ? Math.max(0, v - (now - mt.turnAt)) : v));
      this.push(p.me, { k: "chess", id: mt.id, you: i === 0 ? "w" : "b", fen: mt.ch.fen(), turn: s === 0 ? "w" : "b", legal: s === i && !mt.over ? this.legal(mt) : {}, last: mt.last, clk, opp: opp.name, wager: mt.wager, check: mt.ch.inCheck(), offer: mt.drawOffer === 1 - i, moves: mt.ch.history().length });
    }
  }
  // ---------------- trivia ----------------
  triviaStart(mt) {
    const seen = new Set(); for (const p of mt.players) for (const x of this.recentQ.get(p.addr) || []) seen.add(x);
    mt.qs = pickQuestions(Q_COUNT + 3, seen); mt.i = -1; mt.scores = [0, 0]; mt.extra = 0;
    for (const p of mt.players) { if (p.bot) continue; const r = this.recentQ.get(p.addr) || []; this.recentQ.set(p.addr, [...r, ...mt.qs.map((q) => q.id)].slice(-60)); }
    this.nextQ(mt);
  }
  nextQ(mt) {
    if (mt.over) return; mt.i++; const q = mt.qs[mt.i]; mt.ans = [null, null]; mt.qAt = Date.now(); mt.phase = "q";
    for (const p of mt.players) this.push(p.me, { k: "tq", id: mt.id, n: mt.i + 1, of: Q_COUNT, sudden: mt.i >= Q_COUNT, q: q.q, opts: q.opts, ms: Q_MS, scores: mt.scores, opp: mt.players[1 - mt.players.indexOf(p)].name, wager: mt.wager, you: mt.players.indexOf(p) });
    mt.timer = setTimeout(() => this.reveal(mt), Q_MS + 150);
    mt.players.forEach((p, i) => { if (p.bot) setTimeout(() => { if (mt.over || mt.phase !== "q") return; const right = Math.random() < 0.62; const c = mt.qs[mt.i].c; const pick = right ? c : (c + 1 + rnd(3)) % 4; this.answer(mt, { addr: "house" }, pick, mt.i, i); }, FAST ? 40 : 2200 + rnd(6000)); });
  }
  answer(mt, me, pick, qn, forceIdx) {
    if (mt.over || mt.phase !== "q") return; const i = forceIdx !== undefined ? forceIdx : mt.players.findIndex((p) => p.addr === me.addr); if (i < 0) return;
    if (qn !== undefined && qn !== mt.i && forceIdx === undefined) return; if (mt.ans[i] || !(pick >= 0 && pick < 4)) return;
    mt.ans[i] = { pick, t: Date.now() - mt.qAt }; const opp = mt.players[1 - i]; if (!opp.bot || true) this.push(opp.me, { k: "tnote", opponentAnswered: true });
    if (mt.ans[0] && mt.ans[1]) { clearTimeout(mt.timer); this.reveal(mt); }
  }
  reveal(mt) {
    if (mt.over || mt.phase !== "q") return; mt.phase = "reveal"; clearTimeout(mt.timer); const q = mt.qs[mt.i]; const pts = [0, 0];
    mt.ans.forEach((a, i) => { if (a && a.pick === q.c) pts[i] = 100 + Math.max(0, Math.floor(100 * (1 - a.t / Q_MS))); mt.scores[i] += pts[i]; });
    for (const p of mt.players) this.push(p.me, { k: "tr", id: mt.id, correct: q.c, picks: mt.ans.map((a) => (a ? a.pick : -1)), pts, scores: mt.scores });
    mt.timer = setTimeout(() => {
      if (mt.over) return; const last = mt.i + 1 >= Q_COUNT;
      if (!last) return this.nextQ(mt);
      if (mt.scores[0] !== mt.scores[1]) return this.finish(mt, mt.scores[0] > mt.scores[1] ? 0 : 1, "points");
      if (mt.i + 1 >= Q_COUNT + 3) return this.finish(mt, -1, "tied after sudden death");
      this.nextQ(mt);
    }, REVEAL_MS);
  }
  // ---------------- results ----------------
  async finish(mt, winner, how) { // winner: index of the winning player, or -1 for a draw
    if (mt.over) return; mt.over = true; clearTimeout(mt.timer);
    for (const p of mt.players) clearTimeout(p.dcTimer);
    const back = mt.wager > 0 ? (winner < 0 ? [mt.wager, mt.wager] : winner === 0 ? [mt.wager * 2, 0] : [0, mt.wager * 2]) : [0, 0];
    const res = {};
    for (let i = 0; i < 2; i++) { const p = mt.players[i]; if (p.bot) continue; let chips; if (back[i]) { const c = await chipsFor(p.addr, p.name); c.chips += back[i]; saveChips(c); chips = c.chips; } else { chips = (await chipsFor(p.addr, p.name)).chips; } res[p.addr] = chips; }
    for (let i = 0; i < 2; i++) { const p = mt.players[i]; if (p.bot) continue; this.inMatch.delete(p.addr);
      this.push(p.me, { k: "end", id: mt.id, game: mt.game, result: winner < 0 ? "draw" : winner === i ? "win" : "loss", how, wager: mt.wager, won: winner === i ? mt.wager * 2 : winner < 0 ? mt.wager : 0, chips: res[p.addr], scores: mt.scores || null, fen: mt.ch ? mt.ch.fen() : null }); }
    setTimeout(() => this.matches.delete(mt.id), 5000);
  }
  // ---------------- lobby ----------------
  lobbyTo(me) { this.push(me, { k: "lobby", open: [...this.open.values()].map((c) => ({ id: c.id, game: c.game, wager: c.wager, by: c.by.name, mine: c.by.addr === me.addr })), playing: this.matches.size }); }
  lobbyAll() { for (const w of this.watch.values()) this.lobbyTo(w); }
  drop(me) {
    this.watch.delete(me.addr); for (const [id, c] of this.open) if (c.by.addr === me.addr) this.open.delete(id); this.lobbyAll();
    const mt = this.matches.get(this.inMatch.get(me.addr)); if (!mt || mt.over) return; const i = mt.players.findIndex((p) => p.addr === me.addr); if (i < 0) return;
    const p = mt.players[i]; if (mt.players[1 - i].bot) { return this.finish(mt, 1 - i, "left the match"); } // practice: leaving just ends it
    clearTimeout(p.dcTimer); p.dcTimer = setTimeout(() => this.finish(mt, 1 - i, "disconnected"), GRACE_MS);
  }
}
