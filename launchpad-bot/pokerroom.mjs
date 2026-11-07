// The Hood Rich Club card room: one Texas Hold'em table per lounge room, PLAY CHIPS ONLY (no cash value, no $STAG, nothing to buy or cash out).
// Everyone gets free chips and a daily top-up. House bots keep a table playable when few people are around. The weekly leaderboard is for bragging rights and club-chosen prizes.
import { Table, bestHand } from "./poker.mjs";

const START_CHIPS = 10000, TOPUP_BELOW = 2000, TOPUP_TO = 5000, MIN_BUY = 400, MAX_BUY = 5000, TURN_MS = parseInt(process.env.POKER_TURN_MS || "25000", 10), NEXT_HAND_MS = parseInt(process.env.POKER_NEXT_MS || "6500", 10), SEATS = 9;
export const TOPUP_LEVEL = 2000;
const day = () => new Date().toISOString().slice(0, 10);
export const todayStr = day;
const weekKey = () => { const d = new Date(); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const n = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - n); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${Math.ceil(((t - y0) / 864e5 + 1) / 7)}`; };

// ---- chip balances (memory cache, saved to the database when there is one) ----
const cache = new Map(); let Q = null, ready = false;
export async function initChips(q) {
  Q = q; if (!Q) return;
  try { await Q("create table if not exists poker_chips(addr text primary key, chips bigint not null, net_week bigint not null default 0, week text, topup_day text, name text, updated_at timestamptz default now())"); ready = true; } catch (e) { console.log("poker chips table err:", e.message); }
}
export async function chipsFor(addr, name) {
  let c = cache.get(addr);
  if (!c) {
    c = { addr, chips: START_CHIPS, net: 0, week: weekKey(), topup: day(), name };
    if (Q && ready) { try { const [r] = await Q("select chips, net_week, week, topup_day from poker_chips where addr=$1", [addr]); if (r) { c.chips = Number(r.chips); c.net = Number(r.net_week); c.week = r.week || c.week; c.topup = r.topup_day || ""; } } catch {} }
    cache.set(addr, c);
  }
  c.name = name || c.name;
  if (c.week !== weekKey()) { c.week = weekKey(); c.net = 0; } // a new week starts the leaderboard fresh
  if (c.chips < TOPUP_BELOW && c.topup !== day()) { c.chips = TOPUP_TO; c.topup = day(); } // one free top-up a day if you are nearly out
  return c;
}
export async function saveChips(c) { if (!Q || !ready) return; try { await Q("insert into poker_chips(addr, chips, net_week, week, topup_day, name, updated_at) values ($1,$2,$3,$4,$5,$6, now()) on conflict(addr) do update set chips=excluded.chips, net_week=excluded.net_week, week=excluded.week, topup_day=excluded.topup_day, name=excluded.name, updated_at=now()", [c.addr, c.chips, c.net, c.week, c.topup, c.name]); } catch {} }
export async function pokerLeaders(limit = 10) {
  const rows = [...cache.values()].filter((c) => c.week === weekKey());
  let db = []; if (Q && ready) { try { db = await Q("select addr, name, net_week from poker_chips where week=$1 order by net_week desc limit $2", [weekKey(), limit]); } catch {} }
  const m = new Map(db.map((r) => [r.addr, { name: r.name || "player", net: Number(r.net_week) }])); for (const c of rows) m.set(c.addr, { name: c.name || "player", net: c.net });
  return [...m.values()].sort((a, b) => b.net - a.net).slice(0, limit).filter((r) => r.net !== 0);
}

// ---- house bots: simple, a little random, never see anyone's cards ----
function botDecide(t, i) {
  const s = t.seats[i], call = t.toCall(i), o = t.options(i), pot = t.pot(); const r = Math.random();
  const known = [...s.cards, ...t.board]; let cat = 0;
  if (t.board.length) { cat = Math.floor(bestHand(known) / 15 ** 5); }
  const hi = Math.max(...s.cards.map((c) => c % 13)), lo = Math.min(...s.cards.map((c) => c % 13)), pair = hi === lo, suited = Math.floor(s.cards[0] / 13) === Math.floor(s.cards[1] / 13);
  let str; // 0..1
  if (!t.board.length) str = pair ? .55 + hi / 30 : (hi >= 10 ? .35 + (hi - 10) * .04 : .2) + (suited ? .06 : 0) + (hi - lo <= 2 ? .05 : 0);
  else str = [.18, .45, .68, .82, .86, .9, .95, 1, 1][cat];
  const raiseTo = (frac) => Math.min(o.maxRaise, Math.max(o.minRaise, t.currentBet + Math.round((pot * frac) / t.bb) * t.bb));
  const odds = call / (pot + call || 1);
  if (call === 0) { if (str > .62 && o.canRaise && r < .65) return ["raise", raiseTo(.6 + r * .4)]; if (r < .07 && o.canRaise) return ["raise", raiseTo(.5)]; return ["check"]; }
  if (str > .8 && o.canRaise && r < .5) return ["raise", raiseTo(.8)];
  if (str + .12 >= odds + .18 || (call <= t.bb && str > .22)) return ["call"];
  if (r < .05) return ["call"]; return ["fold"];
}

export class PokerRoom {
  constructor(deps) { this.send = deps.send; this.t = new Table({ seats: SEATS }); this.watch = new Map(); this.players = new Map(); this.timer = null; this.deadline = 0; this.nextTimer = null; this.botN = 0; this.autoFolds = new Map(); }
  seatedHumans() { return this.t.seats.filter((s) => s && !s.bot).length; }
  async handle(me, m) {
    if (m.t === "pokerwatch") { if (m.on) { this.watch.set(me.addr, me); await this.pushTo(me); } else this.watch.delete(me.addr); return; }
    if (m.t === "pokersit") {
      if (this.t.seatOf(me.addr) >= 0) return; const seat = Math.floor(Number(m.seat)); const c = await chipsFor(me.addr, me.name);
      if (!(seat >= 0 && seat < SEATS) || this.t.seats[seat]) return this.err(me, "That seat is taken.");
      const want = Math.floor(Number(m.buyin) || 2000); const buy = Math.max(MIN_BUY, Math.min(MAX_BUY, want, c.chips));
      if (c.chips < MIN_BUY) return this.err(me, "You are out of play chips. You get a free top-up each day.");
      if (!this.t.sit(seat, { addr: me.addr, name: me.name }, buy)) return this.err(me, "Could not sit there.");
      c.chips -= buy; this.players.set(me.addr, { me, in: buy, c }); this.watch.set(me.addr, me); await saveChips(c); this.fill(); this.broadcast(); this.maybeStart(); return;
    }
    if (m.t === "pokerleave") return this.stand(me);
    if (m.t === "pokeract") {
      const r = this.t.act(me.addr, String(m.a), m.amt); if (!r.ok) return this.err(me, r.why); this.autoFolds.delete(me.addr); this.after(); return;
    }
  }
  err(me, why) { this.send(me.ws, { t: "pokererr", why }); }
  async stand(me) {
    const p = this.players.get(me.addr); if (!p) return; const back = this.t.leave(me.addr); p.c.chips += back; p.c.net += back - p.in; this.players.delete(me.addr); await saveChips(p.c);
    this.send(me.ws, { t: "pokerleft", chips: p.c.chips, net: back - p.in });
    if (this.seatedHumans() === 0) { this.reset(); this.broadcast(); return; } // nobody left to play: clear the bots and the timers
    this.fill(); this.after(); this.broadcast();
  }
  reset() { clearTimeout(this.timer); clearTimeout(this.nextTimer); this.timer = null; this.nextTimer = null; this.deadline = 0; this.t = new Table({ seats: SEATS }); this.autoFolds.clear(); }
  drop(me) { this.watch.delete(me.addr); if (this.players.has(me.addr)) this.stand(me); }
  fill() { // bots keep the table lively: 1 person -> 3 bots, 2 -> 2, 3 -> 1, 4+ -> none (bots leave between hands)
    if (this.t.inHand()) return; const h = this.seatedHumans();
    const want = h === 0 ? 0 : h === 1 ? 3 : h === 2 ? 2 : h === 3 ? 1 : 0; let bots = this.t.seats.map((s, i) => (s && s.bot ? i : -1)).filter((i) => i >= 0);
    while (bots.length > want) { const i = bots.pop(); this.t.seats[i] = null; }
    for (let i = 0; bots.length < want && i < SEATS; i++) if (!this.t.seats[i]) { this.botN++; this.t.sit(i, { addr: "bot" + this.botN, name: ["Rack", "Velvet", "Antler", "Chip", "Gold"][this.botN % 5] + " (house)" }, 2000); this.t.seats[i].bot = true; bots.push(i); }
    for (const s of this.t.seats) if (s && s.bot && s.stack < this.t.bb * 10) s.stack = 2000; // house bots always have chips
  }
  maybeStart() {
    if (this.nextTimer || this.t.inHand()) return; const ready = this.t.seats.filter((s) => s && s.stack > 0).length; if (ready < 2) return;
    this.nextTimer = setTimeout(() => { this.nextTimer = null; this.fill(); if (this.t.startHand()) this.after(); else this.broadcast(); }, this.t.phase === "wait" ? 2500 : NEXT_HAND_MS);
  }
  after() { // call after any change to the hand: set the next timer, handle showdown and bots
    clearTimeout(this.timer); this.timer = null; this.deadline = 0;
    if (this.t.phase === "showdown") { this.settleBusted(); this.broadcast(); this.maybeStart(); return; }
    if (this.t.inHand() && this.t.toAct >= 0) {
      const i = this.t.toAct, s = this.t.seats[i];
      if (s.bot) { this.broadcast(); this.timer = setTimeout(() => { if (this.t.toAct !== i) return; const [a, amt] = botDecide(this.t, i); let r = this.t.act(s.addr, a, amt); if (!r.ok) r = this.t.act(s.addr, this.t.options(i).check ? "check" : "call"); this.after(); }, 900 + Math.random() * 1400); return; }
      this.deadline = Date.now() + TURN_MS; this.broadcast();
      this.timer = setTimeout(() => { if (this.t.toAct !== i) return; const o = this.t.options(i); this.t.act(s.addr, o && o.check ? "check" : "fold"); const n = (this.autoFolds.get(s.addr) || 0) + 1; this.autoFolds.set(s.addr, n); if (n >= 3) { const pl = this.players.get(s.addr); if (pl) { this.send(pl.me.ws, { t: "pokererr", why: "You were away, so you stood up." }); this.after(); this.stand(pl.me); return; } } this.after(); }, TURN_MS);
      return;
    }
    this.broadcast();
  }
  settleBusted() { // a human with no chips left gives up the seat; their play-chip balance stays as it is (it tops up daily)
    for (let i = 0; i < SEATS; i++) { const s = this.t.seats[i]; if (s && !s.bot && s.stack === 0) { const p = this.players.get(s.addr); if (p) { p.c.net += -p.in; this.send(p.me.ws, { t: "pokerleft", chips: p.c.chips, net: -p.in, busted: true }); saveChips(p.c); this.players.delete(s.addr); } this.t.seats[i] = null; } }
    this.fill();
  }
  async pushTo(me) { const c = await chipsFor(me.addr, me.name); this.send(me.ws, { t: "poker", v: this.t.view(me.addr), deadline: this.deadline, chips: c.chips, seat: this.t.seatOf(me.addr), leaders: await pokerLeaders(5), rules: { min: MIN_BUY, max: MAX_BUY } }); }
  broadcast() { for (const me of this.watch.values()) if (me.ws.readyState === 1) this.pushTo(me); }
}
