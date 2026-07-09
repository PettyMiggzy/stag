/* ============================================================
   STAGWIFHOOD — Terminal Quick-Trade wallet flow (Robinhood Chain).
   Same anti-"malicious warning" pattern as the mint:
     connect → add/switch chain → PRE-SIGN GUARD (balance +
     estimateGas simulate) → only sign if it will actually pass.

   ⚡ TO GO LIVE: set CONFIG.router (the swap router on Robinhood
   Chain) + CONFIG.weth. While router is empty the panel connects
   the wallet and shows balances, but the trade button stays
   "Coming Soon" so nobody signs into a dead route.
   ============================================================ */
(function () {
  'use strict';

  const CONFIG = {
    router: '',   // Robinhood Chain swap router (0x…). Empty => trade stays Coming Soon.
    weth: '',     // wrapped-native address used for the ETH→token path
    chain: {
      chainId: '0x1237',   // 4663 mainnet (testnet 46630 => '0xB626')
      chainName: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
      blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
    },
  };

  const btn = document.getElementById('trade-btn');
  const statusEl = document.getElementById('trade-status');
  const amtEl = document.getElementById('trade-amt');
  const balEl = document.getElementById('trade-bal');
  const tokEl = document.getElementById('trade-tok');
  const amtLabel = document.getElementById('trade-amt-label');
  if (!btn) return;
  const setStatus = (m, cls) => { if (statusEl) { statusEl.innerHTML = m; statusEl.className = 'mint-status ' + (cls || ''); } };

  /* ---- buy / sell tabs (cosmetic until routing is live) ---- */
  let side = 'buy';
  document.querySelectorAll('.term-trade-tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.term-trade-tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      side = t.dataset.side;
      amtLabel.textContent = side === 'buy' ? 'You pay' : 'You sell';
      tokEl.textContent = side === 'buy' ? 'ETH' : 'tokens';
      refreshTradeBtn();
    });
  });

  let me = null;
  const configured = !!CONFIG.router;

  function refreshTradeBtn() {
    if (!me) { btn.textContent = 'Connect Wallet'; btn.disabled = false; return; }
    if (!configured) { btn.textContent = (side === 'buy' ? 'Buy' : 'Sell') + ' — Coming Soon'; btn.disabled = true; return; }
    btn.textContent = side === 'buy' ? 'Buy token' : 'Sell token';
    btn.disabled = false;
  }

  function pretty(e) {
    const m = (e && (e.shortMessage || e.reason || e.info?.error?.message || e.message)) || 'Something went wrong';
    if (/insufficient funds/i.test(m)) return 'Not enough balance for this trade + gas.';
    if (/user rejected|denied|4001/i.test(m)) return 'Cancelled in wallet.';
    return m.slice(0, 160);
  }

  btn.onclick = () => { if (!me) connect(); };

  async function connect() {
    if (!window.ethereum) {
      setStatus('No EVM wallet found — install MetaMask.', 'err');
      window.open('https://metamask.io/download/', '_blank');
      return;
    }
    if (!window.ethers) { setStatus('Wallet library failed to load — refresh.', 'err'); return; }
    try {
      setStatus('Connecting…');
      const provider = new window.ethers.BrowserProvider(window.ethereum);
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CONFIG.chain.chainId }] });
      } catch (e) {
        if (e.code === 4902) await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [CONFIG.chain] });
        else throw e;
      }
      const signer = await provider.getSigner();
      me = await signer.getAddress();
      const bal = await provider.getBalance(me);
      balEl.textContent = 'Balance: ' + Number(window.ethers.formatEther(bal)).toFixed(4) + ' ETH';
      amtEl.disabled = false;
      setStatus(`Connected ${me.slice(0, 6)}…${me.slice(-4)}`, 'ok');
      refreshTradeBtn();
      if (configured) btn.onclick = trade;
      window.ethereum.on?.('accountsChanged', () => location.reload());
      window.ethereum.on?.('chainChanged', () => location.reload());
    } catch (e) { setStatus(pretty(e), 'err'); }
  }

  // Live trade path (only wired once CONFIG.router is set). Keeps the
  // same PRE-SIGN GUARD contract: simulate before asking for a signature.
  async function trade() {
    if (!configured) return;
    try {
      const ethers = window.ethers;
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      me = await signer.getAddress();
      const amt = parseFloat(amtEl.value);
      if (!(amt > 0)) { setStatus('Enter an amount first.', 'err'); return; }

      setStatus('Simulating your trade…');
      // NOTE: router ABI/path are filled at launch. The guard below stays:
      //   estimateGas first (a revert here means the tx would fail) and
      //   confirm the wallet can cover value + gas BEFORE we ever sign.
      const value = side === 'buy' ? ethers.parseEther(String(amt)) : 0n;
      const bal = await provider.getBalance(me);
      const fd = await provider.getFeeData();
      const perGas = fd.maxFeePerGas ?? fd.gasPrice ?? 0n;
      // placeholder gas until router wired; real path re-estimates on the router call
      const gas = 250000n;
      if (bal < value + gas * perGas) { setStatus('Not enough ETH for the trade + gas.', 'err'); return; }
      setStatus('Routing goes live with the $STAG pool — stay tuned.', 'ok');
    } catch (e) { setStatus(pretty(e), 'err'); }
  }

  refreshTradeBtn();
})();
