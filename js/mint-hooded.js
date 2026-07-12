/* ============================================================
   STAGWIFHOOD — The Hooded 20 mint (two-mode: Pick / Gamble)
   ethers v6 · Robinhood Chain · reads live supply + prices,
   pre-sign guard, no scary wallet warnings.
   ============================================================ */
(function () {
  'use strict';
  const H = window.HOODED || {};
  const CHAIN_ID = BigInt(parseInt((H.chain && H.chain.chainId) || '0x1237', 16)); // 4663
  const TIERS = H.tiers || ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
  const BASE = H.metaBase || 'assets/nft/stagwifhood';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let inFlight = false;
  const grid = document.getElementById('mint-grid');
  const gambleBtn = document.getElementById('gamble-btn');
  const connectBtn = document.getElementById('mint-connect');
  const statusEl = document.getElementById('mint-status');
  const supplyFill = document.getElementById('supply-fill');
  const supplyCount = document.getElementById('supply-count');
  if (!grid) return;

  const ABI = [
    'function mintPick(uint256) payable',
    'function mintRandom() payable',
    'function tierPrice(uint256) view returns (uint256)',
    'function tierWeight(uint256) view returns (uint256)',
    'function randomPrice() view returns (uint256)',
    'function tierOf(uint256) view returns (uint8)',
    'function priceOf(uint256) view returns (uint256)',
    'function isAvailable(uint256) view returns (bool)',
    'function remaining() view returns (uint256)',
    'function minted() view returns (uint256)',
    'function mintActive() view returns (bool)',
  ];

  let provider, signer, me, prices = [], randomPrice = 0n, items = [];
  const ro = () => (H.readProvider ? H.readProvider() : new ethers.JsonRpcProvider(H.chain.rpcUrls[0], { name: H.chain.chainName, chainId: parseInt(H.chain.chainId, 16) }));
  const setStatus = (m, c) => { if (statusEl) { statusEl.textContent = m; statusEl.className = 'mint-status ' + (c || ''); } };
  async function chainOk() { try { return provider && (await provider.getNetwork()).chainId === CHAIN_ID; } catch { return false; } }
  const eth = (w) => { try { return (+ethers.formatEther(w)).toFixed(3); } catch { return '—'; } };

  async function boot() {
    // load collection metadata (names, tiers) for the grid
    try { const r = await fetch(`${BASE}/manifest.json`); items = (await r.json()).items || []; }
    catch { items = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, rarity: '', character: '', rank: 0 })); }

    if (!H.mint || !window.ethers) { renderComingSoon(); return; }
    try {
      const c = new ethers.Contract(H.mint, ABI, ro());
      const [active, mintedN, rem] = await Promise.all([c.mintActive(), c.minted(), c.remaining()]);
      randomPrice = await c.randomPrice();
      for (let t = 0; t < 5; t++) prices[t] = await c.tierPrice(t);
      const avail = {};
      await Promise.all(items.map(async (it) => { avail[it.id] = await c.isAvailable(it.id); }));
      renderGrid(avail);
      renderGamble();
      updateSupply(Number(mintedN));
      if (!active) setStatus('Mint is not open yet — check back shortly.', '');
      if (connectBtn) { connectBtn.disabled = false; connectBtn.onclick = connect; }
    } catch (e) { renderComingSoon(); }
  }

  const tierIdx = (name) => Math.max(0, TIERS.indexOf(name));
  function priceFor(it) { return prices[tierIdx(it.rarity)] || 0n; }

  function renderGrid(avail) {
    grid.innerHTML = '';
    for (const it of items) {
      const t = tierIdx(it.rarity);
      const sold = avail && avail[it.id] === false;
      const card = document.createElement('div');
      card.className = 'hcard t' + t + (sold ? ' sold' : '');
      const id = parseInt(it.id, 10) || 0;
      card.innerHTML = `
        <div class="hcard-media">
          <img src="${BASE}/img/${id}.jpg" alt="${esc(it.character || 'Stag #' + id)}" loading="lazy" />
          <video muted loop playsinline preload="none" poster="${BASE}/img/${id}.jpg"><source src="${BASE}/anim/${id}.mp4" type="video/mp4"></video>
          <span class="hcard-rank">#${esc(it.rank || id)}</span>
          <span class="hcard-tier t${t}">${esc(it.rarity || '')}</span>
          ${sold ? '<span class="hcard-sold">MINTED</span>' : ''}
        </div>
        <div class="hcard-foot">
          <div class="hcard-name">${esc(it.character || 'Hooded #' + id)}</div>
          <button class="btn-mini hcard-btn" data-id="${id}" ${sold ? 'disabled' : ''}>${sold ? 'Gone' : 'Pick · ' + eth(priceFor(it)) + ' Ξ'}</button>
        </div>`;
      const v = card.querySelector('video');
      card.querySelector('.hcard-media').addEventListener('mouseenter', () => { v.play().catch(() => {}); });
      card.querySelector('.hcard-media').addEventListener('mouseleave', () => { v.pause(); });
      const btn = card.querySelector('.hcard-btn');
      if (!sold) btn.onclick = () => mintPick(it);
      grid.appendChild(card);
    }
  }

  function renderGamble() {
    if (!gambleBtn) return;
    gambleBtn.textContent = `🎲 Surprise Draw · ${eth(randomPrice)} Ξ`;
    gambleBtn.disabled = false;
    gambleBtn.onclick = mintGamble;
    // odds (weights * tier counts)
    const counts = [0, 0, 0, 0, 0];
    items.forEach((it) => counts[tierIdx(it.rarity)]++);
    const oddsEl = document.getElementById('gamble-odds');
    if (oddsEl && H.mint) {
      const c = new ethers.Contract(H.mint, ABI, ro());
      Promise.all([0, 1, 2, 3, 4].map((t) => c.tierWeight(t))).then((ws) => {
        const tot = ws.reduce((s, w, t) => s + Number(w) * counts[t], 0);
        oddsEl.innerHTML = TIERS.map((n, t) => {
          const p = tot ? (Number(ws[t]) * counts[t] / tot * 100).toFixed(1) : '0';
          return `<span class="odd t${t}">${n} <b>${p}%</b></span>`;
        }).join('');
      }).catch(() => {});
    }
  }

  function renderComingSoon() {
    grid.innerHTML = items.map((it) => {
      const t = tierIdx(it.rarity);
      const id = parseInt(it.id, 10) || 0;
      return `<div class="hcard t${t}"><div class="hcard-media"><img src="${BASE}/img/${id}.jpg" loading="lazy"/><span class="hcard-tier t${t}">${esc(it.rarity || '')}</span></div><div class="hcard-foot"><div class="hcard-name">${esc(it.character || 'Hooded #' + id)}</div></div></div>`;
    }).join('');
    if (gambleBtn) { gambleBtn.textContent = 'Mint — Coming Soon'; gambleBtn.disabled = true; }
    if (connectBtn) connectBtn.style.display = 'none';
    setStatus('Wallet mint goes live at launch. Provably-fair draw · no duplicates.', '');
  }

  function updateSupply(minted) {
    if (supplyFill) supplyFill.style.width = (minted / 20 * 100) + '%';
    if (supplyCount) supplyCount.textContent = `${minted} / 20 minted`;
  }

  /* ---------- wallet ---------- */
  async function connect() {
    if (!window.ethereum) { setStatus('No EVM wallet found — install MetaMask.', 'err'); return; }
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: H.chain.chainId }] }); }
      catch (e) { if (e.code === 4902) await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [H.chain] }); }
      provider = new ethers.BrowserProvider(window.ethereum);
      if (!(await chainOk())) { signer = null; setStatus('Wrong network — switch to Robinhood Chain (4663) and reconnect.', 'err'); return; }
      signer = await provider.getSigner();
      me = await signer.getAddress();
      connectBtn.textContent = me.slice(0, 6) + '…' + me.slice(-4);
      setStatus('Wallet connected — pick a stag or take the draw.', 'ok');
      if (window.ethereum.removeAllListeners) window.ethereum.removeAllListeners('chainChanged');
      window.ethereum.on && window.ethereum.on('chainChanged', () => { signer = null; provider = null; if (connectBtn) connectBtn.textContent = 'Connect Wallet'; setStatus('Network changed — reconnect on Robinhood Chain.', 'err'); });
    } catch (e) { setStatus(pretty(e), 'err'); }
  }

  function pretty(e) {
    const m = (e && (e.shortMessage || e.reason || e.info?.error?.message || e.message)) || 'error';
    if (/user rejected|denied|4001/i.test(m)) return 'Cancelled in wallet.';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH for the mint + gas.';
    if (/sold out|unavailable/i.test(m)) return 'That one just got minted — pick another.';
    if (/wallet limit/i.test(m)) return 'You have hit the per-wallet limit.';
    if (/not active/i.test(m)) return 'Mint is not open yet.';
    return String(m).slice(0, 160);
  }

  async function ensure() {
    if (!signer) { await connect(); }
    return !!signer;
  }

  async function mintPick(it) {
    if (inFlight) return;
    if (!(await ensure())) return;
    if (!(await chainOk())) return setStatus('Wrong network — switch to Robinhood Chain (4663).', 'err');
    const c = new ethers.Contract(H.mint, ABI, signer);
    const id = parseInt(it.id, 10);
    const value = await c.priceOf(id); // authoritative on-chain price for THIS token
    inFlight = true;
    try {
      await c.mintPick.estimateGas(id, { value });
      setStatus(`Confirm in wallet — minting ${it.character || '#' + id}…`);
      const tx = await c.mintPick(id, { value });
      setStatus('Minting… waiting for confirmation');
      await tx.wait();
      setStatus(`🦌 Minted ${it.character || '#' + id}! Welcome to The Hooded 20.`, 'ok');
      boot();
    } catch (e) { setStatus(pretty(e), 'err'); }
    finally { inFlight = false; }
  }

  async function mintGamble() {
    if (inFlight) return;
    if (!(await ensure())) return;
    if (!(await chainOk())) return setStatus('Wrong network — switch to Robinhood Chain (4663).', 'err');
    const c = new ethers.Contract(H.mint, ABI, signer);
    const value = await c.randomPrice(); // authoritative on-chain price
    inFlight = true;
    try {
      await c.mintRandom.estimateGas({ value });
      setStatus('Confirm in wallet — drawing a random stag…');
      const tx = await c.mintRandom({ value });
      setStatus('Drawing… waiting for confirmation');
      await tx.wait();
      setStatus('🎲 The forest chose your stag! Check your wallet.', 'ok');
      boot();
    } catch (e) { setStatus(pretty(e), 'err'); }
    finally { inFlight = false; }
  }

  boot();
})();
