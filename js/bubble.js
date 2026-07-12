/* ============================================================
   STAGWIFHOOD — Robinhood Chain holder Bubble Map (Hooded Maps)
   Client-side: Blockscout v2 API (CORS open) → force-graph.
   Nodes  = top holders (size ∝ % supply)
   Links  = linked wallets, colored by cluster
   Cluster= union-find over TWO edge sources:
     (a) direct transfers between two top holders (contracts/LP excluded), and
     (b) same-block acquisitions — wallets whose FIRST incoming transfer of the
         token landed in the same block (a strong bundle/sniper link).
   Right-hand Address List sidebar ranks holders + collapsible cluster groups.
   ============================================================ */
(function () {
  'use strict';
  const BASE = 'https://robinhoodchain.blockscout.com';
  const MAX_HOLDER_PAGES = 3;    // ~150 holders
  const MAX_XFER_PAGES = 20;     // deeper cluster coverage (async, does not block first paint)
  const MAX_NODES = 120;
  const SAMEBLOCK_MAX = 14;      // ignore same-block groups bigger than this (launch dumps, not bundles)
  const PALETTE = ['#e6b83f', '#8ce65a', '#5ad1e6', '#c98cff', '#ff8c8c', '#ffd24a', '#7affb0', '#ff9a5a', '#9ad0ff', '#ff6fae'];
  const SOLO = 'rgba(150,190,150,.55)';
  const CONTRACT = '#6fa8ff';
  const DEAD = '#7c8a7c';

  const $ = (id) => document.getElementById(id);
  const form = $('ca-form'), input = $('ca-input'), goBtn = $('ca-go');
  const overlay = $('graph-overlay'), msg = $('graph-msg'), legend = $('graph-legend'), statsEl = $('bubble-stats');

  let Graph = null;
  let scanSeq = 0;
  // live state for the sidebar + visibility toggles
  let curNodes = [], curEdges = [], curClusters = [], curById = {};
  let ungroupOn = false, addrFilter = '', selectedId = null;
  const hidden = new Set();      // node ids hidden from the graph
  const expanded = new Set();    // expanded cluster indices in the sidebar

  /* ---- helpers ---- */
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eid = (e) => (e && typeof e === 'object') ? e.id : e;
  const fmtNum = (n) => {
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };
  const setMsg = (t, err) => { overlay.hidden = false; msg.innerHTML = t; msg.className = 'graph-msg' + (err ? ' err' : ''); };
  function hexToRgba(hex, a) {
    if (!hex || hex[0] !== '#') return 'rgba(150,190,150,' + a + ')';
    let m = hex.slice(1); if (m.length === 3) m = m.split('').map((x) => x + x).join('');
    const n = parseInt(m, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // fetch JSON with retry on transient failures (network / 429 / 5xx). A 404
  // (not a token) fails fast so we can give the user the right message.
  async function j(url, tries) {
    tries = tries || 3;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url);
        if (r.ok) return r.json();
        if (r.status === 404) { const e = new Error('HTTP 404'); e.notFound = true; throw e; }
        if (r.status < 500 && r.status !== 429) throw new Error('HTTP ' + r.status);
        // 429 / 5xx → retry
      } catch (e) {
        if (e.notFound || i === tries - 1) throw e;
      }
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  async function pages(path, maxPages) {
    let out = [], next = null, n = 0;
    do {
      const u = new URL(BASE + path);
      if (next) Object.entries(next).forEach(([k, v]) => u.searchParams.set(k, v));
      const d = await j(u.toString());
      out = out.concat(d.items || []);
      next = d.next_page_params; n++;
    } while (next && n < maxPages);
    return out;
  }

  /* ---- example chips (top tokens on the chain) ---- */
  (async function chips() {
    try {
      const d = await j(`${BASE}/api/v2/tokens?type=ERC-20`);
      const wrap = $('example-chips');
      const top = (d.items || []).filter((t) => t.address_hash).slice(0, 6);
      top.forEach((t) => {
        const c = document.createElement('button');
        c.className = 'chip'; c.type = 'button'; c.textContent = t.symbol || short(t.address_hash);
        c.onclick = () => { input.value = t.address_hash; scan(t.address_hash); };
        wrap.appendChild(c);
      });
      // auto-load the top token so bubbles show immediately (unless a CA is already typed)
      if (top[0] && !input.value.trim()) { input.value = top[0].address_hash; scan(top[0].address_hash); }
    } catch (_) {}
  })();

  /* ---- union-find → clusters (richer output for the sidebar) ---- */
  function computeClusters(nodes, edges) {
    const p = {}; nodes.forEach((n) => (p[n.id] = n.id));
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p[ra] = rb; };
    edges.forEach((e) => { const s = eid(e.source), t = eid(e.target); if (p[s] != null && p[t] != null) uni(s, t); });
    const groups = {};
    nodes.forEach((n) => { const r = find(n.id); (groups[r] = groups[r] || []).push(n); });
    let multi = Object.values(groups).filter((g) => g.length > 1);
    multi.forEach((g) => g.sort((a, b) => b.pct - a.pct));
    const sumPct = (g) => g.reduce((s, n) => s + n.pct, 0);
    multi.sort((a, b) => sumPct(b) - sumPct(a));
    const colorOf = {}, clusterOf = {};
    const clusterList = multi.map((g, i) => {
      const color = PALETTE[i % PALETTE.length];
      g.forEach((n) => { colorOf[n.id] = color; clusterOf[n.id] = i; });
      return { idx: i, color, members: g, sumPct: sumPct(g) };
    });
    return { colorOf, clusterOf, clusterList, clusterCount: clusterList.length, biggest: multi[0] ? multi[0].length : 0 };
  }

  // Build the edge list from both the whole-chain direct edges (RPC helper) and
  // the Blockscout transfer sample (which carries block_number for same-block
  // acquisition detection). byLc maps lowercased address → node.
  function buildEdges(directRaw, xfers, byLc) {
    const edgeMap = {};
    const addEdge = (aId, bId) => {
      if (aId === bId) return;
      const k = aId < bId ? aId + '|' + bId : bId + '|' + aId;
      edgeMap[k] = (edgeMap[k] || 0) + 1;
    };
    const linkable = (n) => n && !n.contract && !n.dead;

    // (a-1) direct edges from the whole-chain RPC helper (from,to lowercased)
    (directRaw || []).forEach(([f, to]) => {
      const nf = byLc[(f || '').toLowerCase()], nt = byLc[(to || '').toLowerCase()];
      if (linkable(nf) && linkable(nt)) addEdge(nf.id, nt.id);
    });

    // (a-2) direct edges + first-incoming block from the Blockscout transfer sample
    const firstIn = {}; // node id → earliest block a holder RECEIVED the token
    (xfers || []).forEach((t) => {
      const f = ((t.from && t.from.hash) || '').toLowerCase();
      const to = ((t.to && t.to.hash) || '').toLowerCase();
      const blk = Number(t.block_number != null ? t.block_number : t.block);
      const nf = byLc[f], nt = byLc[to];
      if (linkable(nf) && linkable(nt)) addEdge(nf.id, nt.id);
      if (linkable(nt) && isFinite(blk)) {
        if (firstIn[nt.id] == null || blk < firstIn[nt.id]) firstIn[nt.id] = blk;
      }
    });

    // (b) same-block acquisition groups → chain the members so union-find merges them
    const byBlock = {};
    Object.entries(firstIn).forEach(([id, blk]) => { (byBlock[blk] = byBlock[blk] || []).push(id); });
    Object.values(byBlock).forEach((ids) => {
      if (ids.length < 2 || ids.length > SAMEBLOCK_MAX) return; // skip singletons + launch-wide same-block dumps
      for (let i = 0; i < ids.length - 1; i++) addEdge(ids[i], ids[i + 1]);
    });

    return Object.entries(edgeMap).map(([k, count]) => {
      const [source, target] = k.split('|'); return { source, target, count };
    });
  }

  async function scan(caRaw) {
    const ca = (caRaw || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) { setMsg('That doesn\'t look like a contract address (0x + 40 hex).', true); return; }
    // Each scan supersedes any in-flight one (so tapping a new token/chip always
    // switches, even while another is still loading). Stale scans bail on await.
    const myScan = ++scanSeq;
    hideInfo();
    goBtn.disabled = true; goBtn.textContent = 'Mapping…';
    setMsg('Reading token…'); legend.hidden = true; statsEl.hidden = true;
    try {
      const tok = await j(`${BASE}/api/v2/tokens/${ca}`);
      if (myScan !== scanSeq) return;
      const dec = Number(tok.decimals || 18);
      const supply = Number(tok.total_supply || 0) || 1;
      setMsg('Loading holders…');
      let holders = await pages(`/api/v2/tokens/${ca}/holders`, MAX_HOLDER_PAGES);
      if (myScan !== scanSeq) return;
      holders = holders.filter((h) => h.address && h.value)
        .sort((a, b) => (Number(b.value) - Number(a.value))).slice(0, MAX_NODES);
      if (!holders.length) { setMsg('No holders found for that token.', true); return; }

      const nodeMap = {};
      const nodes = holders.map((h, i) => {
        const addr = h.address.hash;
        const lc = addr.toLowerCase();
        const bal = Number(h.value);
        const pct = bal / supply * 100;
        const isZero = /^0x0+$/.test(lc);
        const isDead = isZero || /dead$/.test(lc);
        const n = {
          id: addr, short: short(addr), rank: i + 1, pct,
          label: h.address.name || (h.address.ens_domain_name || null),
          balDisp: fmtNum(bal / Math.pow(10, dec)),
          contract: !!h.address.is_contract,
          dead: isDead, zero: isZero,
          val: Math.max(0.06, pct),
          color: isDead ? DEAD : (h.address.is_contract ? CONTRACT : SOLO),
          cluster: false,
        };
        nodeMap[addr] = n; return n;
      });

      // ---- PHASE 1: show bubbles immediately from holders (no waiting on transfers) ----
      const top10 = nodes.slice(0, 10).reduce((s, n) => s + n.pct, 0);
      $('s-symbol').textContent = tok.symbol || '?';
      $('s-holders').textContent = tok.holders_count ? fmtNum(tok.holders_count) : nodes.length;
      $('s-top10').textContent = top10.toFixed(1) + '%';
      $('s-clusters').textContent = '…';
      $('s-nodes').textContent = nodes.length;
      statsEl.hidden = false;

      // reset sidebar/graph state for the new token
      curNodes = nodes; curEdges = []; curClusters = [];
      curById = nodeMap; hidden.clear(); expanded.clear(); selectedId = null;
      addrFilter = ''; if ($('addr-search')) $('addr-search').value = '';
      render(nodes, []);
      renderSidebar();
      overlay.hidden = true; legend.hidden = false;

      // ---- PHASE 2: cluster detection (direct transfers + same-block acquisitions) ----
      // Contracts/LP + burn/null are excluded so pool trades / burns don't merge everyone.
      const byLc = {}; nodes.forEach((n) => (byLc[n.id.toLowerCase()] = n));
      const eoaAddrs = nodes.filter((n) => !n.contract && !n.dead).map((n) => n.id);

      // whole-chain direct edges via the RPC helper (cheap, ~6 calls); Blockscout
      // transfers give block_number for same-block detection. Both are best-effort.
      const pDirect = (window.STAG && window.STAG.fetchHolderEdges)
        ? window.STAG.fetchHolderEdges(ca, eoaAddrs).then((r) => r.edges).catch(() => [])
        : Promise.resolve([]);
      const pXfers = pages(`/api/v2/tokens/${ca}/transfers`, MAX_XFER_PAGES).catch(() => []);

      Promise.all([pDirect, pXfers]).then(([directRaw, xfers]) => {
        if (myScan !== scanSeq) return; // a newer scan started — drop stale result
        const edges = buildEdges(directRaw, xfers, byLc);
        const { colorOf, clusterOf, clusterList, clusterCount } = computeClusters(nodes, edges);
        // paint node colors + link colors by cluster
        nodes.forEach((n) => {
          n.color = n.contract ? CONTRACT : n.dead ? DEAD : (colorOf[n.id] || SOLO);
          n.cluster = !!colorOf[n.id];
        });
        edges.forEach((e) => {
          const cs = clusterOf[eid(e.source)], ct = clusterOf[eid(e.target)];
          e.color = (cs != null && cs === ct) ? hexToRgba(colorOf[eid(e.source)], 0.5) : 'rgba(150,190,150,.16)';
        });
        curEdges = edges; curClusters = clusterList;
        $('s-clusters').textContent = clusterCount;
        pushGraphData();
        renderSidebar();
        if (Graph) setTimeout(() => Graph.zoomToFit(500, 40), 600);
      }).catch(() => { $('s-clusters').textContent = '0'; });
    } catch (e) {
      if (myScan !== scanSeq) return;   // a newer scan superseded this — don't flash its error
      const m = e && e.message || '';
      if (e && e.notFound) {
        setMsg('That address isn\'t an ERC-20 token on Robinhood Chain — did you paste a <b>wallet</b> address by mistake? Use the token <b>contract</b> address.', true);
      } else if (/Failed to fetch|NetworkError|Load failed|429|5\d\d/i.test(m)) {
        setMsg('Robinhood Chain\'s explorer is busy right now — tap <b>Map it</b> to try again.', true);
      } else {
        setMsg('Couldn\'t load that token — tap <b>Map it</b> to retry. (' + (m || 'error') + ')', true);
      }
    } finally {
      if (myScan === scanSeq) { goBtn.disabled = false; goBtn.textContent = 'Map it'; }
    }
  }

  function lighten(c) {
    if (c[0] === '#') {
      let m = c.slice(1); if (m.length === 3) m = m.split('').map((x) => x + x).join('');
      const n = parseInt(m, 16);
      const r = Math.min(255, ((n >> 16) & 255) + 90), g = Math.min(255, ((n >> 8) & 255) + 90), b = Math.min(255, (n & 255) + 90);
      return `rgb(${r},${g},${b})`;
    }
    return 'rgba(210,232,210,.95)';
  }
  // Bubbles are sized RELATIVE to the biggest holder in the set. r precomputed in render().
  const MIN_R = 7, MAX_R = 48;
  const radius = (n) => n.r || MIN_R;

  // O(n²) collision force (fine for ≤120 nodes) — packs bubbles so they just
  // touch instead of scattering. This is what makes it read as a bubble map.
  function makeCollide(pad) {
    let ns = [];
    const force = (alpha) => {
      for (let i = 0; i < ns.length; i++) {
        const a = ns[i]; if (!isFinite(a.x)) continue;
        const ra = (a.r || MIN_R) + pad;
        for (let k = i + 1; k < ns.length; k++) {
          const b = ns[k]; if (!isFinite(b.x)) continue;
          const rb = (b.r || MIN_R) + pad;
          let dx = b.x - a.x, dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const min = ra + rb;
          if (dist < min) {
            const push = (min - dist) / dist * alpha * 0.7;
            const fx = dx * push, fy = dy * push;
            a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
          }
        }
      }
    };
    force.initialize = (nodes) => { ns = nodes; };
    return force;
  }

  // Feed the graph the currently-visible nodes/links (respecting hidden set).
  function pushGraphData() {
    if (!Graph) return;
    const vis = curNodes.filter((n) => !hidden.has(n.id));
    const visSet = new Set(vis.map((n) => n.id));
    const links = curEdges.filter((e) => visSet.has(eid(e.source)) && visSet.has(eid(e.target)));
    Graph.graphData({ nodes: vis, links });
  }

  function render(nodes, edges) {
    const el = $('graph');
    const W = el.clientWidth || 900, H = el.clientHeight || 620;
    // flag the whale + size every bubble relative to the biggest holder
    let maxVal = 0; nodes.forEach((n) => { if (n.val > maxVal) maxVal = n.val; });
    maxVal = maxVal || 1;
    let maxPct = 0; nodes.forEach((n) => { if (n.pct > maxPct) maxPct = n.pct; });
    nodes.forEach((n) => {
      n.whale = (n.pct === maxPct);
      n.r = MIN_R + (MAX_R - MIN_R) * Math.sqrt(n.val / maxVal);
    });

    if (!Graph) {
      Graph = ForceGraph()(el)
        .backgroundColor('rgba(6,16,9,0)')
        .nodeLabel((n) => `<div style="font-family:Inter,sans-serif;font-size:12px;padding:2px 2px"><b>${esc(n.label || n.short)}</b>${n.contract ? ' · contract/LP' : n.dead ? ' · burn/null' : n.whale ? ' · 🐋 whale' : ''}<br><span style="color:#e6b83f">${n.pct.toFixed(2)}%</span> of supply · ${esc(n.balDisp)}</div>`)
        .linkColor((l) => l.color || 'rgba(150,190,150,.2)')
        .linkWidth((l) => Math.min(3, 1 + (l.count || 1) * 0.4))
        .linkDirectionalParticles(0)
        .onNodeClick((n) => focusNode(n.id))
        .onBackgroundClick(() => { hideInfo(); selectedId = null; renderSidebar(); })
        .nodeCanvasObject((n, ctx, scale) => {
          if (!isFinite(n.x) || !isFinite(n.y)) return; // positions not settled yet
          const r = radius(n);
          // glowing gradient orb
          ctx.save();
          ctx.shadowColor = n.color; ctx.shadowBlur = Math.min(22, r * 1.4);
          const grad = ctx.createRadialGradient(n.x - r * 0.35, n.y - r * 0.35, r * 0.12, n.x, n.y, r);
          grad.addColorStop(0, 'rgba(255,255,255,.95)');
          grad.addColorStop(0.28, lighten(n.color));
          grad.addColorStop(1, n.color);
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fillStyle = grad; ctx.fill();
          ctx.restore();
          // selection ring (clicked from the sidebar or the graph)
          if (n.id === selectedId) {
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5 / scale, 0, 2 * Math.PI);
            ctx.strokeStyle = 'rgba(248,230,160,.98)'; ctx.lineWidth = 2.4 / scale; ctx.stroke();
          }
          // whale gold ring
          if (n.whale) {
            ctx.beginPath(); ctx.arc(n.x, n.y, r + 1.8 / scale, 0, 2 * Math.PI);
            ctx.strokeStyle = 'rgba(248,230,160,.95)'; ctx.lineWidth = 2 / scale; ctx.stroke();
          }
          // % label on the bigger bubbles (font in graph units so it fits inside)
          if (r >= 15) {
            ctx.font = `700 ${(r * 0.62).toFixed(1)}px Inter, sans-serif`;
            ctx.fillStyle = 'rgba(6,12,7,.92)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(n.pct.toFixed(n.pct >= 10 ? 0 : 1) + '%', n.x, n.y);
          }
        })
        .nodePointerAreaPaint((n, color, ctx) => {
          const r = radius(n); ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fill();
        });
    }
    Graph.width(W).height(H);
    pushGraphData();
    Graph.d3VelocityDecay(0.4);
    // mild charge + collide packing → dense bubble cluster that fills the canvas
    if (Graph.d3Force('charge')) Graph.d3Force('charge').strength((n) => -((n.r || MIN_R) * 1.1 + 6));
    Graph.d3Force('collide', makeCollide(1.5));
    if (Graph.d3Force('link')) Graph.d3Force('link').distance((l) => (l.source.r || MIN_R) + (l.target.r || MIN_R) + 6).strength(0.25);
    Graph.d3ReheatSimulation && Graph.d3ReheatSimulation();
    setTimeout(() => Graph.zoomToFit(500, 40), 500);
    setTimeout(() => Graph.zoomToFit(500, 40), 1500);
  }

  /* ============================================================
     ADDRESS LIST SIDEBAR
     ============================================================ */
  const EYE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/></svg>';

  const dispName = (n) => n.label ? esc(n.label) : esc(n.short);
  const eyeBtn = (attr, off) =>
    `<button class="eye${off ? ' off' : ''}" ${attr} type="button" title="Toggle on map" aria-label="Toggle visibility">${off ? EYE_OFF : EYE}</button>`;

  function holderTag(n) {
    if (n.dead) return `<span class="atag dead">${n.zero ? 'Null' : 'Burn'}</span>`;
    if (n.contract) return '<span class="atag">Contract</span>';
    return '';
  }
  function holderRow(n) {
    const sel = n.id === selectedId ? ' sel' : '';
    const dim = (n.contract || n.dead) ? ' dim' : '';
    return `<div class="arow${sel}${dim}" data-id="${esc(n.id)}">`
      + `<span class="rank">${n.rank}</span>`
      + `<span class="dot" style="background:${n.color};color:${n.color}"></span>`
      + `<span class="addr">${dispName(n)}</span>`
      + holderTag(n)
      + `<span class="pct">${n.pct.toFixed(2)}%</span>`
      + eyeBtn(`data-id="${esc(n.id)}"`, hidden.has(n.id))
      + '</div>';
  }
  function memberRow(m) {
    const sel = m.id === selectedId ? ' sel' : '';
    const dim = (m.contract || m.dead) ? ' dim' : '';
    return `<div class="arow${sel}${dim}" data-id="${esc(m.id)}">`
      + `<span class="rank">${m.rank}</span>`
      + `<span class="addr">${dispName(m)}</span>`
      + holderTag(m)
      + `<span class="pct">${m.pct.toFixed(2)}%</span>`
      + eyeBtn(`data-id="${esc(m.id)}"`, hidden.has(m.id))
      + '</div>';
  }
  function clusterGroup(c, open, members) {
    const allHidden = c.members.every((m) => hidden.has(m.id));
    const body = members.map(memberRow).join('');
    return `<div class="cgroup${open ? ' open' : ''}">`
      + `<div class="crow" data-cluster="${c.idx}">`
      + '<span class="caret">▶</span>'
      + `<span class="cdot" style="background:${c.color};color:${c.color}"></span>`
      + `<span class="cname">Cluster ${c.idx + 1}</span>`
      + `<span class="cmeta">(${c.members.length})</span>`
      + `<span class="pct">${c.sumPct.toFixed(2)}%</span>`
      + eyeBtn(`data-cluster="${c.idx}"`, allHidden)
      + '</div>'
      + `<div class="cmembers">${body}</div>`
      + '</div>';
  }

  function renderSidebar() {
    const rowsEl = $('addr-rows'); if (!rowsEl) return;
    if (!curNodes.length) { rowsEl.innerHTML = '<div class="addr-empty">Map a token to see its holders ranked here.</div>'; return; }
    const scroll = rowsEl.scrollTop;
    const f = addrFilter;
    const match = (n) => !f || n.id.toLowerCase().includes(f) || (n.label && n.label.toLowerCase().includes(f));
    let html = '';

    if (ungroupOn) {
      const list = curNodes.filter(match);
      html = list.length ? list.map(holderRow).join('') : '<div class="addr-empty">No addresses match.</div>';
    } else {
      const inCluster = new Set();
      curClusters.forEach((c) => c.members.forEach((m) => inCluster.add(m.id)));
      // cluster groups first (sorted by summed %)
      curClusters.forEach((c) => {
        const mm = f ? c.members.filter(match) : c.members;
        if (f && !mm.length) return;
        const open = expanded.has(c.idx) || (!!f && mm.length > 0);
        html += clusterGroup(c, open, mm);
      });
      // then independent holders
      const solos = curNodes.filter((n) => !inCluster.has(n.id) && match(n));
      if (solos.length) {
        if (curClusters.length) html += '<div class="section-label">Independent holders</div>';
        html += solos.map(holderRow).join('');
      }
      if (!html) html = '<div class="addr-empty">No addresses match.</div>';
    }
    rowsEl.innerHTML = html;
    rowsEl.scrollTop = scroll;
  }

  function toggleVis(ds) {
    if (ds.id) {
      if (hidden.has(ds.id)) hidden.delete(ds.id); else hidden.add(ds.id);
    } else if (ds.cluster != null) {
      const c = curClusters[+ds.cluster]; if (!c) return;
      const anyVisible = c.members.some((m) => !hidden.has(m.id));
      c.members.forEach((m) => { if (anyVisible) hidden.add(m.id); else hidden.delete(m.id); });
    }
    pushGraphData();
    renderSidebar();
  }

  function focusNode(id) {
    const n = curById[id]; if (!n) return;
    if (hidden.has(id)) { hidden.delete(id); pushGraphData(); }
    selectedId = id;
    showInfo(n);
    renderSidebar();
    if (Graph && isFinite(n.x) && isFinite(n.y)) {
      Graph.centerAt(n.x, n.y, 700);
      Graph.zoom(3, 700);
    }
  }

  // sidebar event delegation
  (function wireSidebar() {
    const rowsEl = $('addr-rows');
    if (rowsEl) rowsEl.addEventListener('click', (e) => {
      const eyeEl = e.target.closest('.eye');
      if (eyeEl) { e.stopPropagation(); toggleVis(eyeEl.dataset); return; }
      const crow = e.target.closest('.crow');
      if (crow) { const i = +crow.dataset.cluster; if (expanded.has(i)) expanded.delete(i); else expanded.add(i); renderSidebar(); return; }
      const arow = e.target.closest('.arow');
      if (arow && arow.dataset.id) { focusNode(arow.dataset.id); }
    });
    const ung = $('ungroup');
    if (ung) ung.addEventListener('change', () => { ungroupOn = ung.checked; renderSidebar(); });
    const search = $('addr-search');
    if (search) search.addEventListener('input', () => { addrFilter = search.value.trim().toLowerCase(); renderSidebar(); });
  })();

  /* ---- click a bubble → info card (no more surprise link navigation) ---- */
  function showInfo(n) {
    const box = $('bubble-info'); if (!box) { window.open(`${BASE}/address/${n.id}`, '_blank'); return; }
    let tag = n.contract ? '<span class="bi-tag ct">Contract / LP</span>'
      : n.dead ? `<span class="bi-tag ct">${n.zero ? 'Null address' : 'Burn address'}</span>`
      : n.whale ? '<span class="bi-tag whale">🐋 Whale</span>'
      : n.cluster ? '<span class="bi-tag cl">Linked cluster</span>'
      : '<span class="bi-tag">Independent</span>';
    if (n.label) tag += ` <span class="bi-tag">${esc(n.label)}</span>`;
    $('bi-tags').innerHTML = tag;
    $('bi-addr').textContent = n.short;
    $('bi-pct').textContent = n.pct.toFixed(2) + '%';
    $('bi-bal').textContent = n.balDisp;
    const cp = $('bi-copy'); cp.onclick = () => navigator.clipboard?.writeText(n.id).then(() => { cp.textContent = 'Copied'; setTimeout(() => (cp.textContent = 'Copy'), 1200); });
    $('bi-explorer').href = `${BASE}/address/${n.id}`;
    box.hidden = false;
  }
  function hideInfo() { const box = $('bubble-info'); if (box) box.hidden = true; }

  // responsive
  window.addEventListener('resize', () => { if (Graph) { const el = $('graph'); Graph.width(el.clientWidth).height(el.clientHeight); } });

  form.addEventListener('submit', (e) => { e.preventDefault(); scan(input.value); });
  const infoX = $('bubble-info-x'); if (infoX) infoX.addEventListener('click', () => { hideInfo(); selectedId = null; renderSidebar(); });
})();
