// The poker table view. When you sit down, this takes over the screen: you are at the table, Charlotte deals real cards
// from the deck, bets slide in and the board flips over. The 3D lounge is paused underneath while it is open, so a phone
// only has to draw the table. Same server game as before (play chips only); this file is only the picture of it.
const SUIT = ['♠', '♥', '♦', '♣'], RK = '23456789TJQKA';
const CSS = `
#tbl{position:fixed;inset:0;z-index:40;display:none;overflow:hidden;color:#f3e7c9;font:14px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;background:radial-gradient(ellipse at 50% 38%,#16241b 0,#0a100c 55%,#040605 100%);user-select:none;-webkit-user-select:none;touch-action:manipulation}
#tbl.on{display:block}
#tbl .top{position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:max(8px,env(safe-area-inset-top)) 10px 0;z-index:5}
#tbl .top button{padding:8px 12px;border-radius:10px;border:1px solid rgba(233,201,122,.45);background:rgba(20,16,12,.9);color:#e9c97a;font-size:13px;cursor:pointer}
#tbl .top .info{font-size:12px;text-align:right;color:#cfe9d5}#tbl .top .info b{color:#9fe3b4}
#tbl .stage{position:absolute;left:50%;top:47%;width:min(94vw,920px);height:min(52vh,480px);transform:translate(-50%,-50%)}
#tbl .felt{position:absolute;inset:0;border-radius:50%/50%;background:radial-gradient(ellipse at 50% 40%,#1f7a48 0,#14593a 55%,#0c3d27 100%);border:12px solid #3a2414;box-shadow:0 0 0 3px #1a0f08,0 18px 50px rgba(0,0,0,.75),inset 0 0 60px rgba(0,0,0,.55)}
#tbl .felt:after{content:"";position:absolute;inset:16px;border-radius:50%;border:2px solid rgba(233,201,122,.28)}
#tbl .logo{position:absolute;left:50%;top:80%;transform:translate(-50%,-50%);font:700 13px Georgia,serif;letter-spacing:.35em;color:rgba(233,201,122,.22);white-space:nowrap;pointer-events:none}
#tbl .dealer{position:absolute;left:50%;top:0;transform:translate(-50%,-74%);width:clamp(84px,17vh,150px);text-align:center;pointer-events:none;z-index:1}
#tbl .dealer img{width:100%;display:block;filter:drop-shadow(0 6px 10px rgba(0,0,0,.7));transform-origin:50% 100%}
#tbl .dealer.deal img{animation:tbDeal .36s ease-in-out infinite alternate}
@keyframes tbDeal{from{transform:rotate(-2.5deg) translateY(0)}to{transform:rotate(2.5deg) translateY(3px)}}
#tbl .dealer span{display:inline-block;margin-top:-10px;padding:2px 8px;border-radius:8px;background:rgba(0,0,0,.7);color:#e9c97a;font-size:11px;position:relative}
#tbl .deck{position:absolute;left:50%;top:13%;width:34px;height:48px;transform:translateX(-50%);z-index:2}
#tbl .deck i{position:absolute;inset:0;border-radius:5px}
#tbl .board{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);display:flex;gap:6px;z-index:2;min-height:64px}
#tbl .pot{position:absolute;left:50%;top:27%;transform:translateX(-50%);padding:3px 12px;border-radius:14px;background:rgba(0,0,0,.55);color:#ffd34d;font-weight:700;white-space:nowrap;z-index:2}
#tbl .msg{position:absolute;left:50%;top:64%;transform:translateX(-50%);max-width:86%;text-align:center;font-size:12px;color:#d9f2e0;text-shadow:0 1px 3px #000;z-index:2;pointer-events:none}
#tbl .msg b{color:#ffd34d;font-size:14px}
.tc{position:relative;display:inline-block;width:44px;height:62px;border-radius:6px;background:#fbfaf5;color:#16181c;box-shadow:0 2px 6px rgba(0,0,0,.6);font-weight:800;flex:none;transition:transform .25s}
.tc.r{color:#c8102e}.tc .k{position:absolute;left:4px;top:1px;font-size:15px;line-height:1.05;text-align:center}.tc .k small{display:block;font-size:12px}
.tc .s{position:absolute;right:4px;bottom:0;font-size:26px;line-height:1.15}
.tc.back,.deck i{background:repeating-linear-gradient(45deg,#0f5132 0 5px,#0b3d27 5px 10px);border:2px solid #f3e7c9;box-shadow:0 2px 6px rgba(0,0,0,.6)}
.tc.back:after{content:"🦌";position:absolute;inset:0;display:grid;place-items:center;font-size:17px;filter:grayscale(.2)}
.tc.sm{width:26px;height:37px;border-radius:4px}.tc.sm .k{font-size:11px;left:2px}.tc.sm .k small{font-size:9px}.tc.sm .s{font-size:14px;right:2px}.tc.sm.back:after{font-size:11px}
.tc.big{width:62px;height:88px;border-radius:8px}.tc.big .k{font-size:21px;left:5px;top:2px}.tc.big .k small{font-size:16px}.tc.big .s{font-size:38px;right:6px}
.tc.win{box-shadow:0 0 0 2px #ffd34d,0 0 16px #ffd34d;transform:translateY(-6px)}
.tc.flip{animation:tbFlip .34s ease-out}@keyframes tbFlip{0%{transform:rotateY(90deg)}100%{transform:rotateY(0)}}
.tfly{position:fixed;z-index:60;pointer-events:none;margin:0}
#tbl .seat{position:absolute;transform:translate(-50%,-50%);width:92px;text-align:center;z-index:3}
#tbl .seat .av{width:46px;height:46px;margin:0 auto;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:16px;color:#0b1a12;background:linear-gradient(160deg,#e9c97a,#a8853a);border:2px solid #20160c;position:relative}
#tbl .seat.bot .av{background:linear-gradient(160deg,#9fb5a6,#5d7567)}
#tbl .seat .ring{position:absolute;inset:-5px;border-radius:50%;display:none}
#tbl .seat.turn .ring{display:block;background:conic-gradient(#ffd34d var(--p,100%),rgba(255,255,255,.12) 0);-webkit-mask:radial-gradient(circle,transparent 60%,#000 62%);mask:radial-gradient(circle,transparent 60%,#000 62%)}
#tbl .seat .nm{margin-top:3px;padding:2px 6px;border-radius:8px;background:rgba(0,0,0,.72);font-size:11px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#tbl .seat .nm b{display:block;overflow:hidden;text-overflow:ellipsis;color:#fff}#tbl .seat .nm span{color:#9fe3b4}
#tbl .seat.fold{opacity:.42}#tbl .seat.me .av{box-shadow:0 0 0 2px #39ff14}
#tbl .seat.empty .av{background:rgba(0,0,0,.35);border:2px dashed rgba(233,201,122,.35);color:rgba(233,201,122,.5);font-size:11px;font-weight:600}
#tbl .seat .btn{position:absolute;right:-10px;top:-8px;width:18px;height:18px;border-radius:50%;background:#fff;color:#111;font-size:10px;font-weight:800;display:none;place-items:center;border:1px solid #333}
#tbl .seat.dl .btn{display:grid}
#tbl .hole{position:absolute;display:flex;gap:2px;transform:translate(-50%,-50%);z-index:3}
#tbl .bet{position:absolute;transform:translate(-50%,-50%);padding:1px 8px 1px 20px;border-radius:10px;background:rgba(0,0,0,.6);color:#ffd34d;font-size:12px;font-weight:700;z-index:3;white-space:nowrap;display:none}
#tbl .bet:before{content:"";position:absolute;left:3px;top:50%;width:13px;height:13px;margin-top:-7px;border-radius:50%;background:radial-gradient(circle,#fff 0 22%,#c8102e 24% 60%,#fff 62% 74%,#c8102e 76%);border:1px solid #400}
#tbl .mine{position:absolute;left:50%;bottom:calc(var(--bar,128px) + 6px);transform:translateX(-50%);display:flex;gap:8px;z-index:4;align-items:flex-end}
#tbl .mine .note{position:absolute;left:50%;top:-20px;transform:translateX(-50%);white-space:nowrap;font-size:12px;color:#ffd34d;text-shadow:0 1px 3px #000}
#tbl .bar{position:absolute;left:0;right:0;bottom:0;padding:8px 10px max(20px,calc(env(safe-area-inset-bottom) + 14px));background:linear-gradient(180deg,transparent,rgba(0,0,0,.85) 30%);z-index:6}
#tbl .bar .in{max-width:560px;margin:0 auto}
#tbl .bar .row{display:flex;gap:8px;margin-top:6px;align-items:center}
#tbl .bar button{flex:1;min-height:48px;padding:8px 6px;border-radius:12px;border:1px solid rgba(233,201,122,.5);background:#1c1610;color:#e9c97a;font-size:15px;font-weight:700;cursor:pointer}
#tbl .bar button.go{background:#39ff14;color:#04140a;border-color:#39ff14}#tbl .bar button.no{background:#3a1216;color:#ffb3b8;border-color:#7d2a32}
#tbl .bar button.q{flex:none;min-height:34px;padding:4px 10px;font-size:12px;font-weight:600}
#tbl .bar input[type=range]{flex:1;min-width:0;accent-color:#39ff14;height:30px}
#tbl .bar .wait{text-align:center;padding:14px 0;color:#cfe9d5;font-size:14px}
#tbl .foot{position:absolute;left:0;right:0;bottom:2px;text-align:center;font-size:10px;opacity:.5;z-index:7;pointer-events:none}
@media(max-width:560px){#tbl .stage{top:42%;height:min(56vh,500px);width:96vw}#tbl .hole .tc.sm{width:21px;height:30px}#tbl .hole .tc.sm:after{font-size:9px}#tbl .board .tc{width:34px;height:48px}#tbl .board .tc .s{font-size:19px}#tbl .board .tc .k{font-size:12px}#tbl .board{gap:3px}#tbl .seat{width:74px}#tbl .seat .av{width:38px;height:38px;font-size:13px}#tbl .seat .nm{font-size:10px}.tc{width:38px;height:54px}.tc .s{font-size:22px}.tc .k{font-size:13px}#tbl .board{gap:4px}.tc.big{width:54px;height:76px}}
@media(max-height:520px){#tbl .stage{top:40%;height:52vh;width:min(78vw,920px)}#tbl .seat{width:66px}#tbl .seat .av{width:30px;height:30px;font-size:11px}#tbl .seat .nm{font-size:10px;margin-top:1px}#tbl .mine{left:auto;right:10px;transform:none}#tbl .bar .in{margin:0 150px 0 auto;max-width:440px}#tbl .hole .tc.sm{width:19px;height:27px}#tbl .board .tc{width:32px;height:45px}#tbl .board .tc .s{font-size:17px}#tbl .board .tc .k{font-size:11px}#tbl .dealer{width:70px}#tbl .bar button{min-height:40px}.tc.big{width:46px;height:64px}.tc.big .s{font-size:26px}}
@media(prefers-reduced-motion:reduce){#tbl .dealer.deal img,.tc.flip{animation:none}}
`;

export function initTable({ send, esc }) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const root = document.createElement('div'); root.id = 'tbl'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Poker table');
  root.innerHTML = `<div class="top"><button data-a="leave">← Stand up</button><div class="info" id="tbInfo"></div></div>
    <div class="stage" id="tbStage"><div class="felt"></div><div class="logo">HOOD RICH CLUB</div>
      <div class="dealer" id="tbDealer"><img src="./assets/dealer.webp" alt="Charlotte, the dealer"><span>Charlotte · Dealer</span></div>
      <div class="deck" id="tbDeck"><i style="transform:translate(-2px,-2px)"></i><i style="transform:translate(-1px,-1px)"></i><i></i></div>
      <div class="pot" id="tbPot"></div><div class="board" id="tbBoard"></div><div class="msg" id="tbMsg"></div><div id="tbSeats"></div></div>
    <div class="mine" id="tbMine"></div><div class="bar"><div class="in" id="tbBar"></div></div><div class="foot">Play chips only. No cash value.</div>`;
  document.body.appendChild(root);
  const $ = (s) => root.querySelector(s);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let open = false, PK = null, hand = -1, boardN = 0, dealt = false, dealing = 0, raise = 0, lastBets = [];

  const face = (c, cls = '') => c == null ? `<span class="tc back ${cls}"></span>` : `<span class="tc ${cls}${[1, 2].includes(Math.floor(c / 13)) ? ' r' : ''}"><span class="k">${RK[c % 13] === 'T' ? '10' : RK[c % 13]}<small>${SUIT[Math.floor(c / 13)]}</small></span><span class="s">${SUIT[Math.floor(c / 13)]}</span></span>`;
  const n0 = (x) => Number(x || 0).toLocaleString('en-US');
  // where seat i sits: you are always at the bottom, everyone else goes round the table from your left
  function spot(i, n, k = 1) {
    const mine = PK.seat >= 0 ? PK.seat : 0, r = ((i - mine) % n + n) % n; let deg = 90;
    if (r > 0) { // the others fan out down both sides, leaving the head of the table clear for the dealer
      const L = Math.ceil((n - 1) / 2), R = n - 1 - L;
      deg = r <= L ? 128 + (L > 1 ? (r - 1) * 104 / (L - 1) : 52) : 308 + (R > 1 ? (r - L - 1) * 104 / (R - 1) : 52);
    }
    const a = deg * Math.PI / 180, narrow = innerWidth < 560, kx = narrow ? (k > 1 ? .86 : k > .8 ? .8 : k < .7 ? .7 : k) : k;
    return { x: 50 + Math.cos(a) * 50 * kx, y: 50 + Math.sin(a) * 50 * k };
  }
  function fly(fromEl, toEl, delay, cls, done) { // one card back travelling from the deck to where it lands
    if (reduce || !fromEl || !toEl) { done && done(); return; }
    const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect(); if (!b.width) { done && done(); return; }
    const c = document.createElement('span'); c.className = 'tc back tfly ' + cls; c.style.left = a.left + 'px'; c.style.top = a.top + 'px'; c.style.width = a.width + 'px'; c.style.height = a.height + 'px'; document.body.appendChild(c);
    const an = c.animate([{ transform: 'translate(0,0) rotate(0deg)', opacity: 1 }, { transform: `translate(${b.left - a.left + (b.width - a.width) / 2}px,${b.top - a.top + (b.height - a.height) / 2}px) rotate(360deg) scale(${Math.max(.6, b.width / a.width)})`, opacity: 1 }], { duration: 330, delay, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' });
    an.onfinish = an.oncancel = () => { c.remove(); done && done(); };
  }
  function build(v) {
    const n = v.seats.length; let h = '';
    for (let i = 0; i < n; i++) { const p = spot(i, n, 1.04), q = spot(i, n, .64), b = spot(i, n, .84); h += `<div class="seat" data-i="${i}" style="left:${p.x}%;top:${p.y}%"><div class="av"><i class="ring"></i><span class="in"></span><span class="btn">D</span></div><div class="nm"></div></div><div class="hole" data-h="${i}" style="left:${q.x}%;top:${q.y}%"></div><div class="bet" data-b="${i}" style="left:${b.x}%;top:${b.y}%"></div>`; }
    $('#tbSeats').innerHTML = h; $('#tbSeats').dataset.n = n; $('#tbSeats').dataset.me = PK.seat;
  }
  function render() {
    const v = PK && PK.v; if (!open || !v) return;
    const n = v.seats.length, S = $('#tbSeats'); if (+S.dataset.n !== n || +S.dataset.me !== PK.seat) { build(v); hand = -1; }
    const newHand = v.hand !== hand; if (newHand) { hand = v.hand; boardN = 0; dealt = false; lastBets = []; $('#tbBoard').innerHTML = ''; }
    const my = PK.seat >= 0 ? v.seats[PK.seat] : null, live = v.phase !== 'wait' && v.phase !== 'showdown';
    $('#tbInfo').innerHTML = `Blinds ${n0(v.blinds[0])}/${n0(v.blinds[1])}<br>Your stack <b>${n0(my ? my.stack : 0)}</b>`;
    $('#tbPot').textContent = v.pot ? 'Pot ' + n0(v.pot) : ''; $('#tbPot').style.display = v.pot ? '' : 'none';
    // deal: the first time this hand shows cards, they fly out from the deck one at a time, twice round the table
    const holders = v.seats.map((s, i) => (s && (s.hasCards || (i === PK.seat && s.cards && s.cards.length)) ? i : -1)).filter((i) => i >= 0);
    const startDeal = !dealt && holders.length > 0 && v.phase === 'preflop';
    if (!dealt && holders.length > 0) dealt = true;
    for (let i = 0; i < n; i++) {
      const s = v.seats[i], el = S.querySelector(`[data-i="${i}"]`), hole = S.querySelector(`[data-h="${i}"]`), bet = S.querySelector(`[data-b="${i}"]`);
      el.className = 'seat' + (s ? (s.bot ? ' bot' : '') + (s.folded ? ' fold' : '') + (v.toAct === i ? ' turn' : '') + (v.dealer === i ? ' dl' : '') + (i === PK.seat ? ' me' : '') : ' empty');
      el.querySelector('.in').textContent = s ? (s.name || '?').trim().slice(0, 2).toUpperCase() : 'open';
      el.querySelector('.nm').innerHTML = s ? `<b>${esc(s.name)}</b><span>${s.allIn ? 'ALL IN' : s.waiting ? 'next hand' : n0(s.stack)}</span>` : '';
      el.querySelector('.nm').style.display = s ? '' : 'none';
      const mineSeat = i === PK.seat, show = s && !mineSeat && (s.cards || s.hasCards);
      const html = show ? (s.cards ? s.cards.map((c) => face(c, 'sm' + (wins(v, c) ? ' win' : ''))).join('') : face(null, 'sm') + face(null, 'sm')) : '';
      if (hole.dataset.k !== html) { const reveal = !!(show && s.cards) && hole.dataset.k && hole.dataset.k.includes('back'); hole.dataset.k = html; hole.innerHTML = html; if (reveal) hole.querySelectorAll('.tc').forEach((c) => c.classList.add('flip')); if (startDeal && show) hole.style.visibility = 'hidden'; }
      const b = s && s.bet ? s.bet : 0; bet.style.display = b ? 'block' : 'none'; if (b) bet.textContent = n0(b);
      if (b > (lastBets[i] || 0) && !reduce) bet.animate([{ transform: 'translate(-50%,-50%) scale(1.5)', opacity: .2 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }], { duration: 220 }); lastBets[i] = b;
    }
    // your own two cards, big, at the bottom
    const M = $('#tbMine'), mh = my && my.cards && my.cards.length ? my.cards.map((c) => face(c, 'big' + (wins(v, c) ? ' win' : ''))).join('') + (my.folded ? '<span class="note">Folded</span>' : '') : '';
    if (M.dataset.k !== mh) { M.dataset.k = mh; M.innerHTML = mh; if (startDeal) M.style.visibility = 'hidden'; else if (mh) M.querySelectorAll('.tc').forEach((c) => c.classList.add('flip')); }
    M.style.opacity = my && my.folded ? .45 : 1;
    if (startDeal) {
      const order = []; for (let r = 1; r <= n; r++) { const i = (v.dealer + r) % n; if (holders.includes(i)) order.push(i); }
      const deck = $('#tbDeck'), D = $('#tbDealer'); D.classList.add('deal'); const id = ++dealing; let k = 0; const total = order.length * 2; let left = total;
      for (let round = 0; round < 2; round++) for (const i of order) {
        const tgt = i === PK.seat ? M : S.querySelector(`[data-h="${i}"]`); const last = round === 1;
        fly(deck, tgt, k++ * 95, i === PK.seat ? '' : 'sm', () => { if (id !== dealing) { tgt.style.visibility = ''; return; } if (last) { tgt.style.visibility = ''; if (i === PK.seat) tgt.querySelectorAll('.tc').forEach((c) => c.classList.add('flip')); } if (--left === 0) D.classList.remove('deal'); });
      }
      if (reduce) D.classList.remove('deal'); setTimeout(() => { if (id === dealing) { D.classList.remove('deal'); M.style.visibility = ''; S.querySelectorAll('.hole').forEach((x) => { x.style.visibility = ''; }); } }, total * 95 + 700);
    }
    // the board: each new card comes off the deck and flips over
    const B = $('#tbBoard');
    if (v.board.length < boardN) { B.innerHTML = ''; boardN = 0; }
    for (let i = boardN; i < v.board.length; i++) {
      const w = document.createElement('span'); w.innerHTML = face(v.board[i]); const c = w.firstChild; B.appendChild(c);
      if (!reduce) { c.style.visibility = 'hidden'; fly($('#tbDeck'), c, (i - boardN) * 140, '', () => { c.style.visibility = ''; c.classList.add('flip'); }); }
    }
    boardN = v.board.length;
    B.querySelectorAll('.tc').forEach((c, i) => c.classList.toggle('win', wins(v, v.board[i])));
    // what just happened
    const res = v.result, last = (v.log || []).slice(-1)[0] || '';
    $('#tbMsg').innerHTML = res ? res.winners.map((w) => `<b>${esc(w.name)} wins ${n0(w.won)}</b>${w.hand ? '<br>' + esc(w.hand) : ''}`).join('<br>') : v.phase === 'wait' ? 'Waiting for players. The next hand starts when two are seated.' : esc(last);
    bar(v, my, live);
  }
  // highlight the five cards that made the winning hand, when the server says which they are
  function wins(v, c) { const r = v.result; return !!(r && r.winners && r.winners.some((w) => Array.isArray(w.cards) && w.cards.includes(c))); }
  function bar(v, my, live) {
    const o = v.options, el = $('#tbBar'), mine = my && v.toAct === PK.seat && o;
    const key = mine ? ['a', v.hand, v.phase, o.call, o.check, o.minRaise, o.maxRaise, o.canRaise].join('|') : 'w|' + v.phase + '|' + v.toAct + '|' + (my ? my.folded + '|' + my.waiting : '');
    if (el.dataset.k === key) return; el.dataset.k = key;
    if (!mine) { el.innerHTML = `<div class="wait">${v.phase === 'showdown' ? 'Next hand in a moment…' : my && my.waiting ? 'You are in on the next hand.' : my && my.folded && live ? 'You folded. Watching this hand.' : v.toAct >= 0 && v.seats[v.toAct] ? 'Waiting for ' + esc(v.seats[v.toAct].name) + '…' : 'Waiting…'}</div>`; return; }
    raise = Math.max(o.minRaise, Math.min(raise || o.minRaise, o.maxRaise)); const step = v.blinds[0] || 1, pot = v.pot || 0;
    const q = (label, amt) => `<button class="q" data-r="${Math.max(o.minRaise, Math.min(o.maxRaise, Math.round(amt / step) * step))}">${label}</button>`;
    el.innerHTML = (o.canRaise ? `<div class="row">${q('Min', o.minRaise)}${q('½ pot', v.currentBet + pot / 2)}${q('Pot', v.currentBet + pot)}<input type="range" id="tbRz" aria-label="Raise amount" min="${o.minRaise}" max="${o.maxRaise}" step="${step}" value="${raise}"></div>` : '')
      + `<div class="row"><button class="no" data-a="fold">Fold</button>${o.check ? '<button class="go" data-a="check">Check</button>' : `<button class="go" data-a="call">Call ${n0(o.call)}</button>`}${o.canRaise ? `<button data-a="raise" id="tbRb">Raise to ${n0(raise)}</button>` : ''}</div>`;
    const rz = $('#tbRz'); if (rz) rz.oninput = () => { raise = +rz.value; label(); };
  }
  const label = () => { const o = PK.v.options, b = $('#tbRb'); if (b && o) b.textContent = raise >= o.maxRaise ? 'All in ' + n0(raise) : 'Raise to ' + n0(raise); };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.r) { raise = +b.dataset.r; const rz = $('#tbRz'); if (rz) rz.value = raise; label(); return; }
    const a = b.dataset.a; if (a === 'leave') send({ t: 'pokerleave' }); else if (a === 'raise') send({ t: 'pokeract', a: 'raise', amt: raise }); else if (a) send({ t: 'pokeract', a });
  });
  // the gold ring round whoever is on the clock
  setInterval(() => {
    if (!open || !PK || !PK.v) return; const el = root.querySelector('.seat.turn'); if (!el) return;
    const left = PK.deadline ? Math.max(0, PK.deadline - Date.now()) : 0; el.style.setProperty('--p', PK.deadline ? Math.min(100, left / 250) + '%' : '100%');
  }, 200);
  const fit = () => { const b = root.querySelector('.bar'); if (b) root.style.setProperty('--bar', b.offsetHeight + 'px'); };
  addEventListener('resize', () => { if (open) { fit(); if (PK && PK.v) { $('#tbSeats').dataset.n = 0; render(); } } });
  return {
    get isOpen() { return open; },
    open(pk) { PK = pk; if (!open) { open = true; hand = -1; $('#tbSeats').dataset.n = 0; $('#tbBar').dataset.k = ''; root.classList.add('on'); } render(); fit(); },
    update(pk) { PK = pk; if (open) { render(); fit(); } },
    close() { if (!open) return; open = false; dealing++; root.classList.remove('on'); document.querySelectorAll('.tfly').forEach((x) => x.remove()); },
  };
}
