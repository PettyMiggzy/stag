/* ============================================================
   STAGWIFHOOD — Robinhood Chain holder Bubble Map
   Client-side: Blockscout v2 API (CORS open) → force-graph.
   Nodes = top holders (size ∝ % supply), links = transfers,
   colors = connected-wallet clusters (union-find over transfers).
   ============================================================ */
(function () {
  'use strict';
  const BASE = 'https://robinhoodchain.blockscout.com';
  const MAX_HOLDER_PAGES = 3;    // ~150 holders
  const MAX_XFER_PAGES = 10;     // deeper cluster coverage (async, does not block first paint)
  const MAX_NODES = 120;
  const FULL_HISTORY_MAX = 15000; // ≤ this many transfers → pull the whole graph; above → targeted fetch
  const PALETTE = ['#e6b83f', '#8ce65a', '#5ad1e6', '#c98cff', '#ff8c8c', '#ffd24a', '#7affb0', '#ff9a5a', '#9ad0ff', '#ff6fae'];
  const SOLO = 'rgba(150,190,150,.55)';
  const CONTRACT = '#6fa8ff';

  const $ = (id) => document.getElementById(id);
  const form = $('ca-form'), input = $('ca-input'), goBtn = $('ca-go');
  const overlay = $('graph-overlay'), msg = $('graph-msg'), legend = $('graph-legend'), statsEl = $('bubble-stats');
  let Graph = null;
  let scanSeq = 0;

  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const fmtNum = (n) => {
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };
  const setMsg = (t, err) => { overlay.hidden = false; msg.innerHTML = t; msg.className = 'graph-msg' + (err ? ' err' : ''); };

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

  /* ---- union-find for clusters ---- */
  function clusters(nodes, edges) {
    const p = {}; nodes.forEach((n) => (p[n.id] = n.id));
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const uni = (a, b) => { p[find(a)] = find(b); };
    edges.forEach((e) => { if (p[e.source] != null && p[e.target] != null) uni(e.source, e.target); });
    const groups = {};
    nodes.forEach((n) => { const r = find(n.id); (groups[r] = groups[r] || []).push(n); });
    const multi = Object.values(groups).filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
    const colorOf = {};
    multi.forEach((g, i) => g.forEach((n) => (colorOf[n.id] = PALETTE[i % PALETTE.length])));
    return { colorOf, clusterCount: multi.length, biggest: multi[0] ? multi[0].length : 0 };
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
      const nodes = holders.map((h) => {
        const addr = h.address.hash;
        const bal = Number(h.value);
        const pct = bal / supply * 100;
        const n = {
          id: addr, short: short(addr), pct,
          balDisp: fmtNum(bal / Math.pow(10, dec)),
          contract: !!h.address.is_contract,
          val: Math.max(0.06, pct),
          color: !!h.address.is_contract ? CONTRACT : SOLO, cluster: false,
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
      render(nodes, []);
      overlay.hidden = true; legend.hidden = false;

      // ---- PHASE 2: enhanced connected-wallet detection (direct + shared-funder) ----
      // Two kinds of links, both validated over a 45-run sim on real chain tokens:
      //  1. DIRECT  — a top holder transferred the token straight to another top
      //     holder (from∈holders AND to∈holders).
      //  2. SHARED  — two+ holders were funded/emptied by the SAME outside wallet
      //     that touches only a FEW holders (2..D). A low-degree common source is
      //     a bundle funder; a high-degree one is an exchange/router (a hub) and is
      //     excluded so it doesn't false-link everyone. D=5 was the sim's sweet spot
      //     (14.9 wallets connected/token, minimal hub-leak). Contracts/LP & the
      //     zero address are never counterparties.
      const D = 5;
      const byLc = {}; nodes.forEach((n) => (byLc[n.id.toLowerCase()] = n));
      const eoaAddrs = nodes.filter((n) => !n.contract).map((n) => n.id);
      const finish = (edges, clusterCount, colorOf) => {
        nodes.forEach((n) => { n.color = n.contract ? CONTRACT : (colorOf[n.id] || SOLO); n.cluster = !!colorOf[n.id]; });
        $('s-clusters').textContent = clusterCount;
        if (Graph) { Graph.graphData({ nodes, links: edges }); setTimeout(() => Graph.zoomToFit(500, 40), 600); }
      };
      // Index-aware fetch: ask Blockscout's counters how many transfers this token
      // has (cheap, pre-indexed). Small/young tokens → pull the COMPLETE transfer
      // graph (every wallet, ~7 calls) so shared-funder detection sees bundles even
      // among non-top-holders. Busy tokens → stay targeted (transfers touching top
      // holders only) so a phone never chokes on a 200k-transfer history.
      const S = window.STAG || {};
      const enhanced = !!(S.fetchHolderTransfers || S.fetchAllTransfers);
      const loader = (async () => {
        const count = S.getTransferCount ? await S.getTransferCount(ca) : null;
        if (count != null && count <= FULL_HISTORY_MAX && S.fetchAllTransfers) {
          return (await S.fetchAllTransfers(ca)).edges;            // complete graph
        }
        if (S.fetchHolderTransfers) return (await S.fetchHolderTransfers(ca, eoaAddrs)).edges;  // targeted + shared
        if (S.fetchHolderEdges) return (await S.fetchHolderEdges(ca, eoaAddrs)).edges;          // targeted direct-only
        const xf = await pages(`/api/v2/tokens/${ca}/transfers`, MAX_XFER_PAGES);               // Blockscout fallback
        return xf.map((t) => [((t.from && t.from.hash) || '').toLowerCase(), ((t.to && t.to.hash) || '').toLowerCase()]);
      })();
      loader.then((raw) => {
        if (myScan !== scanSeq) return; // a newer scan started — drop stale result
        const ZERO = '0x0000000000000000000000000000000000000000';
        const isHolder = (a) => { const n = byLc[a]; return n && !n.contract; };
        const edgeMap = {};      // "a|b" -> {count, shared}
        const addEdge = (a, b, shared) => {
          if (a === b) return;
          const k = a < b ? a + '|' + b : b + '|' + a;
          const e = edgeMap[k] || (edgeMap[k] = { count: 0, shared: true });
          e.count += 1; if (!shared) e.shared = false;   // any direct hit → solid
        };
        // 1. direct holder↔holder edges + collect shared counterparties
        const cp = {};           // outside wallet -> Set(holder ids it touched)
        raw.forEach(([f, to]) => {
          if (f === ZERO || to === ZERO) return;
          const hf = isHolder(f), ht = isHolder(to);
          if (hf && ht) { addEdge(byLc[f].id, byLc[to].id, false); return; }
          if (hf && !ht) { (cp[to] = cp[to] || new Set()).add(byLc[f].id); }
          else if (ht && !hf) { (cp[f] = cp[f] || new Set()).add(byLc[to].id); }
        });
        // 2. shared-funder links (only if we pulled the wider transfer set)
        if (enhanced) {
          for (const c in cp) {
            const hs = [...cp[c]];
            if (hs.length >= 2 && hs.length <= D) {   // low-degree source = common funder, not a hub
              for (let i = 1; i < hs.length; i++) addEdge(hs[0], hs[i], true);
            }
          }
        }
        const edges = Object.entries(edgeMap).map(([k, v]) => {
          const [source, target] = k.split('|'); return { source, target, count: v.count, shared: v.shared };
        });
        const { colorOf, clusterCount } = clusters(nodes, edges);
        finish(edges, clusterCount, colorOf);
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
  // Bubbles are sized RELATIVE to the biggest holder in the set, so the map has
  // clear hierarchy whether the token is whale-heavy or evenly spread. r is
  // precomputed per node in render(); this just reads it.
  const MIN_R = 7, MAX_R = 48;
  const radius = (n) => n.r || MIN_R;

  // O(n²) collision force (fine for ≤120 nodes) — packs bubbles so they just
  // touch instead of scattering like dust. This is what makes it read as a
  // bubble map and not a starfield.
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
        .nodeLabel((n) => `<div style="font-family:Inter,sans-serif;font-size:12px;padding:2px 2px"><b>${n.short}</b>${n.contract ? ' · contract/LP' : n.whale ? ' · 🐋 whale' : ''}<br><span style="color:#e6b83f">${n.pct.toFixed(2)}%</span> of supply · ${n.balDisp}</div>`)
        .linkColor((l) => l.shared ? 'rgba(230,184,63,.42)' : 'rgba(140,230,90,.6)')
        .linkLineDash((l) => l.shared ? [3, 3] : null)
        .linkWidth((l) => l.shared ? 1 : Math.min(3, 1.2 + l.count * 0.4))
        .linkDirectionalParticles(0)
        .onNodeClick((n) => showInfo(n))
        .onBackgroundClick(() => hideInfo())
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
    Graph.width(W).height(H).graphData({ nodes, links: edges });
    Graph.d3VelocityDecay(0.4);
    // mild charge + collide packing → dense bubble cluster that fills the canvas
    if (Graph.d3Force('charge')) Graph.d3Force('charge').strength((n) => -((n.r || MIN_R) * 1.1 + 6));
    Graph.d3Force('collide', makeCollide(1.5));
    if (Graph.d3Force('link')) Graph.d3Force('link').distance((l) => (l.source.r || MIN_R) + (l.target.r || MIN_R) + 6).strength(0.25);
    Graph.d3ReheatSimulation && Graph.d3ReheatSimulation();
    setTimeout(() => Graph.zoomToFit(500, 40), 500);
    setTimeout(() => Graph.zoomToFit(500, 40), 1500);
  }

  /* ---- click a bubble → info card (no more surprise link navigation) ---- */
  function showInfo(n) {
    const box = $('bubble-info'); if (!box) { window.open(`${BASE}/address/${n.id}`, '_blank'); return; }
    const tag = n.contract ? '<span class="bi-tag ct">Contract / LP</span>'
      : n.whale ? '<span class="bi-tag whale">🐋 Whale</span>'
      : n.cluster ? '<span class="bi-tag cl">Linked cluster</span>'
      : '<span class="bi-tag">Independent</span>';
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
  const infoX = $('bubble-info-x'); if (infoX) infoX.addEventListener('click', hideInfo);
})();
