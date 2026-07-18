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

  const SWAP = '0xd43d5aa252077d0Cfd2CFdCD13f9B8e85C5C1392'; // out-of-band-fee redeploy (Blockaid-safe)
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
  const ORDERS = '0x689988a1adB3Da7554Ba1fFc256904498aaF1F54';
  const ORDERS_ABI = [
    'function createBuyOrder(address token,uint24 poolFee,uint256 minOut) payable returns (uint256)',
    'function createSellOrder(address token,uint24 poolFee,uint256 amountIn,uint256 minOut) returns (uint256)',
    'function cancelOrder(uint256 id)',
    'function openOrders(uint256 start,uint256 limit) view returns (uint256[])',
    'function getOrder(uint256 id) view returns (tuple(address maker,address token,bool isBuy,bool active,uint24 poolFee,uint256 amountIn,uint256 minOut))',
  ];
  const metaCache = {};   // token -> {symbol, decimals}

  const $ = (id) => document.getElementById(id);
  const btn = $('trade-btn'); if (!btn) return;
  const statusEl = $('trade-status'), amtEl = $('trade-amt'), balEl = $('trade-bal'),
    tokEl = $('trade-tok'), amtLabel = $('trade-amt-label'), estWrap = $('trade-est'),
    estOut = $('trade-out'), estMin = $('trade-min'), quickWrap = $('trade-quick');

  const ro = new ethers.JsonRpcProvider(RPC, { chainId: 4663, name: 'rh' }, { staticNetwork: true });
  let provider = null, signer = null, me = null;
  let side = 'buy', mode = 'market', slip = 15, feeBps = 100n, ethUsd = 0;
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
    // mode-dependent fields
    const slipRow = $('trade-slip-row'), limitBox = $('trade-limit');
    if (slipRow) slipRow.hidden = mode !== 'market';
    if (limitBox) limitBox.hidden = mode !== 'limit';
    if (mode === 'limit') limitQuick();
    // pool + button state
    let pool = 0; if (tok) pool = await poolFeeFor(tok.ca);
    amtEl.disabled = !me || !tok || !pool;
    const verb = side === 'buy' ? 'Buy' : 'Sell';
    if (!me) { btn.textContent = 'Connect Wallet'; btn.disabled = false; btn.onclick = connect; }
    else if (!tok) { btn.textContent = 'Scan a token first'; btn.disabled = true; }
    else if (!pool) { btn.textContent = 'No Uniswap pool'; btn.disabled = true; setStatus('This token has no Uniswap V3 pool on Robinhood Chain — can\'t route a swap.', 'err'); }
    else if (mode === 'limit') { btn.textContent = (side === 'buy' ? 'Place Limit Buy' : 'Place Take-Profit'); btn.disabled = false; btn.onclick = placeLimit; setStatus(''); }
    else { btn.textContent = verb + ' ' + sym; btn.disabled = false; btn.onclick = trade; setStatus(''); }
    if (me) loadMyOrders();
    quote(); limitQuote();
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

  /* ---------------- LIMIT orders (SherwoodOrders) ---------------- */
  const lp = () => $('limit-price'), lhint = () => $('limit-hint');
  function limitQuick() {
    const wrap = $('limit-quick'); if (!wrap || !tok) return;
    const cur = tok.priceUsd || 0;
    const opts = side === 'buy'
      ? [['-10%', 0.9], ['-25%', 0.75], ['-50%', 0.5]]
      : [['2×', 2], ['3×', 3], ['5×', 5], ['10×', 10]];
    wrap.innerHTML = opts.map(([l, m]) => '<button type="button" data-mul="' + m + '">' + l + '</button>').join('');
    wrap.querySelectorAll('button').forEach((b) => b.onclick = () => { if (cur > 0) { lp().value = trimNum(cur * Number(b.dataset.mul)); limitQuote(); } });
  }
  function limitQuote() {
    if (mode !== 'limit' || !tok) { return; }
    const amt = parseFloat(amtEl.value), target = parseFloat(lp() ? lp().value : '');
    const el = lhint(); if (!el) return;
    const lbl = $('limit-label'); if (lbl) lbl.textContent = side === 'buy' ? 'Buy when price ≤ (USD)' : 'Sell when price ≥ (USD)';
    if (!(amt > 0) || !(target > 0) || !ethUsd) { el.textContent = ''; return; }
    const feeMul = 1 - Number(feeBps) / 10000;
    if (side === 'buy') { const outTok = (amt * feeMul) * ethUsd / target; el.innerHTML = 'Fills when price ≤ <b>$' + fmt(target) + '</b> → you get ≥ <b>' + fmt(outTok) + ' ' + esc(tok.symbol) + '</b>'; }
    else { const outEth = (amt * target / ethUsd) * feeMul; el.innerHTML = 'Fills when price ≥ <b>$' + fmt(target) + '</b> → you get ≥ <b>' + fmt(outEth) + ' ETH</b>'; }
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function placeLimit() {
    if (!signer || !tok) return;
    const amt = parseFloat(amtEl.value), target = parseFloat(lp().value);
    if (!(amt > 0)) return setStatus('Enter an amount.', 'err');
    if (!(target > 0)) return setStatus('Enter a target price.', 'err');
    if (!(tok.priceUsd > 0) || !ethUsd) return setStatus('No live price to base the order on.', 'err');
    const pool = await poolFeeFor(tok.ca); if (!pool) return setStatus('No Uniswap pool for this token.', 'err');
    const feeMul = 1 - Number(feeBps) / 10000;
    const oc = new ethers.Contract(ORDERS, ORDERS_ABI, signer);
    try {
      if (side === 'buy') {
        const value = ethers.parseEther(String(amt));
        const outTok = (amt * feeMul) * ethUsd / target;
        const minOut = ethers.parseUnits(trimNum(outTok) || '0', tok.decimals);
        if ((await ro.getBalance(me)) <= value) return setStatus('Not enough ETH for this order + gas.', 'err');
        setStatus('Confirm the limit buy in your wallet…');
        const tx = await oc.createBuyOrder(tok.ca, pool, minOut, { value });
        await afterOrder(tx);
      } else {
        const amtWei = ethers.parseUnits(String(amt), tok.decimals);
        const erc = new ethers.Contract(tok.ca, ERC20, signer);
        if ((await erc.balanceOf(me)) < amtWei) return setStatus("You don't hold that much " + (tok.symbol || 'token') + '.', 'err');
        if ((await erc.allowance(me, ORDERS)) < amtWei) { setStatus('Approve ' + (tok.symbol || 'token') + ' first…'); await (await erc.approve(ORDERS, ethers.MaxUint256)).wait(); }
        const outEth = (amt * target / ethUsd) * feeMul;
        const minOut = ethers.parseEther(trimNum(outEth) || '0');
        setStatus('Confirm the take-profit in your wallet…');
        const tx = await oc.createSellOrder(tok.ca, pool, amtWei, minOut);
        await afterOrder(tx);
      }
    } catch (e) { setStatus(pretty(e), 'err'); }
  }
  async function afterOrder(tx) {
    setStatus('Submitting order…'); const rc = await tx.wait();
    setStatus('✅ Order placed — it fills automatically when your price hits. <a href="' + EXPLORER + '/tx/' + rc.hash + '" target="_blank" rel="noopener" style="color:var(--gold-lite)">tx ↗</a>', 'ok');
    amtEl.value = ''; if (lp()) lp().value = ''; if (lhint()) lhint().textContent = '';
    await loadMyOrders(); await refresh();
  }

  async function meta(token) {
    const t = (token || '').toLowerCase();
    if (metaCache[t]) return metaCache[t];
    let out = { symbol: t.slice(0, 6) + '…', decimals: 18 };
    try { const c = new ethers.Contract(token, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], ro);
      const [s, d] = await Promise.all([c.symbol().catch(() => null), c.decimals().catch(() => 18)]); out = { symbol: s || out.symbol, decimals: Number(d) }; } catch {}
    metaCache[t] = out; return out;
  }
  async function loadMyOrders() {
    const box = $('my-orders'), list = $('mo-list'); if (!box || !list || !me) return;
    let mine = [];
    try {
      const oc = new ethers.Contract(ORDERS, ORDERS_ABI, ro);
      const ids = await oc.openOrders(0, 300);
      const all = await Promise.all(ids.map((id) => oc.getOrder(id).then((o) => ({ id: Number(id), o })).catch(() => null)));
      mine = all.filter((x) => x && x.o.maker.toLowerCase() === me.toLowerCase());
    } catch { }
    if (!mine.length) { box.hidden = mode !== 'limit'; list.innerHTML = mode === 'limit' ? '<div class="mo-info" style="text-align:center;padding:.5rem">No open orders yet.</div>' : ''; return; }
    box.hidden = false;
    const rows = await Promise.all(mine.map(async ({ id, o }) => {
      const m = await meta(o.token);
      const info = o.isBuy
        ? '<b>Limit Buy · ' + esc(m.symbol) + '</b>' + fmt(+ethers.formatEther(o.amountIn)) + ' ETH → ≥ ' + fmt(+ethers.formatUnits(o.minOut, m.decimals)) + ' ' + esc(m.symbol)
        : '<b>Take-Profit · ' + esc(m.symbol) + '</b>' + fmt(+ethers.formatUnits(o.amountIn, m.decimals)) + ' ' + esc(m.symbol) + ' → ≥ ' + fmt(+ethers.formatEther(o.minOut)) + ' ETH';
      return '<div class="mo-row"><span class="mo-info">' + info + '</span><button class="mo-cancel" data-id="' + id + '" type="button">Cancel</button></div>';
    }));
    list.innerHTML = rows.join('');
    list.querySelectorAll('.mo-cancel').forEach((b) => b.onclick = async () => {
      try { const oc = new ethers.Contract(ORDERS, ORDERS_ABI, signer); setStatus('Cancelling order…'); await (await oc.cancelOrder(+b.dataset.id)).wait(); setStatus('Order cancelled — escrow returned ✓', 'ok'); await loadMyOrders(); await refresh(); }
      catch (e) { setStatus(pretty(e), 'err'); }
    });
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
  document.querySelectorAll('#trade-mode button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('#trade-mode button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); mode = b.dataset.m; amtEl.value = ''; if ($('limit-price')) $('limit-price').value = '';
    const note = $('trade-note'); if (note) note.innerHTML = mode === 'limit'
      ? 'A <strong>limit order</strong> escrows your funds and auto-fills when your target price hits — a <strong>1% fee</strong> supports $STAG. Cancel anytime to get your escrow back.'
      : 'Non-custodial swap via Uniswap on Robinhood Chain — a <strong>1% fee</strong> supports $STAG. We simulate before you sign.';
    refresh();
  });
  const lpEl = $('limit-price'); if (lpEl) lpEl.addEventListener('input', limitQuote);
  amtEl && amtEl.addEventListener('input', () => { quote(); limitQuote(); });
  const maxBtn = $('trade-max');
  if (maxBtn) maxBtn.onclick = async () => {
    if (!me) return;
    if (side === 'buy') { const b = await ethBalance(); amtEl.value = trimNum(Math.max(0, b - 0.0005)); }
    else { amtEl.value = trimNum(await tokenBalance()); }
    quote();
  };

  refresh();
})();
