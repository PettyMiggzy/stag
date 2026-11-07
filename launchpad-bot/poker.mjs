// Texas Hold'em engine for the Hood Rich Club card room. PLAY CHIPS ONLY: chips have no cash value, can't be bought or cashed out.
// Pure game logic, no network or database, so it can be tested on its own. The lounge server wraps it with seats, timers and chips storage.
import crypto from "node:crypto";

const RANKS = "23456789TJQKA";
export const cardName = (c) => RANKS[c % 13] + "shdc"[Math.floor(c / 13)]; // card 0..51: rank = c % 13 (2..A), suit = floor(c / 13)

// ---- hand evaluation: returns a number, higher is better ----
function eval5(cs) {
  const r = cs.map((c) => (c % 13) + 2).sort((a, b) => b - a), s = cs.map((c) => Math.floor(c / 13));
  const flush = s.every((x) => x === s[0]);
  const uniq = [...new Set(r)]; let straightHigh = 0;
  if (uniq.length === 5) { if (r[0] - r[4] === 4) straightHigh = r[0]; else if (r[0] === 14 && r[1] === 5) straightHigh = 5; } // A-5 wheel
  const cnt = new Map(); for (const x of r) cnt.set(x, (cnt.get(x) || 0) + 1);
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]); // by count, then rank
  const pack = (arr) => arr.reduce((a, x) => a * 15 + x, 0);
  let cat, tb;
  if (straightHigh && flush) { cat = 8; tb = [straightHigh]; }
  else if (groups[0][1] === 4) { cat = 7; tb = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { cat = 6; tb = [groups[0][0], groups[1][0]]; }
  else if (flush) { cat = 5; tb = r; }
  else if (straightHigh) { cat = 4; tb = [straightHigh]; }
  else if (groups[0][1] === 3) { cat = 3; tb = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { cat = 2; tb = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2) { cat = 1; tb = groups.map((g) => g[0]); }
  else { cat = 0; tb = r; }
  return cat * 15 ** 5 + pack(tb);
}
export function bestHand(cards) { // best 5 of up to 7 cards
  let best = -1; const n = cards.length;
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++) for (let c = b + 1; c < n - 2; c++) for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
    const v = eval5([cards[a], cards[b], cards[c], cards[d], cards[e]]); if (v > best) best = v;
  }
  return best;
}
const CAT = ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush"];
export const handName = (score) => CAT[Math.floor(score / 15 ** 5)];

// ---- the table ----
export class Table {
  constructor({ seats = 6, sb = 10, bb = 20, rand = (n) => crypto.randomInt(n) } = {}) {
    this.N = seats; this.sb = sb; this.bb = bb; this.rand = rand;
    this.seats = Array(seats).fill(null); this.dealer = -1; this.phase = "wait"; this.board = []; this.deck = []; this.toAct = -1;
    this.currentBet = 0; this.lastRaise = bb; this.handNo = 0; this.log = []; this.result = null;
  }
  // seat: { addr, name, stack, bet, total, cards, folded, allIn, acted, sittingOut }
  sit(i, p, chips) { if (i < 0 || i >= this.N || this.seats[i] || chips <= 0) return false; if (this.seats.some((s) => s && s.addr === p.addr)) return false; this.seats[i] = { addr: p.addr, name: p.name, stack: chips, bet: 0, total: 0, cards: [], folded: false, allIn: false, acted: false, waiting: this.phase !== "wait" && this.phase !== "showdown" }; return true; }
  seatOf(addr) { return this.seats.findIndex((s) => s && s.addr === addr); }
  leave(addr) { // leaving mid-hand folds you; the chips you had go back with you
    const i = this.seatOf(addr); if (i < 0) return 0; const s = this.seats[i]; const back = s.stack;
    if (this.inHand() && !s.folded && !s.waiting) { s.folded = true; this.checkProgress(i); }
    this.seats[i] = null; return back;
  }
  inHand() { return ["preflop", "flop", "turn", "river"].includes(this.phase); }
  live() { return this.seats.map((s, i) => (s && !s.waiting && !s.folded ? i : -1)).filter((i) => i >= 0); }
  canAct(i) { const s = this.seats[i]; return s && !s.waiting && !s.folded && !s.allIn; }
  next(i, pred) { for (let k = 1; k <= this.N; k++) { const j = (i + k) % this.N; if (pred(j)) return j; } return -1; }
  shuffle() { const d = [...Array(52).keys()]; for (let i = 51; i > 0; i--) { const j = this.rand(i + 1); [d[i], d[j]] = [d[j], d[i]]; } return d; }
  pot() { return this.seats.reduce((a, s) => a + (s ? s.total : 0), 0); }

  startHand() {
    const ready = this.seats.map((s, i) => (s && s.stack > 0 ? i : -1)).filter((i) => i >= 0); if (ready.length < 2 || this.inHand()) return false;
    for (const s of this.seats) if (s) { s.waiting = !(s.stack > 0); s.bet = 0; s.total = 0; s.cards = []; s.folded = s.waiting; s.allIn = false; s.acted = false; }
    this.handNo++; this.deck = this.shuffle(); this.board = []; this.result = null; this.log = [];
    this.dealer = this.next(this.dealer < 0 ? this.N - 1 : this.dealer, (j) => !!this.seats[j] && !this.seats[j].waiting);
    const headsUp = ready.length === 2;
    const sbI = headsUp ? this.dealer : this.next(this.dealer, (j) => this.seats[j] && !this.seats[j].waiting);
    const bbI = this.next(sbI, (j) => this.seats[j] && !this.seats[j].waiting);
    for (let r = 0; r < 2; r++) for (let k = 0; k < this.N; k++) { const j = (sbI + k) % this.N; if (this.seats[j] && !this.seats[j].waiting) this.seats[j].cards.push(this.deck.pop()); }
    this.post(sbI, this.sb); this.post(bbI, this.bb); this.currentBet = this.bb; this.lastRaise = this.bb; this.phase = "preflop";
    this.toAct = this.next(bbI, (j) => this.canAct(j)); this.log.push(`Hand #${this.handNo}`);
    if (this.toAct < 0 || this.noMoreBetting()) this.advance(); // everyone all-in from the blinds
    return true;
  }
  post(i, amt) { const s = this.seats[i]; const a = Math.min(amt, s.stack); s.stack -= a; s.bet += a; s.total += a; if (s.stack === 0) s.allIn = true; }
  noMoreBetting() { const can = this.live().filter((i) => this.canAct(i)); if (can.length === 0) return true; if (can.length === 1) { const s = this.seats[can[0]]; return s.bet >= this.currentBet; } return false; }
  toCall(i) { return Math.max(0, this.currentBet - this.seats[i].bet); }
  options(i) { // what the player to act may do
    if (i !== this.toAct) return null; const s = this.seats[i], call = this.toCall(i);
    return { fold: true, check: call === 0, call: call > 0 ? Math.min(call, s.stack) : 0, minRaise: Math.min(s.stack + s.bet, this.currentBet + this.lastRaise), maxRaise: s.stack + s.bet, canRaise: s.stack > call };
  }
  act(addr, action, amount = 0) {
    const i = this.seatOf(addr); if (i < 0 || i !== this.toAct || !this.inHand()) return { ok: false, why: "Not your turn." };
    const s = this.seats[i], call = this.toCall(i);
    if (action === "fold") { s.folded = true; this.log.push(`${s.name} folds`); }
    else if (action === "check") { if (call > 0) return { ok: false, why: "You must call, raise or fold." }; s.acted = true; this.log.push(`${s.name} checks`); }
    else if (action === "call") { const a = Math.min(call, s.stack); s.stack -= a; s.bet += a; s.total += a; if (s.stack === 0) s.allIn = true; s.acted = true; this.log.push(a === 0 ? `${s.name} checks` : `${s.name} calls ${a}${s.allIn ? " (all in)" : ""}`); }
    else if (action === "raise") {
      let to = Math.floor(Number(amount)); if (!Number.isFinite(to)) return { ok: false, why: "Bad amount." };
      const max = s.stack + s.bet; to = Math.min(to, max); const full = to >= this.currentBet + this.lastRaise;
      if (to <= this.currentBet) return { ok: false, why: "A raise must be bigger than the current bet." };
      if (!full && to < max) return { ok: false, why: `Minimum raise is to ${Math.min(this.currentBet + this.lastRaise, max)}.` };
      const add = to - s.bet; s.stack -= add; s.bet = to; s.total += add; if (s.stack === 0) s.allIn = true;
      if (full) { this.lastRaise = to - this.currentBet; for (const o of this.seats) if (o && o !== s) o.acted = false; } // a full raise reopens the betting
      this.currentBet = Math.max(this.currentBet, to); s.acted = true; this.log.push(`${s.name} ${s.allIn ? "goes all in to" : "raises to"} ${to}`);
    } else return { ok: false, why: "Unknown action." };
    this.checkProgress(i); return { ok: true };
  }
  checkProgress(from) { // after any action or a player leaving
    if (!this.inHand()) return;
    const live = this.live(); if (live.length === 1) { this.finish([live[0]]); return; }
    const pending = live.filter((i) => this.canAct(i) && (!this.seats[i].acted || this.seats[i].bet < this.currentBet));
    if (pending.length === 0) { this.advance(); return; }
    this.toAct = this.next(from, (j) => pending.includes(j));
  }
  advance() { // betting round over: deal the next street, or go to showdown
    for (const s of this.seats) if (s) { s.bet = 0; s.acted = false; } this.currentBet = 0; this.lastRaise = this.bb;
    const live = this.live(); if (live.length === 1) { this.finish([live[0]]); return; }
    const deal = (n) => { this.deck.pop(); for (let k = 0; k < n; k++) this.board.push(this.deck.pop()); }; // burn one, then deal
    if (this.phase === "preflop") { this.phase = "flop"; deal(3); } else if (this.phase === "flop") { this.phase = "turn"; deal(1); } else if (this.phase === "turn") { this.phase = "river"; deal(1); } else { this.showdown(); return; }
    const can = live.filter((i) => this.canAct(i));
    if (can.length <= 1) { this.advance(); return; } // everyone left is all in: run the board out
    this.toAct = this.next(this.dealer, (j) => this.canAct(j));
  }
  showdown() {
    const live = this.live(); const score = new Map(live.map((i) => [i, bestHand([...this.seats[i].cards, ...this.board])]));
    this.finish(null, score);
  }
  finish(onlyWinner, score) { // pay out. Side pots are built from what each player put in.
    const wins = new Map(); const add = (i, n) => wins.set(i, (wins.get(i) || 0) + n);
    const contrib = this.seats.map((s, i) => (s && s.total > 0 ? [i, s.total] : null)).filter(Boolean);
    const levels = [...new Set(contrib.map((c) => c[1]))].sort((a, b) => a - b); let prev = 0; const pots = [];
    for (const lv of levels) { const inPot = contrib.filter((c) => c[1] >= lv); const amount = (lv - prev) * inPot.length; pots.push({ amount, eligible: inPot.map((c) => c[0]).filter((i) => !this.seats[i].folded && !this.seats[i].waiting) }); prev = lv; }
    for (const pot of pots) {
      let el = pot.eligible; if (!el.length) { el = this.live(); if (!el.length) continue; } // everyone who could win it folded: should not happen
      let winners;
      if (onlyWinner) winners = [onlyWinner[0]]; else { const top = Math.max(...el.map((i) => score.get(i))); winners = el.filter((i) => score.get(i) === top); }
      const share = Math.floor(pot.amount / winners.length); let odd = pot.amount - share * winners.length;
      const order = [...winners].sort((a, b) => ((a - this.dealer + this.N - 1) % this.N) - ((b - this.dealer + this.N - 1) % this.N)); // odd chips go left of the dealer first
      for (const w of order) { add(w, share + (odd > 0 ? 1 : 0)); if (odd > 0) odd--; }
    }
    const total = this.pot();
    for (const [i, n] of wins) this.seats[i].stack += n;
    const shown = !onlyWinner; this.result = { total, winners: [...wins].map(([i, n]) => ({ seat: i, name: this.seats[i].name, won: n, hand: shown ? handName(score.get(i)) : null })), board: [...this.board], shown: shown ? this.live().map((i) => ({ seat: i, cards: [...this.seats[i].cards], hand: handName(score.get(i)) })) : [] };
    this.log.push(...this.result.winners.map((w) => `${w.name} wins ${w.won}${w.hand ? ` with ${w.hand}` : ""}`));
    this.phase = "showdown"; this.toAct = -1;
    for (const s of this.seats) if (s) s.bet = 0;
  }
  // what a given viewer may see: their own cards, and everyone's cards only if a showdown revealed them
  view(addr) {
    const me = this.seatOf(addr);
    return {
      phase: this.phase, hand: this.handNo, dealer: this.dealer, toAct: this.toAct, board: this.board, pot: this.pot(), currentBet: this.currentBet, blinds: [this.sb, this.bb],
      seats: this.seats.map((s, i) => s && { seat: i, bot: !!s.bot, name: s.name, stack: s.stack, bet: s.bet, folded: s.folded, allIn: s.allIn, waiting: s.waiting, hasCards: s.cards.length > 0 && !s.folded,
        cards: i === me ? s.cards : (this.phase === "showdown" && this.result && this.result.shown.length > 1 && this.result.shown.some((x) => x.seat === i) ? s.cards : null) }),
      options: me >= 0 ? this.options(me) : null, result: this.phase === "showdown" ? this.result : null, log: this.log.slice(-6),
    };
  }
}
