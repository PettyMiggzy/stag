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

  async function j(url) { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
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

  let busy = false;
  async function scan(caRaw) {
    const ca = (caRaw || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(ca)) { setMsg('That doesn\'t look like a contract address (0x + 40 hex).', true); return; }
    if (busy) return;                 // ignore re-entrant scans (overlay flicker)
    busy = true;
    goBtn.disabled = true; goBtn.textContent = 'Mapping…';
    setMsg('Reading token…'); legend.hidden = true; statsEl.hidden = true;
    try {
      const tok = await j(`${BASE}/api/v2/tokens/${ca}`);
      const dec = Number(tok.decimals || 18);
      const supply = Number(tok.total_supply || 0) || 1;
      setMsg('Loading holders…');
      let holders = await pages(`/api/v2/tokens/${ca}/holders`, MAX_HOLDER_PAGES);
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

      // ---- PHASE 2: load transfers in the background → paint clusters + links ----
      const scanId = ++scanSeq;
      pages(`/api/v2/tokens/${ca}/transfers`, MAX_XFER_PAGES).then((xfers) => {
        if (scanId !== scanSeq) return; // a newer scan started — drop stale result
        const edgeMap = {};
        xfers.forEach((t) => {
          const f = t.from && t.from.hash, to = t.to && t.to.hash;
          if (!f || !to || f === to || !nodeMap[f] || !nodeMap[to]) return;
          const k = f < to ? f + '|' + to : to + '|' + f;
          edgeMap[k] = (edgeMap[k] || 0) + 1;
        });
        const edges = Object.entries(edgeMap).map(([k, count]) => {
          const [source, target] = k.split('|'); return { source, target, count };
        });
        const { colorOf, clusterCount } = clusters(nodes, edges);
        nodes.forEach((n) => { n.color = n.contract ? CONTRACT : (colorOf[n.id] || SOLO); n.cluster = !!colorOf[n.id]; });
        $('s-clusters').textContent = clusterCount;
        if (Graph) { Graph.graphData({ nodes, links: edges }); setTimeout(() => Graph.zoomToFit(600, 55), 600); }
      }).catch(() => { $('s-clusters').textContent = '0'; });
    } catch (e) {
      setMsg('Couldn\'t load that token — check the address is a token on Robinhood Chain. (' + (e.message || 'error') + ')', true);
    } finally {
      busy = false;
      goBtn.disabled = false; goBtn.textContent = 'Map it';
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
  const radius = (n) => Math.max(2.2, Math.sqrt(n.val) * 4.4);

  function render(nodes, edges) {
    const el = $('graph');
    const W = el.clientWidth || 900, H = el.clientHeight || 620;
    // flag the whale (largest holder)
    let maxPct = 0; nodes.forEach((n) => { if (n.pct > maxPct) maxPct = n.pct; });
    nodes.forEach((n) => { n.whale = (n.pct === maxPct); });

    if (!Graph) {
      Graph = ForceGraph()(el)
        .backgroundColor('rgba(6,16,9,0)')
        .nodeLabel((n) => `<div style="font-family:Inter,sans-serif;font-size:12px;padding:2px 2px"><b>${n.short}</b>${n.contract ? ' · contract/LP' : n.whale ? ' · 🐋 whale' : ''}<br><span style="color:#e6b83f">${n.pct.toFixed(2)}%</span> of supply · ${n.balDisp}</div>`)
        .linkColor(() => 'rgba(150,230,90,.16)')
        .linkWidth((l) => Math.min(2.4, 0.4 + l.count * 0.35))
        .linkDirectionalParticles(0)
        .onNodeClick((n) => window.open(`${BASE}/address/${n.id}`, '_blank'))
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
          // % label on big bubbles
          if (n.pct >= 2 && scale > 0.75) {
            ctx.font = `700 ${Math.max(3.5, 10 / scale)}px Inter, sans-serif`;
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
    Graph.d3VelocityDecay(0.3);
    setTimeout(() => Graph.zoomToFit(600, 55), 450);
  }

  // responsive
  window.addEventListener('resize', () => { if (Graph) { const el = $('graph'); Graph.width(el.clientWidth).height(el.clientHeight); } });

  form.addEventListener('submit', (e) => { e.preventDefault(); scan(input.value); });
})();
