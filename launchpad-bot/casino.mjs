// The Hood Rich Club casino floor: slots, blackjack and roulette on PLAY CHIPS ONLY (no cash value, nothing to buy or cash out).
// Every result is drawn on the server with a cryptographic random number generator; the browser only displays it.
// Chips are the same balance as the poker table (see pokerroom.mjs) and top up free once a day.
import crypto from "node:crypto";
import { chipsFor, saveChips, TOPUP_LEVEL, todayStr } from "./pokerroom.mjs";

const rnd = (n) => crypto.randomInt(n);
const BETS = [50, 100, 250, 500, 1000];

// ---------------- slots ----------------
const SYM = ["🦌", "👑", "💎", "🔔", "🍒", "🍋"];
const WEIGHT = [2, 4, 6, 9, 14, 20]; // stag is rare, lemon is common
const PAY3 = [120, 50, 25, 12, 7, 5]; // three of a kind, times the bet
const bag = []; WEIGHT.forEach((w, i) => { for (let k = 0; k < w; k++) bag.push(i); });
export function slotSpin() {
  const r = [bag[rnd(bag.length)], bag[rnd(bag.length)], bag[rnd(bag.length)]];
  return { reels: r, mult: slotMult(r) };
}
export function slotMult(r) {
  if (r[0] === r[1] && r[1] === r[2]) return PAY3[r[0]];
  const cherries = r.filter((x) => x === 4).length; if (cherries === 2) return 2; if (cherries === 1) return 0.5;
  return 0;
}

// ---------------- blackjack ----------------
const rankOf = (c) => c % 13; // 0..12 => 2..A
const val = (c) => { const r = rankOf(c); return r === 12 ? 11 : r >= 9 ? 10 : r + 2; };
export function total(hand) { let t = 0, aces = 0; for (const c of hand) { t += val(c); if (rankOf(c) === 12) aces++; } while (t > 21 && aces) { t -= 10; aces--; } return t; }
const isBJ = (h) => h.length === 2 && total(h) === 21;
function shuffled() { const d = [...Array(52).keys()]; for (let i = 51; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; } return d; }

// ---------------- roulette ----------------
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export function rouletteMult(k, n) { // returns the total multiplier on the stake (0 = lost, 2 = even money, 36 = straight)
  if (k[0] === "n") return Number(k.slice(1)) === n ? 36 : 0;
  if (n === 0) return 0;
  switch (k) {
    case "red": return REDS.has(n) ? 2 : 0; case "black": return !REDS.has(n) ? 2 : 0;
    case "odd": return n % 2 === 1 ? 2 : 0; case "even": return n % 2 === 0 ? 2 : 0;
    case "low": return n <= 18 ? 2 : 0; case "high": return n >= 19 ? 2 : 0;
    case "d1": return n <= 12 ? 3 : 0; case "d2": return n >= 13 && n <= 24 ? 3 : 0; case "d3": return n >= 25 ? 3 : 0;
    case "c1": return n % 3 === 1 ? 3 : 0; case "c2": return n % 3 === 2 ? 3 : 0; case "c3": return n % 3 === 0 ? 3 : 0;
  } return 0;
}
const validKey = (k) => /^n([0-9]|[1-2][0-9]|3[0-6])$/.test(k) || ["red", "black", "odd", "even", "low", "high", "d1", "d2", "d3", "c1", "c2", "c3"].includes(k);
const MINB = 25, MAXROUND = 5000, BET_MS = 20000, SPIN_MS = 7000, SHOW_MS = 5000;

export class Casino {
  constructor(deps) { this.send = deps.send; this.bj = new Map(); this.last = new Map(); this.rl = { phase: "bet", until: 0, bets: new Map(), watchers: new Map(), history: [], timer: null, result: -1 }; }
  ok(me, ms = 450) { const now = Date.now(); if (now - (this.last.get(me.addr) || 0) < ms) return false; this.last.set(me.addr, now); return true; }
  async handle(me, m) {
    if (m.t === "cgslots") return this.slots(me, m);
    if (m.t === "cgbj") return this.blackjack(me, m);
    if (m.t === "cgrl") return this.roulette(me, m);
    if (m.t === "cgatm") return this.atm(me);
  }
  push(me, o) { this.send(me.ws, { t: "cg", ...o }); }
  async slots(me, m) {
    if (!this.ok(me, 700)) return; const bet = BETS.includes(Number(m.bet)) ? Number(m.bet) : 0; if (!bet) return;
    const c = await chipsFor(me.addr, me.name); if (c.chips < bet) return this.push(me, { g: "slots", err: "Not enough play chips. See the ATM for your free daily top-up.", chips: c.chips });
    c.chips -= bet; const s = slotSpin(); const win = Math.floor(bet * s.mult); c.chips += win; saveChips(c);
    this.push(me, { g: "slots", reels: s.reels, sym: SYM, bet, win, chips: c.chips });
  }
  async blackjack(me, m) {
    if (!this.ok(me, 300)) return; const c = await chipsFor(me.addr, me.name); let g = this.bj.get(me.addr);
    const view = (reveal, extra = {}) => ({ g: "bj", player: g.player, dealer: reveal ? g.dealer : [g.dealer[0], null], ptotal: total(g.player), dtotal: reveal ? total(g.dealer) : val(g.dealer[0]), bet: g.bet, chips: c.chips, over: g.over, result: g.result || "", win: g.win || 0, ...extra });
    if (m.a === "deal") {
      if (g && !g.over) return this.push(me, view(false));
      const bet = BETS.includes(Number(m.bet)) ? Number(m.bet) : 0; if (!bet) return;
      if (c.chips < bet) return this.push(me, { g: "bj", err: "Not enough play chips. See the ATM for your free daily top-up.", chips: c.chips });
      c.chips -= bet; const deck = shuffled(); g = { deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], bet, over: false }; this.bj.set(me.addr, g);
      if (isBJ(g.player) || isBJ(g.dealer)) return this.finish(me, c, g, view);
      return this.push(me, view(false));
    }
    if (!g || g.over) return;
    if (m.a === "hit") { g.player.push(g.deck.pop()); if (total(g.player) >= 21) return this.finish(me, c, g, view); return this.push(me, view(false)); }
    if (m.a === "stand") return this.finish(me, c, g, view);
    if (m.a === "double") { if (g.player.length !== 2 || c.chips < g.bet) return this.push(me, view(false, { err: "You can only double on your first two cards." })); c.chips -= g.bet; g.bet *= 2; g.player.push(g.deck.pop()); return this.finish(me, c, g, view); }
  }
  finish(me, c, g, view) {
    const pt = total(g.player);
    if (pt <= 21 && !(isBJ(g.player))) while (total(g.dealer) < 17) g.dealer.push(g.deck.pop()); // the dealer hits to 17
    const dt = total(g.dealer); let res, back = 0;
    if (isBJ(g.player) && isBJ(g.dealer)) { res = "Push (both blackjack)"; back = g.bet; }
    else if (isBJ(g.player)) { res = "Blackjack! Pays 3 to 2"; back = Math.floor(g.bet * 2.5); }
    else if (isBJ(g.dealer)) { res = "Dealer has blackjack"; }
    else if (pt > 21) res = "Bust"; else if (dt > 21) { res = "Dealer busts. You win"; back = g.bet * 2; }
    else if (pt > dt) { res = "You win"; back = g.bet * 2; } else if (pt === dt) { res = "Push"; back = g.bet; } else res = "Dealer wins";
    g.over = true; g.result = res; g.win = back; c.chips += back; saveChips(c); this.push(me, view(true));
  }
  // ---- roulette: one shared table per room ----
  async roulette(me, m) {
    const R = this.rl;
    if (m.a === "watch") { R.watchers.set(me.addr, me); this.rlStart(); const c = await chipsFor(me.addr, me.name); return this.push(me, { g: "rl", ...this.rlState(me, c) }); }
    if (m.a === "unwatch") { R.watchers.delete(me.addr); return; }
    if (R.phase !== "bet") return this.push(me, { g: "rl", err: "Bets are closed. Wait for the next round." });
    const c = await chipsFor(me.addr, me.name); const mine = R.bets.get(me.addr) || new Map();
    if (m.a === "clear") { let back = 0; for (const v of mine.values()) back += v; c.chips += back; R.bets.delete(me.addr); saveChips(c); return this.push(me, { g: "rl", ...this.rlState(me, c) }); }
    if (m.a === "bet") {
      const k = String(m.k), amt = Math.floor(Number(m.amt)); if (!validKey(k) || !(amt >= MINB) || !BETS.concat([25]).includes(amt)) return;
      const sum = [...mine.values()].reduce((a, b) => a + b, 0); if (sum + amt > MAXROUND) return this.push(me, { g: "rl", err: `Table limit is ${MAXROUND} chips a round.`, ...this.rlState(me, c) });
      if (c.chips < amt) return this.push(me, { g: "rl", err: "Not enough play chips. See the ATM for your free daily top-up.", ...this.rlState(me, c) });
      c.chips -= amt; mine.set(k, (mine.get(k) || 0) + amt); R.bets.set(me.addr, mine); saveChips(c); return this.push(me, { g: "rl", ...this.rlState(me, c) });
    }
  }
  rlState(me, c) { const R = this.rl; const mine = R.bets.get(me.addr); return { phase: R.phase, left: Math.max(0, Math.ceil((R.until - Date.now()) / 1000)), history: R.history.slice(-12), result: R.phase === "bet" ? -1 : R.result, mine: mine ? Object.fromEntries(mine) : {}, chips: c ? c.chips : undefined }; }
  rlBroadcast(extra = {}) { for (const w of this.rl.watchers.values()) { if (w.ws.readyState === 1) this.send(w.ws, { t: "cg", g: "rl", phase: this.rl.phase, left: Math.max(0, Math.ceil((this.rl.until - Date.now()) / 1000)), history: this.rl.history.slice(-12), result: this.rl.phase === "bet" ? -1 : this.rl.result, ...extra }); } }
  rlStart() { const R = this.rl; if (R.timer) return; R.phase = "bet"; R.until = Date.now() + BET_MS; this.rlBroadcast({ mine: {} }); R.timer = setTimeout(() => this.rlSpin(), BET_MS); }
  rlSpin() {
    const R = this.rl; R.result = rnd(37); R.phase = "spin"; R.until = Date.now() + SPIN_MS; this.rlBroadcast({ spinMs: SPIN_MS });
    R.timer = setTimeout(async () => {
      R.phase = "show"; R.until = Date.now() + SHOW_MS; R.history.push(R.result); if (R.history.length > 30) R.history.shift();
      for (const [addr, mine] of R.bets) { let back = 0, stake = 0; for (const [k, a] of mine) { stake += a; back += a * rouletteMult(k, R.result); }
        const w = R.watchers.get(addr); const c = w ? await chipsFor(w.addr, w.name) : null; if (c) { c.chips += back; saveChips(c); this.send(w.ws, { t: "cg", g: "rl", phase: "show", left: 5, history: R.history.slice(-12), result: R.result, mine: {}, won: back, stake, chips: c.chips }); }
        else { /* player left while the ball rolled: pay them anyway */ try { const cc = await chipsFor(addr, ""); cc.chips += back; saveChips(cc); } catch {} } }
      R.bets.clear(); this.rlBroadcast({ mine: {} });
      R.timer = setTimeout(() => { R.timer = null; if (R.watchers.size) this.rlStart(); }, SHOW_MS);
    }, SPIN_MS);
  }
  async atm(me) {
    const c = await chipsFor(me.addr, me.name);
    this.push(me, { g: "atm", chips: c.chips, used: c.topup === todayStr(), level: TOPUP_LEVEL, buy: false });
  }
  drop(me) { this.rl.watchers.delete(me.addr); this.bj.delete(me.addr); }
}
