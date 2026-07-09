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

  async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
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

  let feedTimer = null, currentCA = null, busy = false;

  async function scan(caRaw) {
    const ca = (caRaw || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) { setEmpty('That doesn\'t look like a contract address (0x + 40 hex).', true); return; }
    if (busy) return;
    busy = true; currentCA = ca;
    if (feedTimer) { clearInterval(feedTimer); feedTimer = null; }
    goBtn.disabled = true; goBtn.textContent = 'Scanning…';
    setEmpty('Reading token…');
    try {
      const tok = await j(`${BASE}/api/v2/tokens/${ca}`);
      const dec = Number(tok.decimals || 18);
      const supplyRaw = Number(tok.total_supply || 0);
      const supply = supplyRaw || 1;
      const supplyHuman = supplyRaw / Math.pow(10, dec);

      // parallel: counters, holders, transfers, address meta
      const [counters, holdersRaw, xferRes, addr] = await Promise.all([
        jSafe(`${BASE}/api/v2/tokens/${ca}/counters`),
        pages(`/api/v2/tokens/${ca}/holders`, MAX_HOLDER_PAGES),
        pagesFull(`/api/v2/tokens/${ca}/transfers`, MAX_XFER_PAGES),
        jSafe(`${BASE}/api/v2/addresses/${ca}`),
      ]);
      const xfers = xferRes.items;
      const xferWindow = { count: xfers.length, complete: xferRes.complete };

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
      const idSet = new Set(nodes.map((n) => n.addr));

      // transfer edges among mapped holders → clusters
      const edgeMap = {};
      (xfers || []).forEach((t) => {
        const f = t.from && t.from.hash, to = t.to && t.to.hash;
        if (!f || !to || f === to || !idSet.has(f) || !idSet.has(to)) return;
        const k = f < to ? f + '|' + to : to + '|' + f;
        edgeMap[k] = 1;
      });
      const edges = Object.keys(edgeMap).map((k) => { const [a, b] = k.split('|'); return { a, b }; });
      const groups = clusters([...idSet], edges);
      const pctById = {}; nodes.forEach((n) => (pctById[n.addr] = n.pct));

      renderHeader(ca, tok, addr, supplyHuman);
      renderMetrics(tok, counters, addr, supplyHuman, holders.length);
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
      setEmpty('Couldn\'t scan that token — check the address is an ERC-20 on Robinhood Chain. (' + (e.message || 'error') + ')', true);
    } finally {
      busy = false; goBtn.disabled = false; goBtn.textContent = 'Scan';
    }
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
    $('t-bubble').href = `/bubble?ca=${ca}`;
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
      ? `<p class="term-scope">${win.complete
          ? `✓ Full transfer history analyzed (${fmtNum(win.count)} transfers, creation → now).`
          : `Analyzed the ${fmtNum(win.count)} most recent transfers (token too active to reach creation client-side).`}</p>`
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
})();
