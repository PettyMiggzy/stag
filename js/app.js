/* ============================================================
   STAGWIFHOOD — Unified App Hub (Mint · Stake · Pact)
   One shared wallet, three tabs, all live on-chain reads.
   Robinhood Chain 4663 · ethers v6.
   ============================================================ */
(function () {
  'use strict';
  const H = window.HOODED || {};
  const CHAIN_ID = BigInt(parseInt((H.chain && H.chain.chainId) || '0x1237', 16));
  const TIERS = H.tiers || ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
  const BASE = H.metaBase || 'assets/nft/stagwifhood';
  const STAG = H.stag;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NFT_ABI = [
    'function mintPick(uint256) payable', 'function mintRandom() payable',
    'function tierPrice(uint256) view returns (uint256)', 'function tierWeight(uint256) view returns (uint256)',
    'function randomPrice() view returns (uint256)', 'function priceOf(uint256) view returns (uint256)',
    'function isAvailable(uint256) view returns (bool)', 'function remaining() view returns (uint256)',
    'function minted() view returns (uint256)', 'function mintActive() view returns (bool)',
    'function balanceOf(address) view returns (uint256)', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
    'function tierOf(uint256) view returns (uint8)', 'function locked(uint256) view returns (bool)',
    'function freeMints(address) view returns (uint256)',
  ];
  const STK_ABI = [
    'function stakeTokens(address,uint256,uint8)', 'function unstakeTokens(address,uint256)',
    'function claim()', 'function donate() payable', 'function setWithdrawSplit(address[],uint256[])',
    'function stakeNFT(uint256)', 'function unstakeNFT(uint256)',
    'function stakedOf(address,address) view returns (uint256)', 'function earned(address) view returns (uint256)',
    'function nftStaker(uint256) view returns (address)',
    'function withdrawSplitOf(address) view returns (address[],uint256[])',
    'function tierInfo() view returns (uint256[3],uint256[3])',
    'function userInfo(address) view returns (uint256 baseWeight,uint256 lockMultBps,uint256 holdMult,uint256 weight,uint256 stakedAt,uint8 lockTier,uint256 unlockAt,uint256 pendingEth,uint256[] nfts,bool locked)',
  ];
  const PACT_ABI = [
    'function createPact(uint256,uint64) payable returns (uint256)', 'function claim(uint256)', 'function reclaim(uint256)',
    'function entryFee() view returns (uint256)', 'function refundAmount() view returns (uint256)',
    'function grace() view returns (uint64)', 'function minDuration() view returns (uint64)', 'function maxDuration() view returns (uint64)',
    'function pactsOfCount(address) view returns (uint256)', 'function pactsOf(address,uint256) view returns (uint256)',
    'function pacts(uint256) view returns (address wallet,uint256 minHold,uint64 start,uint64 duration,uint256 entryPaid,uint256 payout,uint8 status,uint64 reclaimGrace)',
  ];
  const ERC20 = [
    'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ];

  // ---------------- shared state ----------------
  let provider = null, signer = null, me = null;
  let items = [];
  let tier = 0, durations = [30, 60, 90], mults = [10000, 15000, 20000];
  let active = 'mint';
  // stakeable tokens (default $STAG). The withdraw-split applies to whichever token is unstaked.
  const TOKENS = (H.stakeTokens && H.stakeTokens.length) ? H.stakeTokens
    : [{ address: STAG, symbol: 'STAG', decimals: 18 }];
  let curTok = TOKENS[0];
  const tdec = (t) => (t && t.decimals != null ? t.decimals : 18);
  const parseTok = (amtStr, t) => ethers.parseUnits(String(amtStr), tdec(t));
  const numTok = (raw, t) => { try { return Number(ethers.formatUnits(raw, tdec(t))).toLocaleString(undefined, { maximumFractionDigits: 0 }); } catch { return '—'; } };
  const fmtTokFull = (raw, t) => { try { return ethers.formatUnits(raw, tdec(t)); } catch { return '0'; } };

  const ro = () => (H.readProvider ? H.readProvider() : new ethers.JsonRpcProvider(H.chain.rpcUrls[0], { name: H.chain.chainName, chainId: parseInt(H.chain.chainId, 16) }));
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const eth = (v, d = 3) => { try { return (+ethers.formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: d }); } catch { return '—'; } };
  // Pending ETH rewards are small per-staker — show enough precision so a real balance never reads as a flat "0".
  const ethSmall = (v) => { try { const n = +ethers.formatEther(v); if (n === 0) return '0'; if (n < 0.000001) return '<0.000001'; return n.toLocaleString(undefined, { maximumFractionDigits: 6 }); } catch { return '—'; } };
  const num = (v) => { try { return Number(ethers.formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 0 }); } catch { return '—'; } };
  const days = (s) => Math.round(Number(s) / 86400);
  const tierIdx = (name) => Math.max(0, TIERS.indexOf(name));
  async function chainOk() { try { return provider && (await provider.getNetwork()).chainId === CHAIN_ID; } catch { return false; } }

  function setStatus(el, m, c) { const e = $(el); if (e) { e.textContent = m; e.className = 'status ' + (c || ''); } }
  function pretty(e) {
    const m = (e && (e.shortMessage || e.reason || e.info?.error?.message || e.message)) || 'error';
    if (/user rejected|denied|4001/i.test(m)) return 'Cancelled in wallet.';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH for this + gas.';
    if (/locked/i.test(m)) return 'Still locked — wait for the lock to end (early unstake = 15% + forfeit).';
    if (/already have an open pact/i.test(m)) return 'You already have an open pact — resolve it first.';
    if (/entry fee too low/i.test(m)) return 'Entry fee changed — refresh and retry.';
    if (/wallet limit|per-wallet/i.test(m)) return 'You have hit the per-wallet mint limit.';
    if (/not active/i.test(m)) return 'Not open yet.';
    if (/sold out|unavailable|not available/i.test(m)) return 'That one just got taken — pick another.';
    return String(m).slice(0, 170);
  }

  // ---------------- wallet ----------------
  let wcProvider = null; // active WalletConnect (Reown) session, if any

  // Resolve an EIP-1193 provider: prefer an injected wallet (extension / wallet in-app browser);
  // otherwise fall back to WalletConnect so ANY mobile wallet can connect (Trust, Rainbow, …).
  async function getEip1193(silent) {
    if (window.ethereum) return window.ethereum;
    if (silent) return null; // never pop a modal on a silent reconnect
    const pid = H.walletConnectProjectId;
    if (pid) {
      try {
        flashConnect('Opening wallet… pick SafePal (or your wallet) in the popup.'); // never fail silently on mobile
        const { EthereumProvider } = await import('https://esm.sh/@walletconnect/ethereum-provider@2.17.2');
        const cid = parseInt(H.chain.chainId, 16);
        // Robinhood Chain (4663) is a CUSTOM chain almost no wallet pre-knows. It MUST be optional —
        // if it's a *required* chain, WalletConnect rejects the whole session ("unsupported chains")
        // and the connect fails. So: connect on whatever the wallet has, then add/switch to 4663 after.
        wcProvider = await EthereumProvider.init({
          projectId: pid,
          optionalChains: [cid],
          rpcMap: { [cid]: H.chain.rpcUrls[0] },
          showQrModal: true,
          metadata: {
            name: 'STAGWIFHOOD', description: 'The Hooded 20 — mint, stake & pact on Robinhood Chain',
            url: 'https://stagwifhood.fun', icons: ['https://stagwifhood.fun/assets/img/mark.png'],
          },
        });
        wcProvider.on('disconnect', () => { try { localStorage.removeItem('h20_wc'); } catch {} location.reload(); });
        await wcProvider.enable(); // opens the WalletConnect modal / deep-links the wallet
        return wcProvider;
      } catch (e) {
        // WC couldn't open — give a path that always works: the wallet's own in-app browser.
        flashConnect('Couldn’t open WalletConnect. Easiest fix: open stagwifhood.fun inside your wallet’s browser — SafePal → Browser (or MetaMask/Trust) — then Connect & mint work directly.');
        return null;
      }
    }
    // no WalletConnect configured — last-resort MetaMask deep link on mobile
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
      flashConnect('Opening in your wallet app…');
      window.location.href = 'https://metamask.app.link/dapp/' + location.host + location.pathname + location.search;
      return null;
    }
    flashConnect('Tap Connect again and pick your wallet (SafePal, MetaMask, Trust) in the popup — or open this page inside your wallet’s browser.');
    return null;
  }

  async function connect(silent) {
    const eth = await getEip1193(silent);
    if (!eth) return;
    try {
      // silent = reuse an existing authorization (no popup); bail if not already authorized
      const accs = await eth.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
      if (silent && (!accs || !accs.length)) return;
      // Add + switch to Robinhood Chain. Wallets vary: some return 4902 for an unknown chain,
      // others a generic error — so on ANY switch failure, add the chain then switch again.
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: H.chain.chainId }] }); }
      catch (e) {
        try {
          await eth.request({ method: 'wallet_addEthereumChain', params: [H.chain] });
          await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: H.chain.chainId }] });
        } catch {}
      }
      provider = new ethers.BrowserProvider(eth);
      if (!(await chainOk())) { signer = null; me = null; setNet('bad', 'Wrong network — switch to Robinhood Chain'); return; }
      signer = await provider.getSigner(); me = await signer.getAddress();
      if (eth.removeAllListeners) eth.removeAllListeners('chainChanged');
      eth.on && eth.on('chainChanged', () => { signer = null; provider = null; me = null; setNet('off', 'Reconnect on Robinhood Chain'); $('w-connect').textContent = 'Connect Wallet'; });
      eth.on && eth.on('accountsChanged', () => location.reload());
      $('w-connect').textContent = short(me);
      const dc = $('w-disconnect'); if (dc) dc.hidden = false;
      try { localStorage.setItem('h20_wc', '1'); } catch {} // remember across visits
      setNet('ok', 'Robinhood Chain');
      await refreshWallet();
      loadTab(active, true);
    } catch (e) { if (!silent) flashConnect(pretty(e)); }
  }
  function disconnect() {
    signer = null; me = null; provider = null;
    if (wcProvider) { try { wcProvider.disconnect(); } catch {} wcProvider = null; }
    try { localStorage.removeItem('h20_wc'); } catch {}
    $('w-connect').textContent = 'Connect Wallet';
    const dc = $('w-disconnect'); if (dc) dc.hidden = true;
    const bals = $('w-bals'); if (bals) bals.hidden = true;
    setNet('off', 'Not connected');
    loadTab(active, false); // drop back to read-only view
  }
  function flashConnect(msg) { setStatus(active === 'mint' ? 'm-status' : active === 'stake' ? 's-status' : 'pc-status', msg, 'err'); }
  // One-tap "Add Robinhood Chain" — the #1 mobile snag: the network must be added before anything works.
  async function addChainToWallet() {
    const eth = window.ethereum || wcProvider;
    if (!eth || !eth.request) {
      flashConnect('Add it manually → Network name: Robinhood Chain · New RPC URL: ' + H.chain.rpcUrls[0]
        + ' · Chain ID: ' + parseInt(H.chain.chainId, 16) + ' · Symbol: ETH · Explorer: ' + H.chain.blockExplorerUrls[0]);
      return;
    }
    try {
      await eth.request({ method: 'wallet_addEthereumChain', params: [H.chain] });
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: H.chain.chainId }] }).catch(() => {});
      flashConnect('Robinhood Chain added ✓ — now tap Connect Wallet.');
    } catch (e) { flashConnect('Add cancelled. Approve the “Add network” popup, or add it manually (RPC ' + H.chain.rpcUrls[0] + ', Chain ID 4663).'); }
  }
  function setNet(state, txt) {
    const n = $('w-net'); if (n) n.className = 'wbar-net ' + state;
    const t = $('w-net-txt'); if (t) t.textContent = txt;
  }
  async function refreshWallet() {
    const bals = $('w-bals'); if (!me) { if (bals) bals.hidden = true; return; }
    try {
      const p = provider || ro();
      const [e, s] = await Promise.all([p.getBalance(me), new ethers.Contract(STAG, ERC20, p).balanceOf(me)]);
      $('w-eth').textContent = eth(e, 4); $('w-stag').textContent = num(s);
      if (bals) bals.hidden = false;
    } catch {}
  }

  // generic write helper: run tx, confirm, refresh
  async function tx(run, okMsg, statusEl, after) {
    if (!signer) return connect();
    if (!(await chainOk())) return setStatus(statusEl, 'Wrong network — switch to Robinhood Chain (4663).', 'err');
    try {
      setStatus(statusEl, 'Confirm in your wallet…');
      const t = await run();
      setStatus(statusEl, 'Submitting… waiting for confirmation');
      await t.wait();
      setStatus(statusEl, okMsg, 'ok');
      await refreshWallet(); if (after) await after();
    } catch (e) { setStatus(statusEl, pretty(e), 'err'); }
  }

  // ---------------- tabs ----------------
  function loadTab(name, withUser) {
    if (name === 'mint') Mint.load(withUser);
    else if (name === 'stake') Stake.load(withUser);
    else if (name === 'pact') Pact.load(withUser);
  }
  function showTab(name) {
    active = name;
    document.querySelectorAll('.app-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    ['mint', 'stake', 'pact'].forEach((n) => { const p = $('panel-' + n); if (p) p.hidden = n !== name; });
    if (history.replaceState) history.replaceState(null, '', '#' + name);
    loadTab(name, !!me);
  }

  /* ================= MINT ================= */
  const Mint = {
    prices: [], randomPrice: 0n, inFlight: false,
    async load(withUser) {
      if (!items.length) {
        try { const r = await fetch(`${BASE}/manifest.json`); items = (await r.json()).items || []; }
        catch { items = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, rarity: '', character: '', rank: 0 })); }
      }
      if (!H.mint) { this.comingSoon(); return; }   // only "coming soon" if the contract truly isn't set
      // The contract IS deployed — so minting must stay available even if a read hiccups on a flaky
      // mobile connection. Every read below is best-effort; the real price is fetched again at mint time.
      const c = new ethers.Contract(H.mint, NFT_ABI, ro());
      let mintedN = 0, avail = {};
      try { mintedN = Number(await c.minted()); } catch (e) {}
      try { this.randomPrice = await c.randomPrice(); } catch (e) {}
      try { this.prices = await Promise.all([0, 1, 2, 3, 4].map((t) => c.tierPrice(t))); } catch (e) {}
      try { await Promise.all(items.map(async (it) => { avail[it.id] = await c.isAvailable(it.id); })); } catch (e) { avail = {}; }
      this.renderGrid(avail); this.renderModes(c);
      this.supply(mintedN);
      setStatus('m-status', me ? '' : 'Connect your wallet to mint.', '');
      if (withUser && me) this.loadOwned(c);
    },
    supply(m) { const f = $('m-fill'); if (f) f.style.width = (m / 20 * 100) + '%'; const c = $('m-count'); if (c) c.textContent = `${m} / 20 minted`; },
    priceFor(it) { return this.prices[tierIdx(it.rarity)] || 0n; },
    renderModes(c) {
      const cheapest = this.prices.length ? this.prices.reduce((a, b) => (a < b ? a : b)) : 0n;
      $('m-pick-price').textContent = cheapest > 0n ? 'from ' + eth(cheapest) + ' Ξ' : 'live';
      $('m-gamble-price').textContent = this.randomPrice > 0n ? eth(this.randomPrice) + ' Ξ' : 'live';
      const gb = $('m-gamble'); if (gb) { gb.disabled = false; gb.onclick = () => this.mintGamble(); }
      const counts = [0, 0, 0, 0, 0]; items.forEach((it) => counts[tierIdx(it.rarity)]++);
      Promise.all([0, 1, 2, 3, 4].map((t) => c.tierWeight(t))).then((ws) => {
        const tot = ws.reduce((s, w, t) => s + Number(w) * counts[t], 0);
        const el = $('m-odds'); if (!el) return;
        el.innerHTML = TIERS.map((n, t) => { const p = tot ? (Number(ws[t]) * counts[t] / tot * 100).toFixed(1) : '0'; return `<span class="o t${t}">${esc(n)} <b>${p}%</b></span>`; }).join('');
      }).catch(() => {});
    },
    card(it, opts) {
      const t = tierIdx(it.rarity); const id = parseInt(it.id, 10) || 0;
      const total = items.length || 20; const rank = parseInt(it.rank, 10) || 0;
      // Corner badge is the TOKEN NUMBER (#id) — the NFT's on-chain identity. The rarity
      // rank is a separate, clearly-labelled chip so a top-ranked piece (e.g. #20 = rank 1)
      // can't be mistaken for token #1.
      const rankChip = rank ? `<span class="hcard-rankflex${rank === 1 ? ' top' : ''}">${rank === 1 ? '★ ' : ''}Rank ${rank}/${total}</span>` : '';
      const badge = opts.badge ? `<span class="hcard-badge ${opts.badge.cls}">${esc(opts.badge.txt)}</span>` : '';
      const btn = opts.btn ? `<button class="hcard-btn" ${opts.btn.dis ? 'disabled' : ''}>${esc(opts.btn.txt)}</button>` : '';
      const el = document.createElement('div');
      el.className = 'hcard t' + t + (opts.sold ? ' sold' : '');
      el.innerHTML = `
        <div class="hcard-media">
          <img src="${BASE}/img/${id}.jpg" alt="${esc(it.character || 'Stag #' + id)}" loading="lazy" />
          <video muted loop playsinline preload="none" poster="${BASE}/img/${id}.jpg"><source src="${BASE}/anim/${id}.mp4" type="video/mp4"></video>
          <span class="hcard-rank">#${id}</span>
          <span class="hcard-tier t${t}">${esc(it.rarity || '')}</span>${rankChip}${badge}
        </div>
        <div class="hcard-foot"><div class="hcard-name">${esc(it.character || 'Hooded #' + id)}</div>${btn}</div>`;
      const v = el.querySelector('video'), med = el.querySelector('.hcard-media');
      med.addEventListener('mouseenter', () => { v.play().catch(() => {}); });
      med.addEventListener('mouseleave', () => { v.pause(); });
      const b = el.querySelector('.hcard-btn'); if (b && opts.btn && opts.btn.on && !opts.btn.dis) b.onclick = opts.btn.on;
      return el;
    },
    renderGrid(avail) {
      const g = $('m-grid'); if (!g) return; g.innerHTML = '';
      for (const it of items) {
        const sold = avail && avail[it.id] === false;
        g.appendChild(this.card(it, {
          sold, badge: sold ? { cls: 'minted', txt: 'MINTED' } : null,
          btn: { txt: sold ? 'Gone' : (this.priceFor(it) > 0n ? 'Pick · ' + eth(this.priceFor(it)) + ' Ξ' : 'Pick'), dis: sold, on: () => this.mintPick(it) },
        }));
      }
    },
    async loadOwned(c) {
      try {
        const bal = Number(await c.balanceOf(me));
        const wrap = $('m-owned-card'), grid = $('m-owned'); if (!grid) return;
        if (bal === 0) { wrap.hidden = true; return; }
        const ids = [];
        for (let i = 0; i < bal; i++) ids.push(Number(await c.tokenOfOwnerByIndex(me, i)));
        // which are locked (staked)?
        const locks = {}; await Promise.all(ids.map(async (id) => { locks[id] = await c.locked(id); }));
        grid.innerHTML = '';
        for (const id of ids) {
          const it = items.find((x) => parseInt(x.id, 10) === id) || { id, rarity: '', character: 'Hooded #' + id, rank: id };
          const staked = locks[id];
          grid.appendChild(this.card(it, {
            badge: staked ? { cls: 'staked', txt: 'STAKED' } : { cls: 'owned', txt: 'OWNED' },
            btn: staked ? { txt: 'Staked', dis: true } : { txt: 'Stake NFT', on: () => Stake.stakeNFT(id) },
          }));
        }
        wrap.hidden = false;
      } catch {}
    },
    comingSoon() {
      const g = $('m-grid'); if (g) g.innerHTML = items.map((it) => { const t = tierIdx(it.rarity); const id = parseInt(it.id, 10) || 0; return `<div class="hcard t${t}"><div class="hcard-media"><img src="${BASE}/img/${id}.jpg" loading="lazy"/><span class="hcard-tier t${t}">${esc(it.rarity || '')}</span></div><div class="hcard-foot"><div class="hcard-name">${esc(it.character || 'Hooded #' + id)}</div></div></div>`; }).join('');
      const gb = $('m-gamble'); if (gb) { gb.textContent = 'Coming Soon'; gb.disabled = true; }
      setStatus('m-status', 'Mint goes live at launch. Provably-fair draw · no duplicates.', '');
    },
    async mintPick(it) {
      if (this.inFlight) return; if (!signer) return connect();
      if (!(await chainOk())) return setStatus('m-status', 'Wrong network — switch to Robinhood Chain (4663).', 'err');
      const c = new ethers.Contract(H.mint, NFT_ABI, signer); const id = parseInt(it.id, 10);
      this.inFlight = true;
      try {
        // free-mint wallets must send exactly 0 (contract requires msg.value == due, due=0 when free)
        const free = await c.freeMints(me);
        const value = free > 0n ? 0n : await c.priceOf(id);
        await c.mintPick.estimateGas(id, { value });
        await tx(() => c.mintPick(id, { value }), `Minted ${it.character || '#' + id}! Welcome to The Hooded 20.`, 'm-status', () => this.load(true));
      } catch (e) { setStatus('m-status', pretty(e), 'err'); } finally { this.inFlight = false; }
    },
    async mintGamble() {
      if (this.inFlight) return; if (!signer) return connect();
      if (!(await chainOk())) return setStatus('m-status', 'Wrong network — switch to Robinhood Chain (4663).', 'err');
      const c = new ethers.Contract(H.mint, NFT_ABI, signer);
      this.inFlight = true;
      try {
        // free-mint wallets pay exactly 0 (contract: msg.value == due, due=0 when free)
        const free = await c.freeMints(me);
        const value = free > 0n ? 0n : await c.randomPrice();
        await c.mintRandom.estimateGas({ value });
        await tx(() => c.mintRandom({ value }), 'The forest chose your stag! Check your wallet.', 'm-status', () => this.load(true));
      } catch (e) { setStatus('m-status', pretty(e), 'err'); } finally { this.inFlight = false; }
    },
  };

  /* ================= STAKE ================= */
  const Stake = {
    booted: false,
    async load(withUser) {
      if (!H.staking) { setStatus('s-status', 'Staking goes live at launch.', ''); return; }
      const p = provider || ro();
      try {
        const c = new ethers.Contract(H.staking, STK_ABI, p);
        if (!this.booted) {
          const ti = await c.tierInfo(); durations = ti[0].map(days); mults = ti[1].map(Number); this.renderTiers(); this.renderTokens(); this.booted = true;
        }
        this.setTokLabels();
        // global stats (per selected token)
        try { $('s-pool').textContent = eth(await p.getBalance(H.staking)) + ' Ξ'; } catch {}
        try { $('s-total').textContent = numTok(await new ethers.Contract(curTok.address, ERC20, p).balanceOf(H.staking), curTok) + ' ' + curTok.symbol; } catch {}
        // total Hooded 20 NFTs currently staked — scan the 20 token ids (nftStaker != 0 => staked)
        try {
          const el = $('s-nftstaked');
          if (el) {
            const owners = await Promise.all(Array.from({ length: 20 }, (_, i) => c.nftStaker(i + 1).catch(() => ethers.ZeroAddress)));
            const n = owners.filter((a) => a && a !== ethers.ZeroAddress).length;
            el.textContent = n + ' / 20';
          }
        } catch {}
        if (withUser && me) await this.loadUser(c, p);
      } catch (e) { setStatus('s-status', 'Could not reach the staking contract yet.', ''); }
    },
    renderTokens() {
      const row = $('s-token-row'), sel = $('s-token'); if (!sel) return;
      if (TOKENS.length <= 1) { if (row) row.hidden = true; return; }
      if (row) row.hidden = false;
      sel.innerHTML = TOKENS.map((t, i) => `<option value="${i}">${esc(t.symbol)}</option>`).join('');
      sel.value = String(TOKENS.indexOf(curTok));
      sel.onchange = () => { curTok = TOKENS[+sel.value] || TOKENS[0]; this.setTokLabels(); this.load(!!me); };
    },
    setTokLabels() {
      const sym = '$' + curTok.symbol;
      const h = $('s-token-h'); if (h) h.textContent = sym;
      const at = $('s-amount-tok'); if (at) at.textContent = sym;
    },
    renderTiers() {
      const w = $('s-tiers'); if (!w) return;
      w.innerHTML = durations.map((d, i) => `<button class="tier${i === tier ? ' active' : ''}" data-t="${i}"><b>${d}d</b><span>${(mults[i] / 10000).toFixed(mults[i] % 10000 ? 1 : 0)}× rewards</span></button>`).join('');
      w.querySelectorAll('.tier').forEach((b) => b.onclick = () => { tier = +b.dataset.t; this.renderTiers(); this.preview(); });
      this.preview();
    },
    preview() { const h = $('s-preview'); if (h) h.textContent = `${durations[tier]}-day lock · ${(mults[tier] / 10000)}× reward multiplier.`; },
    async loadUser(c, p) {
      p = p || provider || ro();
      c = c || new ethers.Contract(H.staking, STK_ABI, p);
      try {
        const [info, staked, bal] = await Promise.all([c.userInfo(me), c.stakedOf(me, curTok.address), new ethers.Contract(curTok.address, ERC20, p).balanceOf(me)]);
        const stakedN = numTok(staked, curTok);
        $('s-your').textContent = stakedN + ' ' + curTok.symbol; $('p-staked').textContent = stakedN;
        $('s-claim').textContent = ethSmall(info.pendingEth) + ' Ξ'; $('p-claim').textContent = ethSmall(info.pendingEth) + ' Ξ';
        const mult = (Number(info.lockMultBps) / 10000) * (Number(info.holdMult) / 10000);
        const mtxt = mult ? (mult.toFixed(2).replace(/\.00$/, '') + '×') : '1×';
        $('p-mult').textContent = mtxt;
        $('p-tier').textContent = Number(staked) > 0 ? durations[Number(info.lockTier)] + 'd' : '—';
        $('s-bal').textContent = 'Balance: ' + numTok(bal, curTok) + ' $' + curTok.symbol;
        const claimBtn = $('s-claimbtn');
        if (Number(staked) > 0) {
          const unlock = new Date(Number(info.unlockAt) * 1000);
          if (info.locked) {
            const left = Math.max(1, Math.ceil((Number(info.unlockAt) - Date.now() / 1000) / 86400));
            const msg = `Rewards accrue now but unlock in ${left} day${left === 1 ? '' : 's'} — claimable ${unlock.toLocaleDateString()}.`;
            $('s-lock').textContent = msg; $('s-lock').className = 'lockbar';
            $('p-lock').textContent = `Locked until ${unlock.toLocaleDateString()} · early unstake = 15% + forfeit`; $('p-lock').className = 'lockbar';
            if (claimBtn) claimBtn.disabled = true;
          } else {
            $('s-lock').textContent = 'Unlocked — claim your ETH or unstake anytime.'; $('s-lock').className = 'lockbar unlocked';
            $('p-lock').textContent = 'Unlocked'; $('p-lock').className = 'lockbar unlocked';
            if (claimBtn) claimBtn.disabled = false;
          }
        } else { $('s-lock').textContent = ''; $('p-lock').textContent = ''; if (claimBtn) claimBtn.disabled = false; }
        // pre-fill the "Withdraw Wallets" fields with the split this wallet already has saved
        try {
          const [ws, bp] = await c.withdrawSplitOf(me);
          for (let i = 1; i <= 3; i++) {
            const a = $('col-a' + i), b = $('col-b' + i); if (!a || !b) continue;
            if (ws[i - 1]) { a.value = ws[i - 1]; b.value = (Number(bp[i - 1]) / 100).toString(); }
            else { a.value = ''; b.value = ''; }
          }
        } catch (e) {}
        this.renderStakedNfts(info.nfts);
        this.loadMyNfts();
      } catch (e) {}
    },
    // Show every Hooded 20 the wallet owns with a Stake/Unstake button (lock-in-place).
    async loadMyNfts() {
      const card = $('s-mynfts-card'), grid = $('s-mynfts'), empty = $('s-mynfts-empty');
      if (!grid) return;
      if (!me || !H.mint) { if (card) card.hidden = true; if (empty) empty.hidden = false; return; }
      try {
        if (!items.length) { try { const r = await fetch(`${BASE}/manifest.json`); items = (await r.json()).items || []; } catch {} }
        const c = new ethers.Contract(H.mint, NFT_ABI, ro());
        const bal = Number(await c.balanceOf(me));
        if (bal === 0) { if (card) card.hidden = true; if (empty) { empty.hidden = false; empty.innerHTML = "You don't own any Hooded 20 yet. <a href=\"/nfts\" style=\"color:var(--gold-lite)\">Mint one →</a> to stake it in place."; } return; }
        const ids = [];
        for (let i = 0; i < bal; i++) ids.push(Number(await c.tokenOfOwnerByIndex(me, i)));
        const locks = {}; await Promise.all(ids.map(async (id) => { locks[id] = await c.locked(id); }));
        grid.innerHTML = '';
        for (const id of ids) {
          const it = items.find((x) => parseInt(x.id, 10) === id) || { id, rarity: '', character: 'Hooded #' + id, rank: id };
          const staked = locks[id];
          grid.appendChild(Mint.card(it, {
            badge: staked ? { cls: 'staked', txt: 'STAKED' } : { cls: 'owned', txt: 'OWNED' },
            btn: staked ? { txt: 'Unstake', on: () => this.unstakeNFT(id) } : { txt: 'Stake NFT', on: () => this.stakeNFT(id) },
          }));
        }
        if (empty) empty.hidden = true; if (card) card.hidden = false;
      } catch (e) { if (card) card.hidden = true; }
    },
    renderStakedNfts(nfts) {
      const wrap = $('s-nfts-wrap'), grid = $('p-nfts'); if (!grid) return;
      if (!nfts || nfts.length === 0) { wrap.hidden = true; return; }
      grid.innerHTML = '';
      nfts.forEach((idB) => {
        const id = Number(idB); const it = items.find((x) => parseInt(x.id, 10) === id) || { id, rarity: '', character: 'Hooded #' + id, rank: id };
        grid.appendChild(Mint.card(it, { badge: { cls: 'staked', txt: 'STAKED' }, btn: { txt: 'Unstake', on: () => this.unstakeNFT(id) } }));
      });
      wrap.hidden = false;
    },
    async stake() {
      const s = ($('s-amount').value || '').trim(); if (!s || +s <= 0) return setStatus('s-status', 'Enter an amount to stake.', 'err');
      if (!signer) return connect();
      const amount = parseTok(s, curTok);
      const erc = new ethers.Contract(curTok.address, ERC20, signer);
      try {
        if ((await erc.allowance(me, H.staking)) < amount) {
          setStatus('s-status', `Approve $${curTok.symbol} spending…`);
          await (await erc.approve(H.staking, amount)).wait();
        }
      } catch (e) { return setStatus('s-status', pretty(e), 'err'); }
      const c = new ethers.Contract(H.staking, STK_ABI, signer);
      await tx(() => c.stakeTokens(curTok.address, amount, tier), `Staked ${s} $${curTok.symbol} for ${durations[tier]} days ✓`, 's-status', () => this.load(true));
    },
    async unstake() {
      if (!signer) return connect();
      const staked = await new ethers.Contract(H.staking, STK_ABI, provider || ro()).stakedOf(me, curTok.address);
      if (staked === 0n) return setStatus('s-status', `Nothing staked in $${curTok.symbol}.`, 'err');
      const c = new ethers.Contract(H.staking, STK_ABI, signer);
      await tx(() => c.unstakeTokens(curTok.address, staked), `Unstaked $${curTok.symbol} ✓ — split applied if set`, 's-status', () => this.load(true));
    },
    async claim() { if (!signer) return connect(); const c = new ethers.Contract(H.staking, STK_ABI, signer); await tx(() => c.claim(), 'Rewards claimed ✓', 's-status', () => this.load(true)); },
    async donate() {
      const s = ($('s-donate-amt').value || '').trim(); if (!s || +s <= 0) return setStatus('s-status', 'Enter an ETH amount to donate.', 'err');
      if (!signer) return connect();
      const c = new ethers.Contract(H.staking, STK_ABI, signer);
      await tx(() => c.donate({ value: ethers.parseEther(s) }), `Donated ${s} Ξ to the pool — thank you`, 's-status', () => this.load(true));
    },
    async setSplit() {
      if (!signer) return connect();
      const rows = [1, 2, 3].map((i) => ({ a: ($('col-a' + i).value || '').trim(), b: ($('col-b' + i).value || '').trim() })).filter((r) => r.a && r.b);
      const wallets = rows.map((r) => r.a), bps = rows.map((r) => Math.round(+r.b * 100));
      if (!wallets.every((w) => ethers.isAddress(w))) return setStatus('s-status', 'One of the withdraw addresses is invalid.', 'err');
      if (bps.reduce((s, x) => s + x, 0) > 10000) return setStatus('s-status', 'Withdraw shares add up to more than 100%.', 'err');
      const c = new ethers.Contract(H.staking, STK_ABI, signer);
      await tx(() => c.setWithdrawSplit(wallets, bps), 'Withdraw wallets saved ✓', 's-status', () => this.load(true));
    },
    async stakeNFT(id) {
      // lock-in-place: the NFT stays in your wallet (just locked), no transfer/approval needed
      if (!signer) return connect();
      const c = new ethers.Contract(H.staking, STK_ABI, signer);
      await tx(() => c.stakeNFT(id), `Staked NFT #${id} ✓ — it stays in your wallet, just locked.`, 's-status', () => { this.load(true); if (active === 'mint') Mint.load(true); });
    },
    async unstakeNFT(id) {
      if (!signer) return connect();
      const c = new ethers.Contract(H.staking, STK_ABI, signer);
      await tx(() => c.unstakeNFT(id), `Unstaked NFT #${id} ✓`, 's-status', () => { this.load(true); if (active === 'mint') Mint.load(true); });
    },
  };

  /* ================= PACT ================= */
  const Pact = {
    entryFee: 0n, refundAmount: 0n,
    async load(withUser) {
      if (!H.pact) { setStatus('pc-status', 'Sherwood Pact goes live at launch.', ''); return; }
      const p = provider || ro();
      try {
        const c = new ethers.Contract(H.pact, PACT_ABI, p);
        const [ef, rf, gr, mn, mx] = await Promise.all([c.entryFee(), c.refundAmount(), c.grace(), c.minDuration(), c.maxDuration()]);
        this.entryFee = ef; this.refundAmount = rf;
        $('pc-entry').textContent = eth(ef) + ' Ξ'; $('pc-refund').textContent = eth(rf) + ' Ξ'; $('pc-grace').textContent = days(gr) + 'd';
        $('pc-range').textContent = `Duration ${days(mn)}–${days(mx)} days. Entry ${eth(ef)} Ξ now → ${eth(rf)} Ξ + reward back if you held.`;
        const btn = $('pc-create'); if (btn) { btn.disabled = false; btn.textContent = `Seal Pact · pay ${eth(ef)} Ξ`; }
        if (withUser && me) await this.loadMine(c);
        else if (!me) $('pc-list').innerHTML = '<div class="empty">Connect your wallet to see your pacts.</div>';
      } catch (e) { setStatus('pc-status', 'Could not reach the Pact contract yet.', ''); }
    },
    async loadMine(c) {
      const list = $('pc-list'); if (!list) return;
      try {
        const n = Number(await c.pactsOfCount(me));
        if (n === 0) { list.innerHTML = '<div class="empty">No pacts yet. Seal one on the left.</div>'; return; }
        const ids = []; for (let i = 0; i < n; i++) ids.push(Number(await c.pactsOf(me, i)));
        const pacts = await Promise.all(ids.map((id) => c.pacts(id).then((p) => ({ id, p }))));
        list.innerHTML = '';
        pacts.reverse().forEach(({ id, p }) => list.appendChild(this.card(id, p)));
      } catch { list.innerHTML = '<div class="empty">Could not load your pacts.</div>'; }
    },
    card(id, p) {
      const STATUS = ['None', 'Open', 'Verified', 'Claimed', 'Forfeited', 'Reclaimed'];
      const st = Number(p.status); const name = STATUS[st] || '—';
      const start = Number(p.start), dur = Number(p.duration), grace = Number(p.reclaimGrace);
      const now = Math.floor(Date.now() / 1000);
      const windowEnd = start + dur, reclaimAt = windowEnd + grace;
      const el = document.createElement('div'); el.className = 'pactcard';
      let action = '', foot = '';
      if (st === 1) { // Open
        if (now < windowEnd) foot = `Holding… window ends ${new Date(windowEnd * 1000).toLocaleDateString()} (${Math.ceil((windowEnd - now) / 86400)}d left).`;
        else if (now < reclaimAt) foot = `Window ended — awaiting verification. Reclaimable ${new Date(reclaimAt * 1000).toLocaleDateString()} if unresolved.`;
        else { foot = 'Unresolved past grace — reclaim your full entry.'; action = `<button class="btn btn-gold btn-sm" data-act="reclaim" data-id="${id}">Reclaim ${eth(p.entryPaid)} Ξ</button>`; }
      } else if (st === 2) { // Verified
        foot = 'Verified — you held! Claim your refund + reward.'; action = `<button class="btn btn-gold btn-sm" data-act="claim" data-id="${id}">Claim ${eth(p.payout)} Ξ</button>`;
      } else if (st === 3) foot = 'Claimed ✓';
      else if (st === 4) foot = 'Forfeited — entry went to backend costs.';
      else if (st === 5) foot = 'Reclaimed ✓';
      el.innerHTML = `
        <div class="row">
          <span class="pill ${name.toLowerCase()}">${esc(name)}</span>
          <span style="font:600 .78rem/1 'Space Grotesk',monospace;color:var(--muted)">Pact #${id}</span>
        </div>
        <div class="meta">Hold ≥ <b>${num(p.minHold)}</b> $STAG · <b>${days(dur)}d</b> · started ${new Date(start * 1000).toLocaleDateString()}</div>
        <div class="meta">${esc(foot)}</div>
        ${action ? `<div style="margin-top:.7rem">${action}</div>` : ''}`;
      const b = el.querySelector('[data-act]');
      if (b) b.onclick = () => (b.dataset.act === 'claim' ? this.claim(id) : this.reclaim(id));
      return el;
    },
    async create() {
      if (!signer) return connect();
      const hold = ($('pc-hold').value || '').trim(), d = ($('pc-days').value || '').trim();
      if (!hold || +hold <= 0) return setStatus('pc-status', 'Enter how much $STAG you will hold.', 'err');
      if (!d || +d <= 0) return setStatus('pc-status', 'Enter a duration in days.', 'err');
      const minHold = ethers.parseEther(hold), dur = Math.round(+d * 86400);
      const c = new ethers.Contract(H.pact, PACT_ABI, signer);
      await tx(() => c.createPact(minHold, dur, { value: this.entryFee }), 'Pact sealed — hold tight and return to claim.', 'pc-status', () => this.load(true));
    },
    async claim(id) { if (!signer) return connect(); const c = new ethers.Contract(H.pact, PACT_ABI, signer); await tx(() => c.claim(id), 'Pact reward claimed ✓', 'pc-status', () => this.load(true)); },
    async reclaim(id) { if (!signer) return connect(); const c = new ethers.Contract(H.pact, PACT_ABI, signer); await tx(() => c.reclaim(id), 'Entry reclaimed ✓', 'pc-status', () => this.load(true)); },
  };

  // ---------------- init ----------------
  document.addEventListener('DOMContentLoaded', () => {
    // Which panels are present? A hub has the tab bar + all three; a split page has exactly one.
    const PAGE = document.body.getAttribute('data-page');
    const panels = ['mint', 'stake', 'pact'].filter((n) => $('panel-' + n));
    const isHub = !!document.querySelector('.app-tabs') && panels.length > 1;

    $('w-connect').onclick = () => connect(false);
    { const d = $('w-disconnect'); if (d) d.onclick = disconnect; }
    // "Add Robinhood Chain" helper button — the network must exist in the wallet before minting/staking works
    { const wc = $('w-connect'); const bar = wc && wc.parentElement;
      if (bar && !$('w-addchain')) { const a = document.createElement('button');
        a.id = 'w-addchain'; a.className = 'btn btn-ghost btn-sm'; a.textContent = '＋ Add RH Chain';
        a.title = 'Add the Robinhood Chain network to your wallet'; a.onclick = addChainToWallet;
        bar.insertBefore(a, wc); } }
    // iPhone/Android reality: MetaMask can't be detected in Safari — wallets only inject inside their
    // OWN in-app browser (that's why SafePal works there). Give MetaMask users a one-tap way in.
    setTimeout(() => {
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (!isMobile || window.ethereum) return;              // desktop, or a wallet already injected
      const wc = $('w-connect'); const bar = wc && wc.parentElement; if (!bar || $('w-mm-help')) return;
      const dapp = location.host + location.pathname + location.search;
      const el = document.createElement('div');
      el.id = 'w-mm-help';
      el.style.cssText = 'flex-basis:100%;order:99;margin-top:.5rem;font:600 .76rem/1.45 system-ui;color:#a9c2b0;text-align:center';
      el.innerHTML = 'On iPhone? Open in your wallet’s browser: '
        + '<a href="https://metamask.app.link/dapp/' + dapp + '" style="color:#e6b83f;font-weight:800">MetaMask →</a>'
        + ' · or tap <b>Connect</b> for SafePal / WalletConnect.';
      bar.appendChild(el);
    }, 900);
    // "Go to Pact" — switch tabs on the hub, navigate to the standalone page otherwise.
    { const p = $('s-to-pact'); if (p) p.onclick = () => { if (isHub) showTab('pact'); else location.href = '/pact'; }; }
    // show the reward-pool address + copy button (direct-send donations)
    { const pa = $('s-pool-addr'); if (pa && H.staking) pa.textContent = H.staking;
      const cp = $('s-pool-copy'); if (cp) cp.onclick = async () => {
        try { await navigator.clipboard.writeText(H.staking); cp.textContent = 'Copied ✓'; setTimeout(() => cp.textContent = 'Copy', 1500); } catch { setStatus('s-status', 'Pool address: ' + H.staking, ''); } }; }
    if (isHub) document.querySelectorAll('.app-tab').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
    // stake bindings
    const bind = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    bind('s-stake', () => Stake.stake()); bind('s-unstake', () => Stake.unstake()); bind('s-claimbtn', () => Stake.claim());
    bind('s-donate', () => Stake.donate()); bind('s-setsplit', () => Stake.setSplit());
    const mx = $('s-max'); if (mx) mx.onclick = async () => { if (!me) return; const bal = await new ethers.Contract(curTok.address, ERC20, ro()).balanceOf(me); $('s-amount').value = fmtTokFull(bal, curTok); };
    bind('pc-create', () => Pact.create());
    // enable action buttons once connected is handled per-load; enable base buttons now (they call connect() if no signer)
    ['s-stake', 's-unstake', 's-claimbtn', 's-donate', 's-setsplit'].forEach((id) => { const b = $(id); if (b) b.disabled = false; });

    // pick the active section: split pages declare it via <body data-page>; the hub reads the hash
    const h = (location.hash || '').replace('#', '');
    active = ['mint', 'stake', 'pact'].includes(PAGE) ? PAGE
      : (['mint', 'stake', 'pact'].includes(h) ? h : (panels[0] || 'mint'));
    if (isHub) {
      showTab(active);
      // nav links (/app#mint etc.) only change the hash — switch the tab when it changes
      window.addEventListener('hashchange', () => {
        const t = (location.hash || '').replace('#', '');
        if (['mint', 'stake', 'pact'].includes(t) && t !== active) showTab(t);
      });
      // pre-load the other tabs' read-only data so switching is instant
      Mint.load(false); Stake.load(false); Pact.load(false);
    } else {
      // standalone split page — just render this page's single section
      loadTab(active, false);
    }
    // remember the wallet across visits — silently reconnect if previously authorized (no popup)
    try { if (localStorage.getItem('h20_wc') && window.ethereum) connect(true); } catch {}
  });
})();
