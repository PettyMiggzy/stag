/* ============================================================
   Sherwood Market — P2P token exchange UI (Robinhood Chain 4663 · ethers v6)
   Browse open orders, post a sell order, fill or cancel. Self-contained;
   reuses window.HOODED for config + the same wallet-connect flow as app.js.
   ============================================================ */
(function () {
  'use strict';
  const H = window.HOODED || {};
  const CHAIN_ID = BigInt(parseInt((H.chain && H.chain.chainId) || '0x1237', 16));
  const MARKET = H.market;
  const STAG = H.stag;
  const ETH = '0x0000000000000000000000000000000000000000';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MARKET_ABI = [
    'function createOrder(address sellToken,uint256 sellAmount,address buyToken,uint256 buyAmount) returns (uint256)',
    'function fillOrder(uint256 id) payable',
    'function cancelOrder(uint256 id)',
    'function nextOrderId() view returns (uint256)',
    'function buyFeeBps() view returns (uint256)',
    'function sellFeeBps() view returns (uint256)',
    'function openOrders(uint256 start,uint256 limit) view returns (uint256[])',
    'function getOrder(uint256 id) view returns (tuple(address maker,bool active,uint16 buyFeeBps,uint16 sellFeeBps,address sellToken,uint256 sellAmount,address buyToken,uint256 buyAmount))',
  ];
  const ERC20 = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ];

  // ---------------- state ----------------
  let provider = null, signer = null, me = null, wcProvider = null;
  let filter = 'all';
  let orders = [];               // {id, maker, sellToken, sellAmount, buyToken, buyAmount, s{sym,dec}, b{sym,dec}}
  const metaCache = new Map();   // tokenAddr(lower) -> {symbol, decimals}
  const explorer = (H.chain && H.chain.blockExplorerUrls && H.chain.blockExplorerUrls[0]) || 'https://robinhoodchain.blockscout.com';

  const ro = () => (H.readProvider ? H.readProvider() : new ethers.JsonRpcProvider(H.chain.rpcUrls[0], { name: H.chain.chainName, chainId: Number(CHAIN_ID) }));
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const ethFmt = (v, d = 4) => { try { return (+ethers.formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: d }); } catch { return '—'; } };
  async function chainOk() { try { return provider && (await provider.getNetwork()).chainId === CHAIN_ID; } catch { return false; } }
  function fmtUnits(raw, dec) { try { const n = +ethers.formatUnits(raw, dec); return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : n < 1000 ? 4 : 2 }); } catch { return '—'; } }
  function setStatus(el, m, c) { const e = $(el); if (e) { e.textContent = m; e.className = 'status ' + (c || ''); } }

  function pretty(e) {
    const m = (e && (e.shortMessage || e.reason || e.info?.error?.message || e.message)) || 'error';
    if (/user rejected|denied|4001/i.test(m)) return 'Cancelled in wallet.';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH for this + gas.';
    if (/not open/i.test(m)) return 'That order was just filled or cancelled — refreshing.';
    if (/maker cannot fill own/i.test(m)) return "That's your own order — cancel it instead.";
    if (/wrong ETH amount/i.test(m)) return 'Price changed — refresh and retry.';
    if (/bad buyToken|same token/i.test(m)) return 'Invalid pay token — must be ETH or a real token, and different from the sell token.';
    if (/transfer amount exceeds|allowance/i.test(m)) return 'Token approval needed or insufficient — retry.';
    return String(m).slice(0, 170);
  }

  // ---------------- token metadata ----------------
  async function meta(token) {
    const t = (token || '').toLowerCase();
    if (t === ETH) return { symbol: 'ETH', decimals: 18 };
    if (metaCache.has(t)) return metaCache.get(t);
    let out = { symbol: t.slice(0, 6) + '…', decimals: 18 };
    try {
      const c = new ethers.Contract(token, ERC20, ro());
      const [sym, dec] = await Promise.all([c.symbol().catch(() => null), c.decimals().catch(() => 18)]);
      out = { symbol: sym || out.symbol, decimals: Number(dec) };
    } catch {}
    metaCache.set(t, out);
    return out;
  }

  // ---------------- wallet (mirrors app.js) ----------------
  async function getEip1193(silent) {
    if (window.ethereum) return window.ethereum;
    if (silent) return null;
    const pid = H.walletConnectProjectId;
    if (pid) {
      try {
        setStatus('post-status', 'Opening wallet… pick your wallet in the popup.');
        const { EthereumProvider } = await import('https://esm.sh/@walletconnect/ethereum-provider@2.17.2');
        const cid = Number(CHAIN_ID);
        wcProvider = await EthereumProvider.init({
          projectId: pid, optionalChains: [cid], rpcMap: { [cid]: H.chain.rpcUrls[0] }, showQrModal: true,
          metadata: { name: 'Sherwood Market', description: 'P2P token trading on Robinhood Chain', url: 'https://stagwifhood.fun', icons: ['https://stagwifhood.fun/assets/img/mark.png'] },
        });
        wcProvider.on('disconnect', () => location.reload());
        await wcProvider.enable();
        return wcProvider;
      } catch { setStatus('post-status', 'Couldn’t open WalletConnect — open stagwifhood.fun inside your wallet’s browser and try Connect.', 'err'); return null; }
    }
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) { window.location.href = 'https://metamask.app.link/dapp/' + location.host + location.pathname; return null; }
    setStatus('post-status', 'Tap Connect again and pick your wallet, or open this page inside your wallet’s browser.', 'err');
    return null;
  }
  async function connect(silent) {
    const eth = await getEip1193(silent);
    if (!eth) return;
    try {
      const accs = await eth.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
      if (silent && (!accs || !accs.length)) return;
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: H.chain.chainId }] }); }
      catch { try { await eth.request({ method: 'wallet_addEthereumChain', params: [H.chain] }); await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: H.chain.chainId }] }); } catch {} }
      provider = new ethers.BrowserProvider(eth);
      if (!(await chainOk())) { signer = null; me = null; setNet('bad', 'Wrong network — switch to Robinhood Chain'); return; }
      signer = await provider.getSigner(); me = await signer.getAddress();
      if (eth.removeAllListeners) eth.removeAllListeners('chainChanged');
      eth.on && eth.on('chainChanged', () => location.reload());
      eth.on && eth.on('accountsChanged', () => location.reload());
      $('w-connect').textContent = short(me);
      const dc = $('w-disconnect'); if (dc) dc.hidden = false;
      try { localStorage.setItem('h20_wc', '1'); } catch {}
      setNet('ok', 'Robinhood Chain');
      await refreshWallet();
      render();
    } catch (e) { if (!silent) setStatus('post-status', pretty(e), 'err'); }
  }
  function disconnect() {
    signer = null; me = null; provider = null;
    if (wcProvider) { try { wcProvider.disconnect(); } catch {} wcProvider = null; }
    try { localStorage.removeItem('h20_wc'); } catch {}
    $('w-connect').textContent = 'Connect Wallet';
    const dc = $('w-disconnect'); if (dc) dc.hidden = true;
    const bals = $('w-bals'); if (bals) bals.hidden = true;
    setNet('off', 'Not connected'); render();
  }
  function setNet(state, txt) { const n = $('w-net'); if (n) n.className = 'wbar-net ' + state; const t = $('w-net-txt'); if (t) t.textContent = txt; }
  async function refreshWallet() {
    const bals = $('w-bals'); if (!me) { if (bals) bals.hidden = true; return; }
    try {
      const p = provider || ro();
      const [e, s] = await Promise.all([p.getBalance(me), new ethers.Contract(STAG, ERC20, p).balanceOf(me)]);
      $('w-eth').textContent = ethFmt(e, 4);
      $('w-stag').textContent = (+ethers.formatUnits(s, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 });
      if (bals) bals.hidden = false;
    } catch {}
    updateSellBalance();
  }

  // ---------------- write helper ----------------
  async function tx(run, okMsg, after) {
    if (!signer) return connect();
    if (!(await chainOk())) return setStatus('post-status', 'Wrong network — switch to Robinhood Chain (4663).', 'err');
    try {
      setStatus('post-status', 'Confirm in your wallet…');
      const t = await run();
      setStatus('post-status', 'Submitting… waiting for confirmation');
      await t.wait();
      setStatus('post-status', okMsg, 'ok');
      await refreshWallet(); if (after) await after();
    } catch (e) { setStatus('post-status', pretty(e), 'err'); }
  }
  async function ensureAllowance(token, amount) {
    const erc = new ethers.Contract(token, ERC20, signer);
    const cur = await erc.allowance(me, MARKET);
    if (cur >= amount) return;
    setStatus('post-status', 'Approve the token first…');
    const t = await erc.approve(MARKET, amount); await t.wait();
  }

  // ---------------- load orders ----------------
  async function load() {
    if (!MARKET) { $('order-list').innerHTML = '<p class="hint" style="text-align:center;padding:1rem 0">Market not configured yet.</p>'; return; }
    const scan = $('m-scan'); if (scan) scan.href = explorer + '/address/' + MARKET;
    try {
      const c = new ethers.Contract(MARKET, MARKET_ABI, ro());
      const ids = await c.openOrders(0, 200);
      const raw = await Promise.all(ids.map((id) => c.getOrder(id).then((o) => ({ id, o })).catch(() => null)));
      const live = raw.filter((x) => x && x.o.active);
      orders = await Promise.all(live.map(async ({ id, o }) => {
        const [s, b] = await Promise.all([meta(o.sellToken), meta(o.buyToken)]);
        return { id: Number(id), maker: o.maker, sellToken: o.sellToken, sellAmount: o.sellAmount, buyToken: o.buyToken, buyAmount: o.buyAmount, s, b };
      }));
    } catch (e) { $('order-list').innerHTML = '<p class="hint" style="text-align:center;padding:1rem 0">Couldn’t load orders — tap Refresh.</p>'; return; }
    render();
  }

  function render() {
    $('m-open').textContent = orders.length;
    if (me) $('m-yours').textContent = orders.filter((o) => o.maker.toLowerCase() === me.toLowerCase()).length;
    let list = orders.slice();
    if (filter === 'stag') list = list.filter((o) => o.sellToken.toLowerCase() === (STAG || '').toLowerCase() || o.buyToken.toLowerCase() === (STAG || '').toLowerCase());
    else if (filter === 'mine') list = me ? list.filter((o) => o.maker.toLowerCase() === me.toLowerCase()) : [];
    const wrap = $('order-list');
    if (!list.length) { wrap.innerHTML = '<p class="hint" style="text-align:center;padding:1.2rem 0">' + (filter === 'mine' && !me ? 'Connect your wallet to see your orders.' : 'No open orders here yet. Be the first to post one →') + '</p>'; return; }
    list.sort((a, b) => b.id - a.id);
    wrap.innerHTML = list.map((o) => {
      const mine = me && o.maker.toLowerCase() === me.toLowerCase();
      const act = mine
        ? `<button class="btn btn-ghost btn-sm" data-cancel="${o.id}">Cancel</button>`
        : `<button class="btn btn-gold btn-sm" data-fill="${o.id}">Buy</button>`;
      return `<div class="order">
        <div class="leg"><span class="amt">${esc(fmtUnits(o.sellAmount, o.s.decimals))}</span><span class="sym">${esc(o.s.symbol)} · selling</span></div>
        <span class="arrow">→</span>
        <div class="leg"><span class="amt">${esc(fmtUnits(o.buyAmount, o.b.decimals))}</span><span class="sym">${esc(o.b.symbol)} · price</span></div>
        <div class="who">${mine ? '<span class="mine-tag">Yours</span>' : 'by <a href="' + explorer + '/address/' + o.maker + '" target="_blank" rel="noopener">' + short(o.maker) + '</a>'}<br>#${o.id}</div>
        <div class="oact">${act}</div>
      </div>`;
    }).join('');
    wrap.querySelectorAll('[data-fill]').forEach((b) => b.onclick = () => fill(+b.dataset.fill));
    wrap.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => cancel(+b.dataset.cancel));
  }

  // ---------------- actions ----------------
  async function fill(id) {
    if (!signer) return connect();
    const o = orders.find((x) => x.id === id); if (!o) return load();
    const c = new ethers.Contract(MARKET, MARKET_ABI, signer);
    if (o.buyToken.toLowerCase() === ETH) {
      await tx(() => c.fillOrder(id, { value: o.buyAmount }), `Bought ${fmtUnits(o.sellAmount, o.s.decimals)} ${o.s.symbol} ✓`, load);
    } else {
      try { await ensureAllowance(o.buyToken, o.buyAmount); } catch (e) { return setStatus('post-status', pretty(e), 'err'); }
      await tx(() => c.fillOrder(id), `Bought ${fmtUnits(o.sellAmount, o.s.decimals)} ${o.s.symbol} ✓`, load);
    }
  }
  async function cancel(id) {
    if (!signer) return connect();
    const c = new ethers.Contract(MARKET, MARKET_ABI, signer);
    await tx(() => c.cancelOrder(id), 'Order cancelled — escrow returned ✓', load);
  }

  // ---------------- post form ----------------
  const sel = { sell: 'STAG', pay: 'ETH' };
  function tokenAddr(which) {
    const k = sel[which];
    if (k === 'ETH') return ETH;
    if (k === 'STAG') return STAG;
    return ($(which + '-addr').value || '').trim();
  }
  async function updateSellBalance() {
    const el = $('sell-bal'); if (!el) return;
    const addr = tokenAddr('sell');
    if (!me || !ethers.isAddress(addr) || addr === ETH) { el.textContent = 'Balance: —'; return; }
    try { const c = new ethers.Contract(addr, ERC20, ro()); const [bal, m] = await Promise.all([c.balanceOf(me), meta(addr)]); el.textContent = 'Balance: ' + fmtUnits(bal, m.decimals) + ' ' + m.symbol; el.dataset.raw = bal.toString(); el.dataset.dec = m.decimals; }
    catch { el.textContent = 'Balance: —'; }
  }
  async function post() {
    if (!signer) return connect();
    const sellAddr = tokenAddr('sell'), payAddr = tokenAddr('pay');
    if (!ethers.isAddress(sellAddr) || sellAddr === ETH) return setStatus('post-status', 'Enter a valid token address to sell (ETH can only be the payment side).', 'err');
    if (payAddr !== ETH && !ethers.isAddress(payAddr)) return setStatus('post-status', 'Enter a valid pay-token address (or pick ETH).', 'err');
    if (sellAddr.toLowerCase() === payAddr.toLowerCase()) return setStatus('post-status', 'Sell token and pay token must be different.', 'err');
    const sellAmtStr = ($('sell-amt').value || '').trim(), payAmtStr = ($('pay-amt').value || '').trim();
    if (!(+sellAmtStr > 0) || !(+payAmtStr > 0)) return setStatus('post-status', 'Enter both an amount and a price.', 'err');
    let sellAmount, buyAmount;
    try {
      const sm = await meta(sellAddr), bm = await meta(payAddr);
      sellAmount = ethers.parseUnits(sellAmtStr, sm.decimals);
      buyAmount = ethers.parseUnits(payAmtStr, bm.decimals);
    } catch { return setStatus('post-status', 'Couldn’t read that token — check the address.', 'err'); }
    try { await ensureAllowance(sellAddr, sellAmount); } catch (e) { return setStatus('post-status', pretty(e), 'err'); }
    const c = new ethers.Contract(MARKET, MARKET_ABI, signer);
    await tx(() => c.createOrder(sellAddr, sellAmount, payAddr, buyAmount), 'Order posted — it’s live for buyers ✓', () => { $('sell-amt').value = ''; $('pay-amt').value = ''; load(); });
  }

  // ---------------- wire up ----------------
  function pickPills(rowId, which, symId, addrRowId) {
    const row = $(rowId);
    row.querySelectorAll('button').forEach((b) => b.onclick = () => {
      row.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      sel[which] = b.dataset.tok;
      const custom = b.dataset.tok === 'custom';
      $(addrRowId).hidden = !custom;
      const sym = b.dataset.tok === 'ETH' ? 'Ξ ETH' : b.dataset.tok === 'STAG' ? '$STAG' : 'TOKEN';
      if (symId) $(symId).textContent = sym;
      if (which === 'sell') updateSellBalance();
    });
  }

  function init() {
    if (!window.ethers) { setStatus('post-status', 'Wallet library failed to load — refresh.', 'err'); return; }
    $('w-connect').onclick = () => (me ? null : connect(false));
    $('w-disconnect').onclick = disconnect;
    $('post-btn').onclick = post;
    $('refresh-btn').onclick = load;
    pickPills('sell-pills', 'sell', 'sell-sym', 'sell-addr-row');
    pickPills('pay-pills', 'pay', 'pay-sym', 'pay-addr-row');
    $('sell-addr').oninput = updateSellBalance;
    $('sell-max').onclick = () => { const el = $('sell-bal'); if (el && el.dataset.raw) $('sell-amt').value = ethers.formatUnits(el.dataset.raw, +el.dataset.dec); };
    $('filter-seg').querySelectorAll('button').forEach((b) => b.onclick = () => { $('filter-seg').querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); filter = b.dataset.f; render(); });
    // read fees for the stat
    if (MARKET) { const c = new ethers.Contract(MARKET, MARKET_ABI, ro()); Promise.all([c.buyFeeBps(), c.sellFeeBps()]).then(([bf, sf]) => { $('m-fee').textContent = (Number(bf) / 100) + '% / ' + (Number(sf) / 100) + '%'; }).catch(() => {}); }
    load();
    try { if (localStorage.getItem('h20_wc')) connect(true); } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
