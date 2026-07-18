/* ============================================================
   STAGWIFHOOD Terminal — LIVE Quick Trade (Robinhood Chain 4663).
   Buys/sells the currently-scanned token through SherwoodSwap, which routes
   via the on-chain Uniswap V3 router and skims 1% -> $STAG marketing wallet.
     • non-custodial (funds pass through the swap contract in one tx)
     • quote from the token's live USD price; minOut = quote - slippage
     • PRE-SIGN GUARD: staticcall-simulate before asking for a signature
   ============================================================ */
(function () {
  'use strict';
  if (!window.ethers) return;

  const SWAP = '0x481d3A3E9C28627Ed91e58d83a5D6790A6416055';
  const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
  const FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'; // Uniswap V3 factory
  const RPC = 'https://rpc.mainnet.chain.robinhood.com';
  const CHAIN = { chainId: '0x1237', chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [RPC], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] };
  const CHAIN_ID = 4663n;
  const EXPLORER = CHAIN.blockExplorerUrls[0];

  const SWAP_ABI = [
    'function buy(address token,uint24 poolFee,uint256 minOut) payable returns (uint256)',
    'function sell(address token,uint24 poolFee,uint256 amountIn,uint256 minOut) returns (uint256)',
    'function feeBps() view returns (uint256)',
  ];
  const ERC20 = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ];
  const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];

  const $ = (id) => document.getElementById(id);
  const btn = $('trade-btn'); if (!btn) return;
  const statusEl = $('trade-status'), amtEl = $('trade-amt'), balEl = $('trade-bal'),
    tokEl = $('trade-tok'), amtLabel = $('trade-amt-label'), estWrap = $('trade-est'),
    estOut = $('trade-out'), estMin = $('trade-min'), quickWrap = $('trade-quick');

  const ro = new ethers.JsonRpcProvider(RPC, { chainId: 4663, name: 'rh' }, { staticNetwork: true });
  let provider = null, signer = null, me = null;
  let side = 'buy', slip = 15, feeBps = 100n, ethUsd = 0;
  let tok = null;            // { ca, symbol, decimals, priceUsd }
  const poolCache = {};      // ca -> fee tier (0 = none)

  const setStatus = (m, cls) => { if (statusEl) { statusEl.innerHTML = m; statusEl.className = 'mint-status ' + (cls || ''); } };
  const fmt = (n, d = 4) => { n = Number(n); if (!isFinite(n)) return '—'; return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : d }); };
  function pretty(e) {
    const m = (e && (e.shortMessage || e.reason || e.info?.error?.message || e.message)) || 'Something went wrong';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH for this + gas.';
    if (/user rejected|denied|4001/i.test(m)) return 'Cancelled in wallet.';
    if (/slippage|Too little received|STF|reverted/i.test(m)) return 'Trade would fail — try a higher slippage or smaller size.';
    return m.slice(0, 150);
  }

  (async () => { try { const s = await (await fetch('https://robinhoodchain.blockscout.com/api/v2/stats')).json(); if (+s.coin_price > 0) ethUsd = +s.coin_price; } catch {} if (!ethUsd) ethUsd = 1800;
    try { feeBps = await new ethers.Contract(SWAP, SWAP_ABI, ro).feeBps(); } catch {} })();

  // ---- pool discovery (which V3 fee tier has a token/WETH pool) ----
  async function poolFeeFor(ca) {
    if (poolCache[ca] !== undefined) return poolCache[ca];
    const f = new ethers.Contract(FACTORY, FACTORY_ABI, ro);
    let found = 0;
    for (const fee of [10000, 3000, 500]) {
      try { const p = await f.getPool(ca, WETH, fee); if (p && !/^0x0+$/.test(p)) { found = fee; break; } } catch {}
    }
    poolCache[ca] = found; return found;
  }

  // ---- when a new token is scanned ----
  document.addEventListener('term-token', async () => {
    tok = window.TERM_TOKEN || null;
    await refresh();
  });

  function quickAmounts() {
    if (!quickWrap) return;
    const opts = side === 'buy' ? [['0.01 Ξ', '0.01'], ['0.05 Ξ', '0.05'], ['0.1 Ξ', '0.1'], ['0.5 Ξ', '0.5']]
      : [['25%', '25'], ['50%', '50'], ['100%', '100']];
    quickWrap.innerHTML = opts.map(([l, v]) => '<button type="button" data-q="' + v + '" data-pct="' + (side === 'sell') + '">' + l + '</button>').join('');
    quickWrap.querySelectorAll('button').forEach((b) => b.onclick = async () => {
      if (b.dataset.pct === 'true') { const bal = await tokenBalance(); amtEl.value = trimNum(bal * (Number(b.dataset.q) / 100)); }
      else amtEl.value = b.dataset.q;
      quote();
    });
  }
  const trimNum = (n) => { if (!isFinite(n) || n <= 0) return ''; return String(Number(n.toPrecision(8))); };

  async function tokenBalance() {
    if (!me || !tok) return 0;
    try { const b = await new ethers.Contract(tok.ca, ERC20, ro).balanceOf(me); return Number(ethers.formatUnits(b, tok.decimals)); } catch { return 0; }
  }
  async function ethBalance() { if (!me) return 0; try { return Number(ethers.formatEther(await ro.getBalance(me))); } catch { return 0; } }

  async function refresh() {
    const sym = (tok && tok.symbol) || 'TOKEN';
    amtLabel.textContent = side === 'buy' ? 'You pay' : 'You sell';
    tokEl.textContent = side === 'buy' ? 'ETH' : sym;
    quickAmounts();
    // balance line
    if (me) {
      const b = side === 'buy' ? await ethBalance() : await tokenBalance();
      balEl.textContent = 'Balance: ' + fmt(b) + (side === 'buy' ? ' ETH' : ' ' + sym);
    } else balEl.textContent = 'Balance: —';
    // pool + button state
    let pool = 0; if (tok) pool = await poolFeeFor(tok.ca);
    amtEl.disabled = !me || !tok || !pool;
    if (!me) { btn.textContent = 'Connect Wallet'; btn.disabled = false; btn.onclick = connect; }
    else if (!tok) { btn.textContent = 'Scan a token first'; btn.disabled = true; }
    else if (!pool) { btn.textContent = 'No Uniswap pool'; btn.disabled = true; setStatus('This token has no Uniswap V3 pool on Robinhood Chain — can\'t route a swap.', 'err'); }
    else { btn.textContent = side === 'buy' ? 'Buy ' + sym : 'Sell ' + sym; btn.disabled = false; btn.onclick = trade; setStatus(''); }
    quote();
  }

  // ---- quote from live USD price (impact covered by slippage) ----
  function quote() {
    const amt = parseFloat(amtEl.value);
    if (!tok || !(amt > 0) || !(tok.priceUsd > 0) || !ethUsd) { if (estWrap) estWrap.hidden = true; return null; }
    const feeMul = 1 - Number(feeBps) / 10000;
    let out, outSym, minOut;
    if (side === 'buy') { out = (amt * feeMul) * ethUsd / tok.priceUsd; outSym = tok.symbol || 'TOKEN'; }
    else { out = (amt * tok.priceUsd / ethUsd) * feeMul; outSym = 'ETH'; }
    minOut = out * (1 - slip / 100);
    if (estWrap) {
      estWrap.hidden = false;
      estOut.textContent = fmt(out) + ' ' + outSym;
      estMin.textContent = 'min ' + fmt(minOut) + ' ' + outSym + ' · ' + slip + '% slip';
    }
    return { out, minOut, outSym };
  }

  // ---- wallet ----
  async function connect() {
    if (!window.ethereum) { setStatus('No EVM wallet found — install MetaMask, or open this page in your wallet’s browser.', 'err'); return; }
    try {
      setStatus('Connecting…');
      provider = new ethers.BrowserProvider(window.ethereum);
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] }); }
      catch (e) { try { await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [CHAIN] }); await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] }); } catch {} }
      const net = await provider.getNetwork();
      if (net.chainId !== CHAIN_ID) { setStatus('Switch your wallet to Robinhood Chain, then reconnect.', 'err'); return; }
      signer = await provider.getSigner(); me = await signer.getAddress();
      setStatus('Connected ' + me.slice(0, 6) + '…' + me.slice(-4), 'ok');
      window.ethereum.on?.('accountsChanged', () => location.reload());
      window.ethereum.on?.('chainChanged', () => location.reload());
      await refresh();
    } catch (e) { setStatus(pretty(e), 'err'); }
  }

  // ---- execute ----
  async function trade() {
    if (!signer || !tok) return;
    const amt = parseFloat(amtEl.value);
    if (!(amt > 0)) { setStatus('Enter an amount first.', 'err'); return; }
    const pool = await poolFeeFor(tok.ca);
    if (!pool) { setStatus('No Uniswap pool for this token.', 'err'); return; }
    const q = quote(); if (!q) { setStatus('Can\'t quote — no live price. Try a token with a price.', 'err'); return; }
    const swap = new ethers.Contract(SWAP, SWAP_ABI, signer);
    try {
      if (side === 'buy') {
        const value = ethers.parseEther(String(amt));
        const minOut = ethers.parseUnits(trimNum(q.minOut) || '0', tok.decimals);
        const bal = await ro.getBalance(me);
        if (bal <= value) { setStatus('Not enough ETH for this trade + gas.', 'err'); return; }
        setStatus('Simulating…');
        await swap.buy.staticCall(tok.ca, pool, minOut, { value });   // PRE-SIGN GUARD
        setStatus('Confirm in your wallet…');
        const tx = await swap.buy(tok.ca, pool, minOut, { value });
        await done(tx);
      } else {
        const amtWei = ethers.parseUnits(String(amt), tok.decimals);
        const erc = new ethers.Contract(tok.ca, ERC20, signer);
        const held = await erc.balanceOf(me);
        if (held < amtWei) { setStatus('You don\'t hold that much ' + (tok.symbol || 'token') + '.', 'err'); return; }
        const allow = await erc.allowance(me, SWAP);
        if (allow < amtWei) { setStatus('Approve ' + (tok.symbol || 'token') + ' first…'); const at = await erc.approve(SWAP, ethers.MaxUint256); await at.wait(); }
        const minOut = ethers.parseEther(trimNum(q.minOut) || '0');
        setStatus('Simulating…');
        await swap.sell.staticCall(tok.ca, pool, amtWei, minOut);      // PRE-SIGN GUARD
        setStatus('Confirm in your wallet…');
        const tx = await swap.sell(tok.ca, pool, amtWei, minOut);
        await done(tx);
      }
    } catch (e) { setStatus(pretty(e), 'err'); }
  }
  async function done(tx) {
    setStatus('Submitting… waiting for confirmation');
    const rc = await tx.wait();
    setStatus('✅ Done — <a href="' + EXPLORER + '/tx/' + rc.hash + '" target="_blank" rel="noopener" style="color:var(--gold-lite)">view tx ↗</a>', 'ok');
    amtEl.value = ''; if (estWrap) estWrap.hidden = true;
    await refresh();
  }

  // ---- controls ----
  document.querySelectorAll('.term-trade-tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.term-trade-tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active'); side = t.dataset.side; amtEl.value = ''; refresh();
  }));
  document.querySelectorAll('#slip-opts button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('#slip-opts button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); slip = Number(b.dataset.s); quote();
  });
  amtEl && amtEl.addEventListener('input', quote);
  const maxBtn = $('trade-max');
  if (maxBtn) maxBtn.onclick = async () => {
    if (!me) return;
    if (side === 'buy') { const b = await ethBalance(); amtEl.value = trimNum(Math.max(0, b - 0.0005)); }
    else { amtEl.value = trimNum(await tokenBalance()); }
    quote();
  };

  refresh();
})();
