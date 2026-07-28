/* ============================================================
   STAGWIFHOOD — Robinhood Chain token Terminal (Photon-style).
   100% client-side on Blockscout v2 (CORS-open, no key):
     token info · price/mcap · security scorecard ·
     linked-wallet bundle detection · top holders · live tx feed.
   ============================================================ */
(function () {
  'use strict';
  const BASE = 'https://robinhoodchain.blockscout.com';
  const MAX_HOLDER_PAGES = 3;   // ~150 holders
  const MAX_XFER_PAGES = 12;    // page toward creation (fresh tokens => full history)
  const MAX_NODES = 120;
  const FEED_MS = 15000;        // live feed refresh

  const $ = (id) => document.getElementById(id);
  const form = $('term-form'), input = $('term-input'), goBtn = $('term-go');
  const empty = $('term-empty'), emptyMsg = $('term-empty-msg'), board = $('term-board');

  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtNum = (n) => {
    n = Number(n);
    if (!isFinite(n)) return '—';
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };
  const fmtUsd = (n) => {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return '—';
    if (n >= 1) return '$' + fmtNum(n);
    if (n >= 0.01) return '$' + n.toFixed(4);
    return '$' + n.toPrecision(2);
  };
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  };
  const setEmpty = (t, err) => {
    empty.hidden = false; board.hidden = true;
    emptyMsg.textContent = t; empty.classList.toggle('err', !!err);
  };

  async function j(url, tries) {
    tries = tries || 3;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url);
        if (r.ok) return r.json();
        if (r.status === 404) { const e = new Error('HTTP 404'); e.notFound = true; throw e; }
        if (r.status < 500 && r.status !== 429) throw new Error('HTTP ' + r.status);
      } catch (e) { if (e.notFound || i === tries - 1) throw e; }
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  async function jSafe(url) { try { return await j(url); } catch (_) { return null; } }
  async function pages(path, maxPages) { return (await pagesFull(path, maxPages)).items; }
  // pages until we run out (reached creation) OR hit the cap. `complete` tells us which.
  async function pagesFull(path, maxPages) {
    let out = [], next = null, n = 0;
    do {
      const u = new URL(BASE + path);
      if (next) Object.entries(next).forEach(([k, v]) => u.searchParams.set(k, v));
      const d = await j(u.toString());
      out = out.concat(d.items || []);
      next = d.next_page_params; n++;
    } while (next && n < maxPages);
    return { items: out, complete: !next };
  }

  /* ---- example chips (top tokens on the chain) ---- */
  (async function chips() {
    const d = await jSafe(`${BASE}/api/v2/tokens?type=ERC-20`);
    if (!d) return;
    const wrap = $('term-chips');
    const top = (d.items || []).filter((t) => t.address_hash).slice(0, 6);
    top.forEach((t) => {
      const c = document.createElement('button');
      c.className = 'chip'; c.type = 'button'; c.textContent = t.symbol || short(t.address_hash);
      c.onclick = () => { input.value = t.address_hash; scan(t.address_hash); };
      wrap.appendChild(c);
    });
    if (top[0] && !input.value.trim()) { input.value = top[0].address_hash; scan(top[0].address_hash); }
  })();

  /* ---- union-find over transfers → linked-wallet clusters ---- */
  function clusters(ids, edges) {
    const p = {}; ids.forEach((id) => (p[id] = id));
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    edges.forEach((e) => { if (p[e.a] != null && p[e.b] != null) p[find(e.a)] = find(e.b); });
    const groups = {};
    ids.forEach((id) => { const r = find(id); (groups[r] = groups[r] || []).push(id); });
    return Object.values(groups).filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  }

  let feedTimer = null, currentCA = null, termSeq = 0;

  /* ============================================================
     $STAG holder gates — Scanner needs 100k, Trending needs 1m.
     One wallet connect reads the balance; each feature checks its tier.
     ============================================================ */
  const STAG_ADDR = '0xcC142366735c882F7885d3c747db99e45E13E453';
  const STAG_RPC = 'https://rpc.mainnet.chain.robinhood.com';
  const SCAN_GATE = 100000n * (10n ** 18n);   // 100,000 $STAG to use the scanner
  const fmtStagN = (bal) => Number(bal / (10n ** 18n)).toLocaleString();
  async function stagBalanceOf(addr) {
    try {
      const data = '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0');
      const r = await fetch(STAG_RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: STAG_ADDR, data }, 'latest'] }) });
      const jr = await r.json();
      return BigInt(jr.result && jr.result !== '0x' ? jr.result : '0x0');
    } catch { return 0n; }
  }
  const Gate = {
    addr: null, balance: 0n, ready: false,
    async connect() {
      if (!window.ethereum) throw new Error('nowallet');
      const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (accs && accs[0]) { this.addr = accs[0]; try { localStorage.setItem('tt_addr', accs[0]); } catch {} await this.refresh(); }
      return this.balance;
    },
    async refresh() { if (this.addr) { this.balance = await stagBalanceOf(this.addr); this.ready = true; document.dispatchEvent(new Event('stag-gate')); } return this.balance; },
    held() { return this.balance; },
  };
  let pendingScanCA = null;
  function showScanGate(ca) {
    pendingScanCA = ca || pendingScanCA;
    empty.hidden = false; board.hidden = true; empty.classList.remove('err');
    const ico = $('term-empty-ico'); if (ico) ico.textContent = '🔒';
    if (Gate.ready && Gate.held() < SCAN_GATE) {
      emptyMsg.innerHTML = 'The Terminal scanner is a <b>$STAG holder tool</b>. You hold <b>' + fmtStagN(Gate.held()) + ' $STAG</b> — need <b>100,000</b> to scan. <a href="/bridge" style="color:var(--gold-lite)">Get more →</a>';
    } else {
      emptyMsg.innerHTML = 'The Terminal scanner is a <b>$STAG holder tool</b> — hold <b>100,000 $STAG</b> to scan any token. Connect your wallet to unlock.';
    }
    const ga = $('scan-gate-actions'); if (ga) ga.hidden = false;
  }
  function hideScanGate() { const ga = $('scan-gate-actions'); if (ga) ga.hidden = true; const ico = $('term-empty-ico'); if (ico) ico.textContent = '🏹'; }
  async function onScanConnect() {
    emptyMsg.textContent = 'Connecting…';
    try { await Gate.connect(); }
    catch { emptyMsg.innerHTML = 'No wallet found — open this page in your wallet’s browser, or install MetaMask.'; return; }
    if (Gate.held() >= SCAN_GATE) { hideScanGate(); if (pendingScanCA) scan(pendingScanCA); }
    else showScanGate();
  }

  async function scan(caRaw) {
    const ca = (caRaw || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) { setEmpty('That doesn\'t look like a contract address (0x + 40 hex).', true); return; }
    // 🔒 holder gate — need 100k $STAG to run the scanner
    if (Gate.held() < SCAN_GATE) { showScanGate(ca); return; }
    // each scan supersedes any in-flight one so tapping a new token always switches
    const myScan = ++termSeq; currentCA = ca;
    loadDex(ca);   // chart + price changes + socials (DexScreener, non-blocking)
    if (feedTimer) { clearInterval(feedTimer); feedTimer = null; }
    goBtn.disabled = true; goBtn.textContent = 'Scanning…';
    setEmpty('Reading token…');
    try {
      const tok = await j(`${BASE}/api/v2/tokens/${ca}`);
      if (myScan !== termSeq) return;
      const dec = Number(tok.decimals || 18);
      const supplyRaw = Number(tok.total_supply || 0);
      const supply = supplyRaw || 1;
      const supplyHuman = supplyRaw / Math.pow(10, dec);

      // parallel: counters, holders, recent transfers (live feed), address meta
      const [counters, holdersRaw, xfers, addr] = await Promise.all([
        jSafe(`${BASE}/api/v2/tokens/${ca}/counters`),
        pages(`/api/v2/tokens/${ca}/holders`, MAX_HOLDER_PAGES),
        pages(`/api/v2/tokens/${ca}/transfers`, 3),
        jSafe(`${BASE}/api/v2/addresses/${ca}`),
      ]);
      if (myScan !== termSeq) return;

      const holders = (holdersRaw || []).filter((h) => h.address && h.value)
        .sort((a, b) => Number(b.value) - Number(a.value)).slice(0, MAX_NODES);
      if (!holders.length) { setEmpty('No holders found for that token on Robinhood Chain.', true); return; }

      const nodes = holders.map((h) => ({
        addr: h.address.hash,
        pct: Number(h.value) / supply * 100,
        bal: Number(h.value) / Math.pow(10, dec),
        contract: !!h.address.is_contract,
        name: h.address.name || null,
      }));
      const ids = nodes.map((n) => n.addr);
      const byLc = {}; nodes.forEach((n) => (byLc[n.addr.toLowerCase()] = n));

      // Targeted cluster query: direct transfers between the top holders only
      // (from∈holders AND to∈holders). Fast + complete, unlike pulling a busy
      // token's whole history. Wallet↔wallet only (contracts/LP excluded).
      const eoaAddrs = nodes.filter((n) => !n.contract).map((n) => n.addr);
      let rawEdges = [];
      if (window.STAG && window.STAG.fetchHolderEdges) {
        try { rawEdges = (await window.STAG.fetchHolderEdges(ca, eoaAddrs)).edges; } catch (_) { rawEdges = []; }
      } else {
        rawEdges = (xfers || []).map((t) => [((t.from && t.from.hash) || '').toLowerCase(), ((t.to && t.to.hash) || '').toLowerCase()]);
      }
      if (myScan !== termSeq) return;
      const xferWindow = { count: rawEdges.length, complete: true };
      const edgeMap = {};
      rawEdges.forEach(([f, to]) => {
        const nf = byLc[f], nt = byLc[to];
        if (!nf || !nt || nf === nt || nf.contract || nt.contract) return;
        const k = nf.addr < nt.addr ? nf.addr + '|' + nt.addr : nt.addr + '|' + nf.addr;
        edgeMap[k] = 1;
      });
      const edges = Object.keys(edgeMap).map((k) => { const [a, b] = k.split('|'); return { a, b }; });
      const groups = clusters(ids, edges);
      const pctById = {}; nodes.forEach((n) => (pctById[n.addr] = n.pct));

      renderHeader(ca, tok, addr, supplyHuman);
      renderMetrics(tok, counters, addr, supplyHuman, holders.length);
      // hand the current token to the Quick Trade panel (terminal-wallet.js)
      window.TERM_TOKEN = { ca, symbol: tok.symbol || '', decimals: dec, priceUsd: Number(tok.exchange_rate) || 0 };
      document.dispatchEvent(new Event('term-token'));
      const score = renderSecurity(tok, addr, nodes, groups, pctById);
      renderScore(score);
      renderBundles(groups, pctById, nodes, xferWindow);
      renderHolders(nodes);
      renderFeed(xfers, dec, ca);
      checkDexPaid(ca);

      empty.hidden = true; board.hidden = false;

      // live feed polling
      feedTimer = setInterval(async () => {
        if (currentCA !== ca) return;
        const nx = await jSafe(`${BASE}/api/v2/tokens/${ca}/transfers`);
        if (nx && nx.items) renderFeed(nx.items, dec, ca);
      }, FEED_MS);
    } catch (e) {
      if (myScan !== termSeq) return;   // superseded — don't flash a stale error
      const m = e && e.message || '';
      if (e && e.notFound) setEmpty('That address isn\'t an ERC-20 token on Robinhood Chain — did you paste a wallet address instead of the token contract?', true);
      else if (/Failed to fetch|NetworkError|Load failed|429|5\d\d/i.test(m)) setEmpty('Robinhood Chain\'s explorer is busy — tap Scan to try again.', true);
      else setEmpty('Couldn\'t scan that token — tap Scan to retry. (' + (m || 'error') + ')', true);
    } finally {
      if (myScan === termSeq) { goBtn.disabled = false; goBtn.textContent = 'Scan'; }
    }
  }

  /* ---------- DexScreener: chart + price changes + socials ---------- */
  async function loadDex(ca) {
    const chartPanel = $('t-chart-panel'), changes = $('t-changes'), socials = $('t-socials'), chart = $('t-chart');
    if (changes) changes.hidden = true;
    if (chartPanel) chartPanel.hidden = true;
    if (socials) socials.innerHTML = '';
    if (chart) chart.removeAttribute('src');
    let pair = null;
    try {
      const d = await j('https://api.dexscreener.com/latest/dex/tokens/' + ca, 2);
      const ps = (d.pairs || []).filter((p) => p.chainId === 'robinhood');
      pair = ps.sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0];
    } catch (_) {}
    if (ca !== currentCA || !pair) return;   // superseded or no market

    const img = (pair.info || {}).imageUrl; if (img) { const lg = $('t-logo'); if (lg) lg.src = img; }
    if (chart && pair.pairAddress) {
      chart.src = 'https://dexscreener.com/robinhood/' + pair.pairAddress + '?embed=1&theme=dark&info=0&trades=0';
      if (chartPanel) chartPanel.hidden = false;
    }
    const pc = pair.priceChange || {};
    const wins = [['5M', 'm5'], ['1H', 'h1'], ['6H', 'h6'], ['24H', 'h24']];
    let html = wins.map(([l, k]) => {
      const v = Number(pc[k]); const has = isFinite(v);
      const cls = has ? (v >= 0 ? 'up' : 'down') : '';
      const txt = has ? ((v >= 0 ? '+' : '') + v.toFixed(1) + '%') : '—';
      return '<div class="term-chg ' + cls + '"><span class="cl">' + l + '</span><span class="cv">' + txt + '</span></div>';
    }).join('');
    const liq = (pair.liquidity || {}).usd;
    html += '<div class="term-chg"><span class="cl">Liquidity</span><span class="cv" style="color:#eafff2">' + (liq ? fmtUsd(liq) : '—') + '</span></div>';
    if (changes) { changes.innerHTML = html; changes.hidden = false; }

    const links = [];
    ((pair.info || {}).websites || []).forEach((w) => links.push(['🌐 Site', w.url]));
    ((pair.info || {}).socials || []).forEach((s) => {
      const ic = s.type === 'twitter' ? '𝕏 X' : s.type === 'telegram' ? '✈️ Telegram' : s.type === 'reddit' ? '👽 Reddit' : '🔗 Link';
      links.push([ic, s.url]);
    });
    if (pair.pairAddress) links.push(['📊 DexScreener', 'https://dexscreener.com/robinhood/' + pair.pairAddress]);
    if (socials) socials.innerHTML = links.map(([l, u]) => '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(l) + '</a>').join('');
  }

  /* ---------- renderers ---------- */
  function renderHeader(ca, tok, addr, supplyHuman) {
    $('t-name').textContent = tok.name || 'Unknown Token';
    $('t-sym').textContent = '$' + (tok.symbol || '???');
    $('t-ca').textContent = short(ca);
    $('t-copy').onclick = () => {
      navigator.clipboard?.writeText(ca).then(() => { const b = $('t-copy'); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); });
    };
    $('t-explorer').href = `${BASE}/token/${ca}`;
    const bl = $('t-bubble'); if (bl) bl.href = `/bubble?ca=${ca}`;
    const logo = $('t-logo');
    if (tok.icon_url) { logo.src = tok.icon_url; logo.onerror = () => (logo.src = 'assets/img/mark.png'); }
    else logo.src = 'assets/img/mark.png';
    const verified = addr && addr.is_verified;
    $('t-verified').hidden = !verified;
  }

  function renderMetrics(tok, counters, addr, supplyHuman, mapped) {
    const price = Number(tok.exchange_rate);
    $('t-price').textContent = price > 0 ? fmtUsd(price) : '—';
    const mcap = Number(tok.circulating_market_cap) || (price > 0 ? price * supplyHuman : 0);
    $('t-mcap').textContent = mcap > 0 ? fmtUsd(mcap) : '—';
    const holders = tok.holders_count || (counters && counters.token_holders_count);
    $('t-holders').textContent = holders ? fmtNum(holders) : mapped;
    const txns = tok.transfers_count || (counters && counters.transfers_count);
    $('t-txns').textContent = txns ? fmtNum(txns) : '—';
    $('t-supply').textContent = fmtNum(supplyHuman) + ' ' + (tok.symbol || '');
    // age from creation tx
    $('t-age').textContent = '—';
    if (addr && addr.creation_tx_hash) {
      jSafe(`${BASE}/api/v2/transactions/${addr.creation_tx_hash}`).then((tx) => {
        if (tx && tx.timestamp) {
          const d = ago(tx.timestamp);
          $('t-age').textContent = d ? d + ' old' : '—';
        }
      });
    }
  }

  function pill(state) { return `<span class="chk-pill chk-${state}"></span>`; }
  function renderSecurity(tok, addr, nodes, groups, pctById) {
    const checks = [];
    let good = 0, total = 0;
    const add = (state, label, detail) => {
      checks.push({ state, label, detail });
      total++; if (state === 'ok') good += 1; else if (state === 'warn') good += 0.5;
    };

    // 1. verified contract
    const verified = !!(addr && addr.is_verified);
    add(verified ? 'ok' : 'warn', 'Contract source verified', verified ? 'Source code published' : 'Not verified on explorer');

    // 2. top-10 concentration
    const top10 = nodes.slice(0, 10).reduce((s, n) => s + n.pct, 0);
    add(top10 < 40 ? 'ok' : top10 < 65 ? 'warn' : 'bad', 'Holder distribution',
      'Top 10 hold ' + top10.toFixed(1) + '% of supply');

    // 3. holder count
    const hc = Number(tok.holders_count) || nodes.length;
    add(hc >= 500 ? 'ok' : hc >= 100 ? 'warn' : 'bad', 'Holder base',
      fmtNum(hc) + ' holders');

    // 4. single-wallet whale (excluding contracts/LP)
    const topEoa = nodes.find((n) => !n.contract);
    const whalePct = topEoa ? topEoa.pct : 0;
    add(whalePct < 5 ? 'ok' : whalePct < 15 ? 'warn' : 'bad', 'Largest wallet',
      topEoa ? topEoa.pct.toFixed(2) + '% in one wallet' : 'n/a');

    // 5. linked-wallet bundles
    const bundleIds = groups.flat();
    const bundlePct = bundleIds.reduce((s, id) => s + (pctById[id] || 0), 0);
    add(groups.length === 0 ? 'ok' : bundlePct < 15 ? 'warn' : 'bad', 'Linked-wallet bundles',
      groups.length ? groups.length + ' cluster' + (groups.length > 1 ? 's' : '') + ' holding ' + bundlePct.toFixed(1) + '%' : 'None detected among top holders');

    // 6. proxy / upgradeable
    const isProxy = !!(addr && addr.implementations && addr.implementations.length);
    add(isProxy ? 'warn' : 'ok', 'Contract type', isProxy ? 'Upgradeable proxy' : 'Non-upgradeable');

    // render list
    $('t-checks').innerHTML = checks.map((c) =>
      `<li class="term-check">${pill(c.state)}<span class="chk-label">${c.label}</span><span class="chk-detail">${c.detail}</span></li>`
    ).join('');
    $('t-top10').textContent = 'Top 10: ' + top10.toFixed(1) + '%';

    return Math.round(good / total * 100);
  }

  function renderScore(score) {
    const el = $('t-score'), ring = $('t-score-ring'), grade = $('t-grade');
    el.textContent = score;
    let g, cls;
    if (score >= 80) { g = 'Low risk'; cls = 'good'; }
    else if (score >= 55) { g = 'Caution'; cls = 'warn'; }
    else { g = 'High risk'; cls = 'bad'; }
    grade.textContent = g; grade.className = 'term-grade grade-' + cls;
    const color = cls === 'good' ? '#8ce65a' : cls === 'warn' ? '#e6b83f' : '#e8785a';
    ring.style.background = `conic-gradient(${color} ${score * 3.6}deg, rgba(255,255,255,.07) 0deg)`;
  }

  function renderBundles(groups, pctById, nodes, win) {
    const sub = $('t-bundle-sub'), box = $('t-bundles');
    // transparency line: which transfer window did we actually analyze?
    const scope = win
      ? `<p class="term-scope">Analyzed every direct transfer between the top holders (${fmtNum(win.count)} wallet-to-wallet transfers, full history).</p>`
      : '';
    if (!groups.length) {
      sub.textContent = 'Clean';
      box.innerHTML = scope + '<p class="term-check ok-text">✓ No linked-wallet clusters among the top holders — supply looks independently held.</p>';
      return;
    }
    const totalPct = groups.flat().reduce((s, id) => s + (pctById[id] || 0), 0);
    sub.textContent = groups.length + ' cluster' + (groups.length > 1 ? 's' : '') + ' · ' + totalPct.toFixed(1) + '%';
    box.innerHTML = scope + groups.slice(0, 4).map((g, i) => {
      const p = g.reduce((s, id) => s + (pctById[id] || 0), 0);
      return `<div class="bundle-row">
        <span class="bundle-tag">Cluster ${i + 1}</span>
        <span class="bundle-wallets">${g.length} wallets</span>
        <span class="bundle-pct">${p.toFixed(1)}% supply</span>
      </div>`;
    }).join('');
  }

  function renderHolders(nodes) {
    $('t-holders-list').innerHTML = nodes.slice(0, 12).map((n, i) => {
      const tag = n.contract ? '<span class="hld-tag ct">Contract/LP</span>' : (n.name ? `<span class="hld-tag">${n.name}</span>` : '');
      return `<a class="hld-row" href="${BASE}/address/${n.addr}" target="_blank" rel="noopener">
        <span class="hld-rank">${i + 1}</span>
        <span class="hld-addr">${short(n.addr)}${tag}</span>
        <span class="hld-bar"><span style="width:${Math.min(100, n.pct)}%"></span></span>
        <span class="hld-pct">${n.pct.toFixed(2)}%</span>
      </a>`;
    }).join('');
  }

  function renderFeed(xfers, dec, ca) {
    const rows = (xfers || []).slice(0, 14).map((t) => {
      const f = (t.from && t.from.hash) || '';
      const to = (t.to && t.to.hash) || '';
      const zero = /^0x0{40}$/i;
      const isMint = zero.test(f), isBurn = zero.test(to);
      const kind = isMint ? 'mint' : isBurn ? 'burn' : 'xfer';
      const val = t.total ? Number(t.total.value) / Math.pow(10, Number(t.total.decimals || dec)) : 0;
      const hash = t.transaction_hash || t.tx_hash || '';
      return `<a class="feed-row feed-${kind}" href="${BASE}/tx/${hash}" target="_blank" rel="noopener">
        <span class="feed-kind">${isMint ? '＋ Mint' : isBurn ? '🔥 Burn' : '↔ Transfer'}</span>
        <span class="feed-addrs">${short(f)} → ${short(to)}</span>
        <span class="feed-amt">${fmtNum(val)}</span>
        <span class="feed-age">${ago(t.timestamp)}</span>
      </a>`;
    }).join('');
    $('t-feed').innerHTML = rows || '<p class="term-check muted">No recent transfers.</p>';
  }

  /* ---- DexScreener "paid" enhanced-profile check (graceful if chain not indexed) ---- */
  async function checkDexPaid(ca) {
    const el = $('t-dex-paid');
    try {
      const d = await j(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
      const pairs = (d && d.pairs) || [];
      if (!pairs.length) { el.textContent = 'DEX paid: not listed'; el.className = 'term-panel-sub'; return; }
      const paid = pairs.some((p) => p.info && (p.info.imageUrl || (p.info.socials && p.info.socials.length)));
      el.textContent = paid ? 'DEX paid: ✓ yes' : 'DEX paid: no';
      el.className = 'term-panel-sub ' + (paid ? 'ok-text' : '');
    } catch (_) {
      el.textContent = 'DEX paid: —';
      el.className = 'term-panel-sub';
    }
  }

  /* ---- read ?ca= from the URL (deep-link from bubble map etc) ---- */
  (function fromUrl() {
    const q = new URLSearchParams(location.search).get('ca');
    if (q && /^0x[a-fA-F0-9]{40}$/.test(q)) { input.value = q; scan(q); }
  })();

  form.addEventListener('submit', (e) => { e.preventDefault(); scan(input.value); });

  /* ---- 🔥 live trending panel — GATED: hold 1,000,000 $STAG to unlock ---- */
  (function trending() {
    const wrap = $('tt'), list = $('tt-list'), foot = $('tt-foot'), sub = $('tt-sub');
    const gate = $('tt-gate'), gsub = $('tt-gate-sub'), connectBtn = $('tt-connect');
    if (!wrap || !list) return;

    const TREND_GATE = 1000000n * (10n ** 18n);   // 1,000,000 $STAG
    const pct = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    let unlocked = false, timer = null;

    function evaluate() {
      if (unlocked) return;
      if (Gate.held() >= TREND_GATE) unlock();
      else if (Gate.ready) gsub.innerHTML = 'You hold <b>' + fmtStagN(Gate.held()) + ' $STAG</b> — need <b>1,000,000</b> to unlock. <a href="/bridge" style="color:var(--gold-lite)">Get more →</a>';
    }
    async function connect() {
      gsub.textContent = 'Connecting…';
      try { await Gate.connect(); } catch { gsub.textContent = 'No wallet found — open this page in your wallet’s browser, or install MetaMask.'; return; }
      evaluate();
    }
    const tabs = $('tt-tabs');
    let views = null, view = 'trending';

    function unlock() {
      if (unlocked) return; unlocked = true;
      gate.hidden = true; list.hidden = false; foot.hidden = false; if (tabs) tabs.hidden = false;
      sub.textContent = 'live · powered by GeckoTerminal';
      load(); timer = setInterval(load, 60000);
    }

    const shortCa = (a) => a.slice(0, 6) + '…' + a.slice(-4);
    function render() {
      const rows = (views && views[view]) || [];
      if (!rows.length) { list.innerHTML = '<div class="tt-load">No tokens in this view right now.</div>'; return; }
      list.innerHTML = rows.map((t) => {
        const chg = Number(t.chg && t.chg.h24 || 0);
        const flow = view === 'new' && t.ageH != null ? (t.ageH < 1 ? Math.round(t.ageH * 60) + 'm old' : Math.round(t.ageH) + 'h old')
          : (t.buys24 + t.sells24) + ' trades 24h';
        const initial = escapeHtml((t.symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?');
        const pfp = t.image
          ? '<img class="tt-pfp" src="' + escapeHtml(t.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=\'<span class=&quot;tt-pfp ph&quot;>' + initial + '</span>\'" />'
          : '<span class="tt-pfp ph">' + initial + '</span>';
        return '<div class="tt-row" data-ca="' + t.address + '" role="button" tabindex="0">' +
          '<span class="tt-rank">' + t.rank + '</span>' +
          pfp +
          '<span class="tt-name"><span class="tt-sym">' + escapeHtml(t.symbol || '—') + '</span>' +
            '<span class="tt-ca">' + shortCa(t.address) + ' · ' + flow + '</span></span>' +
          '<span class="tt-vol">' + fmtUsd(t.priceUsd) + '<span>$' + fmtNum(t.volH24) + ' vol</span></span>' +
          '<span class="tt-chg ' + (chg >= 0 ? 'up' : 'down') + '">' + pct(chg) +
            '<span>$' + fmtNum(t.mcapUsd) + ' mc</span></span>' +
          '<button class="tt-trade" data-ca="' + t.address + '" title="Trade ' + escapeHtml(t.symbol || '') + '" type="button">⚡</button>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.tt-row').forEach((b) => b.onclick = () => {
        input.value = b.dataset.ca; scan(b.dataset.ca);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      list.querySelectorAll('.tt-trade').forEach((b) => b.onclick = async (e) => {
        e.stopPropagation();
        input.value = b.dataset.ca; await scan(b.dataset.ca);
        const tp = document.querySelector('.term-trade'); if (tp) tp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    async function load() {
      let data;
      try { data = await (await fetch('/api/trending')).json(); } catch { return; }
      if (data && data.views) { views = data.views; render(); }
    }
    if (tabs) tabs.querySelectorAll('button').forEach((b) => b.onclick = () => {
      tabs.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on'); view = b.dataset.v; render();
    });
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    if (connectBtn) connectBtn.onclick = connect;
    document.addEventListener('stag-gate', evaluate);
    evaluate();
  })();

  /* ---- gate init: wire scanner connect + silently restore a prior wallet ---- */
  { const sc = $('scan-connect'); if (sc) sc.onclick = onScanConnect; }
  document.addEventListener('stag-gate', () => {
    if (pendingScanCA && Gate.held() >= SCAN_GATE) { hideScanGate(); const ca = pendingScanCA; pendingScanCA = null; scan(ca); }
  });
  try { const a = localStorage.getItem('tt_addr'); if (a && /^0x[0-9a-fA-F]{40}$/.test(a)) { Gate.addr = a; Gate.refresh(); } } catch {}

  /* ---- 💼 wallet portfolio (holdings + live USD value) ---- */
  (function portfolio() {
    const pf = $('pf'), list = $('pf-list'), totalEl = $('pf-total'), connectWrap = $('pf-connect'), cbtn = $('pf-connect-btn');
    if (!pf || !list) return;
    let busy = false;
    async function loadPf(addr) {
      if (busy) return; busy = true;
      if (connectWrap) connectWrap.hidden = true; list.hidden = false;
      totalEl.textContent = 'loading…';
      let items = [];
      try { const d = await j(BASE + '/addresses/' + addr + '/tokens?type=ERC-20', 2); items = d.items || []; }
      catch { totalEl.textContent = '—'; list.innerHTML = '<div class="tt-load">Couldn’t load holdings — try again.</div>'; busy = false; return; }
      let holds = items.map((it) => { const t = it.token || {}; const dec = Number(t.decimals || 18);
        return { addr: (t.address_hash || t.address || '').toLowerCase(), sym: t.symbol || '?', icon: t.icon_url || null, dec,
          bal: Number(it.value || 0) / Math.pow(10, dec), price: Number(t.exchange_rate) || 0 }; }).filter((h) => h.addr && h.bal > 0);
      // enrich prices from GeckoTerminal (broader coverage than the explorer)
      try {
        const g = await (await fetch('https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/' + holds.map((h) => h.addr).slice(0, 30).join(','))).json();
        const pm = {}; (g.data || []).forEach((t) => { const a = t.attributes || {}; pm[(a.address || '').toLowerCase()] = Number(a.price_usd) || 0; });
        holds.forEach((h) => { if (pm[h.addr] > 0) h.price = pm[h.addr]; });
      } catch {}
      holds.forEach((h) => { h.value = h.bal * h.price; });
      holds.sort((a, b) => b.value - a.value);
      const total = holds.reduce((s, h) => s + h.value, 0);
      totalEl.textContent = total > 0 ? fmtUsd(total) : '$0';
      if (!holds.length) { list.innerHTML = '<div class="tt-load">No tokens held on Robinhood Chain.</div>'; busy = false; return; }
      list.innerHTML = holds.slice(0, 30).map((h) => {
        const initial = esc((h.sym || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?');
        const pfp = h.icon
          ? '<img class="tt-pfp" src="' + esc(h.icon) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=\'<span class=&quot;tt-pfp ph&quot;>' + initial + '</span>\'" />'
          : '<span class="tt-pfp ph">' + initial + '</span>';
        return '<div class="pf-row" role="button" tabindex="0" data-ca="' + h.addr + '">' + pfp +
          '<span class="tt-name"><span class="tt-sym">' + esc(h.sym) + '</span><span class="pf-bal">' + fmtNum(h.bal) + ' ' + esc(h.sym) + '</span></span>' +
          '<span class="pf-val">' + (h.value > 0 ? fmtUsd(h.value) : '—') + '<span>' + (h.price > 0 ? fmtUsd(h.price) : 'no price') + '</span></span>' +
        '</div>';
      }).join('');
      list.querySelectorAll('.pf-row').forEach((b) => b.onclick = () => { input.value = b.dataset.ca; scan(b.dataset.ca); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      busy = false;
    }
    if (cbtn) cbtn.onclick = async () => { try { await Gate.connect(); } catch {} if (Gate.addr) loadPf(Gate.addr); };
    document.addEventListener('stag-gate', () => { if (Gate.addr) loadPf(Gate.addr); });
    if (Gate.addr) loadPf(Gate.addr);
  })();
})();
