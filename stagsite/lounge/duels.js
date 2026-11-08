// Skill duels client: chess + trivia, head to head, PLAY CHIPS ONLY (no cash value). The server decides everything; this file draws it.
export function initDuels({ sendWs }) {
  const CSS = `
#du{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:14;display:none;width:min(520px,97vw);max-height:90vh;overflow:auto;background:rgba(14,6,14,.95);border:1px solid rgba(233,201,122,.55);border-radius:16px;padding:14px;color:#f3e7c9;font:14px system-ui,sans-serif;box-shadow:0 10px 40px #000a}
#du h3{margin:0 0 4px;font:700 18px Georgia,serif;letter-spacing:.12em;color:#e9c97a}
#du .sub{opacity:.75;font-size:12px;margin-bottom:8px}
#du button{font:600 14px system-ui,sans-serif;color:#f3e7c9;background:rgba(255,255,255,.08);border:1px solid rgba(233,201,122,.4);border-radius:10px;padding:8px 12px;margin:2px;cursor:pointer}
#du button.on{background:#e9c97a;color:#1a0f08}#du button:disabled{opacity:.4;cursor:default}
#du .row{display:flex;flex-wrap:wrap;gap:2px;align-items:center;justify-content:center;margin:6px 0}
#du .x{position:absolute;right:10px;top:8px}
#du .ch{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;margin:3px 0;border:1px solid rgba(233,201,122,.25);border-radius:10px;background:rgba(255,255,255,.04)}
#du .msg{min-height:20px;text-align:center;color:#ffd34d;font-weight:700;margin:6px 0}
#du .bd{display:grid;grid-template-columns:repeat(8,1fr);width:min(400px,100%);aspect-ratio:1;margin:6px auto;border:3px solid #e9c97a;border-radius:4px;overflow:hidden;user-select:none}
#du .sq{position:relative;display:flex;align-items:center;justify-content:center;font-size:min(8.4vw,38px);line-height:1;cursor:pointer}
#du .sq.l{background:#e9d6a0}#du .sq.d{background:#8a5a44}
#du .sq.sel{outline:3px solid #ffd34d;outline-offset:-3px}#du .sq.lm{background-image:radial-gradient(circle,rgba(40,160,70,.65) 22%,transparent 24%)}
#du .sq.last{box-shadow:inset 0 0 0 100px rgba(255,211,77,.35)}#du .sq.chk{box-shadow:inset 0 0 14px 6px rgba(220,30,50,.8)}
#du .pw{color:#fff;text-shadow:0 0 2px #000,0 0 2px #000,0 0 3px #000}#du .pb{color:#111;text-shadow:0 0 1px #fff8}
#du .clk{display:flex;justify-content:space-between;font:700 16px ui-monospace,monospace;margin:2px 4px}
#du .clk b{padding:2px 8px;border-radius:6px;background:rgba(255,255,255,.08)}#du .clk b.run{background:#e9c97a;color:#1a0f08}#du .clk b.low{color:#ff6b6b}
#du .tq{font:700 18px Georgia,serif;text-align:center;margin:8px 4px;min-height:48px}
#du .opt{display:block;width:100%;text-align:left;margin:4px 0;padding:11px 12px}
#du .opt.ok{background:#1d8a4f;color:#fff}#du .opt.bad{background:#b3162b;color:#fff}#du .opt.me{outline:2px solid #ffd34d}
#du .bar{height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden;margin:4px 0}#du .bar i{display:block;height:100%;background:#e9c97a;width:100%}
#du .sc{display:flex;justify-content:space-between;font-weight:700;margin:2px 4px}`;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const box = document.createElement('div'); box.id = 'du'; document.body.appendChild(box);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const WAGERS = [0, 100, 250, 500, 1000];
  const PIECE = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const S = { tab: 'chess', wager: 0, lobby: { open: [], playing: 0 }, mode: 'lobby', msg: '', chess: null, sel: null, promo: null, t: null, end: null, chips: null };
  let isOpen = false, tmr = null;
  const fmt = (ms) => { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const inMatch = () => S.mode === 'chess' || S.mode === 'trivia';
  function open() { isOpen = true; box.style.display = 'block'; sendWs({ t: 'duwatch', on: 1 }); if (!tmr) tmr = setInterval(tickUI, 250); render(); }
  function close(force) {
    if (!force && inMatch()) return; // leaving mid match is done with Resign, so nobody loses by accident
    isOpen = false; box.style.display = 'none'; sendWs({ t: 'duwatch', on: 0 }); if (tmr) { clearInterval(tmr); tmr = null; }
    if (S.mode === 'waiting') { sendWs({ t: 'ducancel' }); S.mode = 'lobby'; }
  }
  const toggle = () => (isOpen ? close() : open());

  function board() {
    const c = S.chess; const rows = c.fen.split(' ')[0].split('/'); const grid = []; // grid[rank 0..7 from top][file]
    for (const r of rows) { const line = []; for (const ch of r) { if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) line.push(''); else line.push(ch); } grid.push(line); }
    const white = c.you === 'w'; let out = '';
    for (let ri = 0; ri < 8; ri++) for (let fi = 0; fi < 8; fi++) {
      const r = white ? ri : 7 - ri, f = white ? fi : 7 - fi; const p = grid[r][f]; const sq = 'abcdefgh'[f] + (8 - r);
      const cls = ['sq', (r + f) % 2 ? 'd' : 'l']; if (S.sel === sq) cls.push('sel');
      if (S.sel && (c.legal[S.sel] || []).includes(sq)) cls.push('lm');
      if (c.last && (c.last.from === sq || c.last.to === sq)) cls.push('last');
      if (c.check && p && p.toLowerCase() === 'k' && ((p === 'K') === (c.turn === 'w'))) cls.push('chk');
      out += `<div class="${cls.join(' ')}" data-sq="${sq}">${p ? `<span class="${p === p.toUpperCase() ? 'pw' : 'pb'}">${PIECE[p.toLowerCase() === p ? p : p]}</span>` : ''}</div>`;
    }
    return out;
  }
  function pieceAt(sq) { const rows = S.chess.fen.split(' ')[0].split('/'); const r = 8 - +sq[1]; const f = 'abcdefgh'.indexOf(sq[0]); let col = 0; for (const ch of rows[r]) { if (/\d/.test(ch)) { col += +ch; if (col > f) return ''; } else { if (col === f) return ch; col++; } } return ''; }
  function clickSq(sq) {
    const c = S.chess; if (!c || c.turn !== c.you) return;
    if (S.sel && (c.legal[S.sel] || []).includes(sq)) {
      const p = pieceAt(S.sel); const last = sq[1] === '8' || sq[1] === '1';
      if (p && p.toLowerCase() === 'p' && last) { S.promo = { from: S.sel, to: sq }; S.sel = null; return render(); }
      sendWs({ t: 'dumove', from: S.sel, to: sq }); S.sel = null; return render();
    }
    S.sel = c.legal[sq] ? (S.sel === sq ? null : sq) : null; render();
  }
  function head(title, sub) { return `<button class="x" data-a="close">${inMatch() ? '' : '✕'}</button><h3>${title}</h3><div class="sub">${sub}</div>`; }
  function render() {
    if (!isOpen) return;
    let h = '';
    if (S.mode === 'lobby' || S.mode === 'waiting') {
      h += head('SKILL DUELS', 'Head to head. Pure skill, play chips only. No cash value.');
      h += `<div class="row">${['chess', 'trivia'].map((g) => `<button class="${S.tab === g ? 'on' : ''}" data-tab="${g}">${g === 'chess' ? '♞ Chess' : '? Trivia'}</button>`).join('')}</div>`;
      h += `<div class="sub" style="text-align:center">${S.tab === 'chess' ? '5 minutes each + 2 seconds a move. Win on mate, resign or time.' : '10 questions, 12 seconds each. Faster right answers score more.'}</div>`;
      if (S.mode === 'waiting') h += `<div class="msg">Waiting for an opponent… (${S.wait.game}, ${S.wait.wager ? S.wait.wager + ' chips' : 'friendly'})</div><div class="row"><button data-a="cancel">Cancel challenge</button></div>`;
      else {
        h += `<div class="sub" style="text-align:center">Wager (both players put it in, winner takes both)</div><div class="row">${WAGERS.map((w) => `<button class="${S.wager === w ? 'on' : ''}" data-w="${w}">${w ? w.toLocaleString() : 'Friendly'}</button>`).join('')}</div>`;
        h += `<div class="row"><button class="on" data-a="create">Quick match / open a challenge</button><button data-a="practice">Practice vs house bot</button></div>`;
      }
      const list = S.lobby.open.filter((c) => c.game === S.tab);
      h += `<div class="sub" style="margin-top:8px">Open challenges${S.lobby.playing ? ` · ${S.lobby.playing} match${S.lobby.playing > 1 ? 'es' : ''} in play` : ''}</div>`;
      h += list.length ? list.map((c) => `<div class="ch"><span>${esc(c.by)}${c.mine ? ' (you)' : ''} · ${c.wager ? c.wager.toLocaleString() + ' chips' : 'friendly'}</span>${c.mine ? '' : `<button data-join="${c.id}">Accept</button>`}</div>`).join('') : '<div class="sub" style="text-align:center">None right now. Open one and wait, or play the house bot.</div>';
      if (S.chips != null) h += `<div class="sub" style="text-align:right">Your chips: ${S.chips.toLocaleString()}</div>`;
      h += `<div class="msg">${esc(S.msg)}</div>`;
    } else if (S.mode === 'chess') {
      const c = S.chess; const myTurn = c.turn === c.you;
      h += head('CHESS', `vs ${esc(c.opp)} · ${c.wager ? c.wager.toLocaleString() + ' chips' : 'friendly'}`);
      h += `<div class="clk"><b id="duC1" class="${!myTurn ? 'run' : ''}"></b><span>${esc(c.opp)}</span></div><div class="bd" id="duB">${board()}</div><div class="clk"><b id="duC0" class="${myTurn ? 'run' : ''}"></b><span>You (${c.you === 'w' ? 'white' : 'black'})</span></div>`;
      if (S.promo) h += `<div class="row">Promote to: ${['q', 'r', 'b', 'n'].map((p) => `<button data-p="${p}">${PIECE[c.you === 'w' ? p.toUpperCase() : p]}</button>`).join('')}</div>`;
      h += `<div class="msg">${esc(S.msg) || (myTurn ? 'Your move' : 'Waiting for opponent')}${c.check ? ' · check!' : ''}</div>`;
      h += `<div class="row">${c.offer ? '<button data-a="draw-accept" class="on">Accept draw</button><button data-a="draw-decline">Decline</button>' : '<button data-a="draw-offer">Offer draw</button>'}<button data-a="resign">Resign</button></div>`;
    } else if (S.mode === 'trivia') {
      const t = S.t; const sc = t.scores;
      h += head('TRIVIA', `vs ${esc(t.opp)} · ${t.wager ? t.wager.toLocaleString() + ' chips' : 'friendly'}`);
      h += `<div class="sc"><span>You ${sc[t.you]}</span><span>Question ${t.sudden ? 'SUDDEN DEATH' : t.n + '/' + t.of}</span><span>${esc(t.opp)} ${sc[1 - t.you]}</span></div><div class="bar"><i id="duBar"></i></div>`;
      h += `<div class="tq">${esc(t.q)}</div>`;
      h += t.opts.map((o, i) => { let cls = 'opt'; if (t.rev) { if (i === t.rev.correct) cls += ' ok'; else if (t.rev.picks[t.you] === i) cls += ' bad'; } if (t.mine === i) cls += ' me'; return `<button class="${cls}" data-ans="${i}" ${t.rev || t.mine != null ? 'disabled' : ''}>${'ABCD'[i]}. ${esc(o)}</button>`; }).join('');
      h += `<div class="msg">${t.rev ? (t.rev.pts[t.you] ? `+${t.rev.pts[t.you]}` : 'No points') + (t.rev.pts[1 - t.you] ? ` · they got +${t.rev.pts[1 - t.you]}` : '') : t.opAns ? 'Opponent has answered' : ''}</div>`;
    } else if (S.mode === 'end') {
      const e = S.end; const title = e.result === 'win' ? 'YOU WIN 🏆' : e.result === 'loss' ? 'YOU LOSE' : 'DRAW';
      h += head(title, `${esc(e.how)}${e.scores ? ` · ${e.scores[S.t ? S.t.you : 0]} to ${e.scores[S.t ? 1 - S.t.you : 1]}` : ''}`);
      h += `<div class="msg">${e.wager ? (e.result === 'win' ? `+${e.wager.toLocaleString()} chips` : e.result === 'loss' ? `-${e.wager.toLocaleString()} chips` : 'Wager returned') : 'Friendly game'}</div><div class="sub" style="text-align:center">Your chips: ${e.chips.toLocaleString()} (play chips, no cash value)</div><div class="row"><button class="on" data-a="back">Back to lobby</button></div>`;
    }
    box.innerHTML = h; tickUI();
  }
  function tickUI() {
    if (!isOpen) return;
    if (S.mode === 'chess' && S.chess) {
      const c = S.chess; const el = Date.now() - c.at; const run = c.turn === 'w' ? 0 : 1; const times = c.clk.map((v, i) => (i === run ? v - el : v));
      const mine = c.you === 'w' ? 0 : 1; const a = $('duC0'), b = $('duC1');
      if (a) { a.textContent = fmt(times[mine]); a.classList.toggle('low', times[mine] < 30000); } if (b) { b.textContent = fmt(times[1 - mine]); b.classList.toggle('low', times[1 - mine] < 30000); }
    } else if (S.mode === 'trivia' && S.t && !S.t.rev) {
      const k = Math.max(0, 1 - (Date.now() - S.t.at) / S.t.ms); const bar = $('duBar'); if (bar) bar.style.width = (k * 100) + '%';
    }
  }
  const $ = (id) => document.getElementById(id);
  box.addEventListener('click', (e) => {
    const t = e.target.closest('[data-sq],[data-tab],[data-w],[data-a],[data-join],[data-p],[data-ans]'); if (!t) return; const d = t.dataset;
    if (d.sq) return clickSq(d.sq);
    if (d.tab) { S.tab = d.tab; return render(); }
    if (d.w != null) { S.wager = +d.w; return render(); }
    if (d.join) return sendWs({ t: 'dujoin', id: d.join });
    if (d.p) { const p = S.promo; if (p) { S.promo = null; sendWs({ t: 'dumove', from: p.from, to: p.to, promo: d.p }); render(); } return; }
    if (d.ans != null) { S.t.mine = +d.ans; sendWs({ t: 'duans', i: +d.ans, q: S.t.n - 1 }); return render(); }
    const a = d.a;
    if (a === 'close') return close();
    if (a === 'create') { S.msg = ''; return sendWs({ t: 'ducreate', game: S.tab, wager: S.wager }); }
    if (a === 'cancel') { sendWs({ t: 'ducancel' }); S.mode = 'lobby'; return render(); }
    if (a === 'practice') { S.msg = ''; return sendWs({ t: 'dupractice', game: S.tab }); }
    if (a === 'resign') { if (confirm('Resign this match?')) sendWs({ t: 'duresign' }); return; }
    if (a === 'draw-offer') return sendWs({ t: 'dudraw', a: 'offer' });
    if (a === 'draw-accept') return sendWs({ t: 'dudraw', a: 'accept' });
    if (a === 'draw-decline') return sendWs({ t: 'dudraw', a: 'decline' });
    if (a === 'back') { S.mode = 'lobby'; S.end = null; S.msg = ''; return render(); }
  });
  function onMsg(m) {
    if (m.k === 'lobby') { S.lobby = { open: m.open || [], playing: m.playing || 0 }; if (S.mode === 'lobby' || S.mode === 'waiting') render(); }
    else if (m.k === 'waiting') { S.mode = 'waiting'; S.wait = { game: m.game, wager: m.wager }; if (!isOpen) open(); else render(); }
    else if (m.k === 'err') { S.msg = m.why || 'Something went wrong.'; if (S.mode === 'waiting') S.mode = 'lobby'; render(); }
    else if (m.k === 'note') { S.msg = m.text || ''; render(); }
    else if (m.k === 'chess') {
      const fresh = S.mode !== 'chess' || !S.chess || S.chess.id !== m.id; S.mode = 'chess'; S.chess = { ...m, at: Date.now() }; S.sel = null; S.promo = null; if (fresh) S.msg = '';
      if (!isOpen) open(); else render();
    } else if (m.k === 'tq') {
      S.mode = 'trivia'; S.t = { ...m, at: Date.now(), mine: null, rev: null, opAns: false }; if (!isOpen) open(); else render();
    } else if (m.k === 'tnote') { if (S.t) { S.t.opAns = true; if (!S.t.rev) render(); } }
    else if (m.k === 'tr') { if (S.t) { S.t.rev = m; S.t.scores = m.scores; render(); } }
    else if (m.k === 'end') { S.end = m; S.chips = m.chips; S.mode = 'end'; if (!isOpen) open(); else render(); }
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });
  return { open, close, toggle, onMsg, isOpen: () => isOpen, inMatch };
}
