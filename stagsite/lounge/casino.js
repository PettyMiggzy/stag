// Casino floor client: walk up to a table or machine, press E (or tap the button), play. PLAY CHIPS ONLY, no cash value.
// All results come from the server; this file only draws them.
export function initCasino({ L, sendWs, pos, $, say, onEvent, busy, duel, poker }) {
  const CSS = `
#playBtn{position:fixed;left:50%;bottom:118px;transform:translateX(-50%);z-index:12;display:none;padding:10px 20px;border-radius:999px;border:1px solid #e9c97a;background:rgba(14,6,14,.9);color:#ffe9a8;font:700 15px system-ui,sans-serif;letter-spacing:.04em;cursor:pointer;box-shadow:0 0 22px rgba(255,200,90,.35)}
#cg{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:13;display:none;width:min(560px,96vw);max-height:84vh;overflow:auto;background:rgba(14,6,14,.94);border:1px solid rgba(233,201,122,.55);border-radius:16px;padding:14px;color:#f3e7c9;font:14px system-ui,sans-serif;box-shadow:0 0 40px rgba(0,0,0,.6)}
#cg h3{margin:0 0 4px;font:700 18px Georgia,serif;letter-spacing:.12em;color:#e9c97a}
#cg .sub{opacity:.75;font-size:12px;margin-bottom:8px}
#cg button{font:600 14px system-ui,sans-serif;color:#f3e7c9;background:rgba(255,255,255,.08);border:1px solid rgba(233,201,122,.4);border-radius:10px;padding:8px 12px;margin:2px;cursor:pointer}
#cg button.on{background:#e9c97a;color:#1a0f08}#cg button:disabled{opacity:.4;cursor:default}
#cg .row{display:flex;flex-wrap:wrap;gap:2px;align-items:center;justify-content:center;margin:6px 0}
#cg .bal{float:right;color:#ffd34d;font-weight:700}
#cg .msg{min-height:20px;text-align:center;color:#ffd34d;font-weight:700;margin:6px 0}
#cg .reels{display:flex;gap:8px;justify-content:center;margin:10px 0}
#cg .reel{width:82px;height:90px;border-radius:12px;background:#0b0709;border:2px solid #e9c97a;display:flex;align-items:center;justify-content:center;font-size:52px}
#cg .cards{display:flex;gap:6px;justify-content:center;min-height:56px;margin:4px 0}
#cg .pc{display:inline-block;min-width:38px;padding:8px 5px;border-radius:6px;background:#f7f2e6;color:#111;font:700 18px Georgia,serif;text-align:center;box-shadow:0 1px 3px #000}#cg .pc.r{color:#c8102e}#cg .pc.back{background:#7a1030;color:#e9c97a}
#cg .board{display:grid;grid-template-columns:repeat(12,1fr);gap:2px;margin:6px 0}
#cg .cell{position:relative;text-align:center;padding:7px 0;border-radius:5px;border:1px solid rgba(233,201,122,.35);cursor:pointer;font-weight:700;font-size:13px;color:#fff;user-select:none}
#cg .cell.red{background:#b3162b}#cg .cell.blk{background:#111}#cg .cell.grn{background:#1d8a4f}#cg .cell.out{background:#0c5a3b;color:#e9c97a}
#cg .cell i{position:absolute;right:1px;top:-6px;background:#e9c97a;color:#111;border-radius:8px;padding:0 4px;font-size:10px;font-style:normal}
#cg .hist span{display:inline-block;min-width:24px;padding:2px 4px;margin:1px;border-radius:5px;font-size:12px;font-weight:700;color:#fff}
#cg .big{font:700 40px Georgia,serif;text-align:center;margin:4px 0}`;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const box = document.createElement('div'); box.id = 'cg'; document.body.appendChild(box);
  const btn = document.createElement('button'); btn.id = 'playBtn'; document.body.appendChild(btn);
  const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const S = { chips: null, bet: 100, slots: { reels: [0, 0, 0], sym: ['🦌', '👑', '💎', '🔔', '🍒', '🍋'], spin: false, msg: '' }, bj: null, bjMsg: '', wheel: { spin: false, msg: '', last: null, segs: [] }, bac: { side: 'banker', res: null, msg: '' }, dice: { side: 'pass', g: null, msg: '' }, rl: { phase: 'bet', until: 0, history: [], result: -1, mine: {}, chip: 50, msg: '', watching: false }, atm: null };
  let near = null, game = null, tmr = null;
  const BETS = [50, 100, 250, 500, 1000], RCHIPS = [25, 50, 100, 250, 500];
  const bal = () => `<span class="bal">🪙 ${S.chips == null ? '…' : Number(S.chips).toLocaleString()} play chips</span>`;
  const betRow = () => `<div class="row">${BETS.map((b) => `<button data-bet="${b}" class="${S.bet === b ? 'on' : ''}">${b}</button>`).join('')}</div>`;
  const close = () => { game = null; box.style.display = 'none'; clearInterval(tmr); tmr = null; };
  const cardHtml = (c) => c == null ? '<span class="pc back">♠</span>' : `<span class="pc ${(Math.floor(c / 13) === 1 || Math.floor(c / 13) === 2) ? 'r' : ''}">${'23456789TJQKA'[c % 13] === 'T' ? '10' : '23456789TJQKA'[c % 13]}${'♠♥♦♣'[Math.floor(c / 13)]}</span>`;

  function render() {
    if (!game) return;
    box.style.display = 'block';
    if (game === 'slots') {
      const s = S.slots; box.innerHTML = `<h3>STAG SLOTS ${bal()}</h3><div class="sub">Play chips only. Three of a kind pays up to 120×. One cherry gives half your bet back.</div>
        <div class="reels">${s.reels.map((r) => `<div class="reel">${s.sym[r]}</div>`).join('')}</div><div class="msg">${esc(s.msg)}</div>${betRow()}
        <div class="row"><button id="cgSpin" ${s.spin ? 'disabled' : ''}>🎰 SPIN</button><button id="cgX">Close</button></div>`;
      box.querySelectorAll('[data-bet]').forEach((b) => b.onclick = () => { S.bet = +b.dataset.bet; render(); });
      $('#cgSpin').onclick = spinSlots; $('#cgX').onclick = close;
    } else if (game === 'blackjack') {
      const b = S.bj; const over = !b || b.over;
      box.innerHTML = `<h3>BLACKJACK ${bal()}</h3><div class="sub">Blackjack pays 3 to 2. Dealer stands on 17. Play chips only.</div>
        <div class="sub">Dealer ${b ? '(' + (b.over ? b.dtotal : b.dtotal + ' showing') + ')' : ''}</div><div class="cards">${b ? b.dealer.map(cardHtml).join('') : ''}</div>
        <div class="sub">You ${b ? '(' + b.ptotal + ')' : ''}</div><div class="cards">${b ? b.player.map(cardHtml).join('') : ''}</div>
        <div class="msg">${esc(S.bjMsg)}</div>${over ? betRow() : ''}
        <div class="row">${over ? '<button id="cgDeal">Deal</button>' : '<button id="cgHit">Hit</button><button id="cgStand">Stand</button><button id="cgDbl">Double</button>'}<button id="cgX">Close</button></div>`;
      box.querySelectorAll('[data-bet]').forEach((x) => x.onclick = () => { S.bet = +x.dataset.bet; render(); });
      if (over) $('#cgDeal').onclick = () => { S.bjMsg = ''; sendWs({ t: 'cgbj', a: 'deal', bet: S.bet }); };
      else { $('#cgHit').onclick = () => sendWs({ t: 'cgbj', a: 'hit' }); $('#cgStand').onclick = () => sendWs({ t: 'cgbj', a: 'stand' }); $('#cgDbl').onclick = () => sendWs({ t: 'cgbj', a: 'double' }); }
      $('#cgX').onclick = close;
    } else if (game === 'roulette') {
      const R = S.rl; const left = Math.max(0, Math.ceil((R.until - Date.now()) / 1000));
      const colr = (n) => n === 0 ? 'grn' : REDS.has(n) ? 'red' : 'blk';
      const cell = (k, label, cls) => `<div class="cell ${cls}" data-k="${k}">${label}${R.mine[k] ? `<i>${R.mine[k]}</i>` : ''}</div>`;
      let nums = ''; for (let r = 0; r < 3; r++) for (let c = 0; c < 12; c++) { const n = c * 3 + (3 - r); nums += cell('n' + n, n, colr(n)); }
      const total = Object.values(R.mine).reduce((a, b) => a + b, 0);
      const phaseTxt = R.phase === 'bet' ? `Place your bets · ${left}s` : R.phase === 'spin' ? 'No more bets · the ball is rolling…' : (R.result >= 0 ? `Result: ${R.result}` : '');
      box.innerHTML = `<h3>ROULETTE ${bal()}</h3><div class="sub">European, one zero. Play chips only. Table limit 5,000 a round.</div>
        <div class="big" style="color:${R.result >= 0 && R.phase !== 'bet' ? (R.result === 0 ? '#35ff8a' : REDS.has(R.result) ? '#ff5b6e' : '#fff') : '#e9c97a'}">${R.phase === 'bet' ? '🎡' : (R.phase === 'spin' ? '…' : R.result)}</div>
        <div class="msg">${esc(phaseTxt)}</div>
        <div class="hist" style="text-align:center">${R.history.map((n) => `<span style="background:${n === 0 ? '#1d8a4f' : REDS.has(n) ? '#b3162b' : '#111'}">${n}</span>`).join('')}</div>
        <div style="display:grid;grid-template-columns:44px 1fr;gap:4px"><div>${cell('n0', '0', 'grn').replace('class="cell', 'style="height:100%;display:flex;align-items:center;justify-content:center" class="cell')}</div><div class="board">${nums}</div></div>
        <div class="board" style="grid-template-columns:repeat(3,1fr)">${cell('d1', '1st 12', 'out')}${cell('d2', '2nd 12', 'out')}${cell('d3', '3rd 12', 'out')}</div>
        <div class="board" style="grid-template-columns:repeat(6,1fr)">${cell('low', '1-18', 'out')}${cell('even', 'EVEN', 'out')}${cell('red', 'RED', 'red')}${cell('black', 'BLACK', 'blk')}${cell('odd', 'ODD', 'out')}${cell('high', '19-36', 'out')}</div>
        <div class="board" style="grid-template-columns:repeat(3,1fr)">${cell('c1', 'Col 1', 'out')}${cell('c2', 'Col 2', 'out')}${cell('c3', 'Col 3', 'out')}</div>
        <div class="row">${RCHIPS.map((b) => `<button data-chip="${b}" class="${R.chip === b ? 'on' : ''}">${b}</button>`).join('')}</div>
        <div class="msg">${esc(R.msg)}${total ? ` · your bets: ${total}` : ''}</div>
        <div class="row"><button id="cgClr" ${R.phase !== 'bet' ? 'disabled' : ''}>Clear my bets</button><button id="cgX">Close</button></div>`;
      box.querySelectorAll('[data-chip]').forEach((x) => x.onclick = () => { R.chip = +x.dataset.chip; render(); });
      box.querySelectorAll('[data-k]').forEach((x) => x.onclick = () => sendWs({ t: 'cgrl', a: 'bet', k: x.dataset.k, amt: R.chip }));
      $('#cgClr').onclick = () => sendWs({ t: 'cgrl', a: 'clear' }); $('#cgX').onclick = close;
    } else if (game === 'wheel') {
      const w = S.wheel; box.innerHTML = `<h3>LUCKY WHEEL ${bal()}</h3><div class="sub">One spin, one bet. Every segment multiplies your bet (× pays nothing, ½ gives half back). Play chips only.</div>
        <div class="big">${w.spin ? '🎡 …' : (w.last != null ? (w.last === 0 ? '×' : '×' + w.last) : '🎡')}</div><div class="msg">${esc(w.msg)}</div>${betRow()}
        <div class="row"><button id="cgSpin" ${w.spin ? 'disabled' : ''}>🎡 SPIN THE WHEEL</button><button id="cgX">Close</button></div>`;
      box.querySelectorAll('[data-bet]').forEach((b) => b.onclick = () => { S.bet = +b.dataset.bet; render(); });
      $('#cgSpin').onclick = () => { if (S.wheel.spin) return; S.wheel.spin = true; S.wheel.msg = ''; render(); sendWs({ t: 'cgwheel', bet: S.bet }); }; $('#cgX').onclick = close;
    } else if (game === 'baccarat') {
      const b = S.bac, r = b.res; const hand = (h) => (h || []).map(cardHtml).join('');
      box.innerHTML = `<h3>BACCARAT ${bal()}</h3><div class="sub">Closest to 9 wins. Banker pays 0.95 to 1, Tie pays 8 to 1. Play chips only.</div>
        ${r ? `<div class="sub">Player (${r.p})</div><div class="cards">${hand(r.player)}</div><div class="sub">Banker (${r.b})</div><div class="cards">${hand(r.banker)}</div>` : ''}
        <div class="msg">${esc(b.msg)}</div>
        <div class="row">${['player', 'banker', 'tie'].map((x) => `<button data-side="${x}" class="${b.side === x ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div>${betRow()}
        <div class="row"><button id="cgDeal">Deal</button><button id="cgX">Close</button></div>`;
      box.querySelectorAll('[data-bet]').forEach((x) => x.onclick = () => { S.bet = +x.dataset.bet; render(); });
      box.querySelectorAll('[data-side]').forEach((x) => x.onclick = () => { S.bac.side = x.dataset.side; render(); });
      $('#cgDeal').onclick = () => { S.bac.msg = ''; sendWs({ t: 'cgbac', bet: S.bet, side: S.bac.side }); }; $('#cgX').onclick = close;
    } else if (game === 'dice') {
      const d = S.dice, g = d.g; const live = g && !g.over; const face = (n) => '⚀⚁⚂⚃⚄⚅'[n - 1];
      box.innerHTML = `<h3>STAG DICE ${bal()}</h3><div class="sub">Pass line: 7 or 11 wins on the first roll, 2, 3 or 12 loses; any other number is your point, make it again before a 7. "Don't pass" is the reverse. Play chips only.</div>
        <div class="big">${g ? face(g.dice[0]) + ' ' + face(g.dice[1]) : '🎲'}</div><div class="msg">${esc(d.msg)}</div>
        ${live ? `<div class="sub" style="text-align:center">Point: ${g.point} · bet ${g.bet}</div>` : `<div class="row">${['pass', 'dont'].map((x) => `<button data-side="${x}" class="${d.side === x ? 'on' : ''}">${x === 'pass' ? 'Pass line' : "Don't pass"}</button>`).join('')}</div>${betRow()}`}
        <div class="row"><button id="cgRoll">🎲 ${live ? 'Roll for the point' : 'Roll'}</button><button id="cgX">Close</button></div>`;
      box.querySelectorAll('[data-bet]').forEach((x) => x.onclick = () => { S.bet = +x.dataset.bet; render(); });
      box.querySelectorAll('[data-side]').forEach((x) => x.onclick = () => { S.dice.side = x.dataset.side; render(); });
      $('#cgRoll').onclick = () => sendWs({ t: 'cgdice', bet: S.bet, side: S.dice.side }); $('#cgX').onclick = close;
    } else if (game === 'atm') {
      const a = S.atm || {};
      box.innerHTML = `<h3>STAG ATM ${bal()}</h3><div class="sub">Play chips are for fun only. They have no cash value and can't be cashed out.</div>
        <div class="msg">${a.used ? 'Your free daily top-up has been used today.' : `Free daily top-up: if you drop under ${(a.level || 2000).toLocaleString()} chips, you're topped up automatically once a day.`}</div>
        <div class="row"><button disabled>Buy StagR chips with $STAG · not open yet</button></div>
        <div class="sub" style="text-align:center">Buying chips with $STAG is switched off until it's cleared. Nothing here charges you.</div>
        <div class="row"><button id="cgX">Close</button></div>`;
      $('#cgX').onclick = close;
    }
  }
  function spinSlots() {
    const s = S.slots; if (s.spin) return; s.spin = true; s.msg = ''; render(); const t0 = Date.now();
    const anim = setInterval(() => { s.reels = [0, 1, 2].map(() => Math.floor(Math.random() * 6)); render(); }, 90);
    s.pending = () => { clearInterval(anim); };
    s.animStop = anim; sendWs({ t: 'cgslots', bet: S.bet }); s.t0 = t0;
  }
  function openGame(g) {
    game = g; render();
    if (g === 'roulette') { sendWs({ t: 'cgrl', a: 'watch' }); tmr = setInterval(() => { if (game === 'roulette' && S.rl.phase === 'bet') render(); }, 500); }
    if (g === 'atm') sendWs({ t: 'cgatm' });
    if (g !== 'roulette' && g !== 'atm') sendWs({ t: 'cgatm' }); // learns the balance
  }
  function onMsg(m) {
    if (m.chips != null) S.chips = m.chips;
    if (m.g === 'slots') {
      const s = S.slots; const done = () => { if (s.animStop) clearInterval(s.animStop); s.animStop = null; s.spin = false;
        if (m.err) s.msg = m.err; else { s.reels = m.reels; s.msg = m.win > 0 ? `You win ${m.win.toLocaleString()} chips! 🎉` : 'No win. Spin again?'; }
        render(); };
      const wait = Math.max(0, 900 - (Date.now() - (s.t0 || 0))); setTimeout(done, wait);
    } else if (m.g === 'bj') {
      if (m.err) { S.bjMsg = m.err; render(); return; }
      S.bj = m; S.bjMsg = m.over ? `${m.result}${m.win ? ` · +${m.win.toLocaleString()}` : ''}` : ''; render();
    } else if (m.g === 'rl') {
      const R = S.rl; if (m.err) R.msg = m.err; else if (m.won !== undefined) R.msg = m.won > 0 ? `You won ${m.won.toLocaleString()} chips! 🎉` : (m.stake ? 'No win this round.' : ''); else R.msg = '';
      if (m.phase) { if (m.phase !== R.phase && onEvent) onEvent('rl-' + m.phase); R.phase = m.phase; R.until = Date.now() + (m.left || 0) * 1000; }
      if (m.history) R.history = m.history; if (m.result !== undefined) R.result = m.result; if (m.mine) R.mine = m.mine;
      if (m.phase === 'spin' && L.cardRoom.roulette) L.cardRoom.roulette.spin(m.result, m.spinMs || 7000);
      if (game === 'roulette') render();
    } else if (m.g === 'wheel') {
      const w = S.wheel; if (m.err) { w.spin = false; w.msg = m.err; render(); return; }
      if (L.cardRoom.bigWheel) L.cardRoom.bigWheel.spin(m.idx, 4200);
      setTimeout(() => { w.spin = false; w.last = m.mult; w.msg = m.win > m.bet ? `You win ${m.win.toLocaleString()} chips! 🎉` : m.win > 0 ? `You get ${m.win.toLocaleString()} back.` : 'No win. Spin again?'; S.chips = m.chips; render(); }, 4300);
    } else if (m.g === 'bac') {
      if (m.err) { S.bac.msg = m.err; render(); return; }
      S.bac.res = m; S.bac.msg = `${m.winner === 'tie' ? 'Tie' : m.winner[0].toUpperCase() + m.winner.slice(1) + ' wins'}${m.win > m.bet ? ` · you win ${m.win.toLocaleString()}` : m.win === m.bet ? ' · push' : ' · you lose'}`; render();
    } else if (m.g === 'dice') {
      if (m.err) { S.dice.msg = m.err; render(); return; }
      S.dice.g = m; S.dice.msg = `${m.res}${m.over && m.win > m.bet ? ` · +${m.win.toLocaleString()}` : ''}`; render();
    } else if (m.g === 'atm') { S.atm = m; render(); }
  }
  const act = () => { if (busy && busy()) return; if (!near) return; if (near.type === 'poker') { if (poker) poker.sit(); return; } if (near.type === 'duel') { if (duel) duel.toggle(); return; } if (game) { close(); return; } openGame(near.type); };
  btn.onclick = act;
  addEventListener('keydown', (e) => { if ((e.key === 'e' || e.key === 'E') && !e.repeat && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) act(); if (e.key === 'Escape' && game) close(); });
  let acc = 0, watching = false;
  function tick(dt) {
    acc += dt; if (acc < .2) return; acc = 0;
    const list = (L.cardRoom && L.cardRoom.stations) || []; let best = null, bd = 99;
    for (const s of list) { const d = Math.hypot(pos.x - s.x, pos.z - s.z); const n = d / s.r; if (d < s.r && n < bd) { best = s; bd = n; } } // closest relative to its own reach, so the big poker table wins over smaller neighbours when you stand at it
    if (busy && busy()) best = null;
    near = best;
    if (!best) { btn.style.display = 'none'; if (game) close(); if (duel && duel.isOpen() && !duel.inMatch()) duel.close(); } else { btn.style.display = 'block'; const dOpen = best.type === 'duel' && duel && duel.isOpen(); btn.textContent = (game || dOpen) ? `E · Leave ${best.label}` : `E · Play ${best.label}`; if (game && game !== best.type) close(); }
    const wheel = list.find((s) => s.type === 'roulette'); const nearWheel = wheel && Math.hypot(pos.x - wheel.x, pos.z - wheel.z) < 5.5;
    if (nearWheel && !watching) { watching = true; sendWs({ t: 'cgrl', a: 'watch' }); } else if (!nearWheel && watching && game !== 'roulette') { watching = false; sendWs({ t: 'cgrl', a: 'unwatch' }); }
  }
  return { tick, onMsg, close };
}
