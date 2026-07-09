/* ============================================================
   STAGWIFHOOD — Mint wallet flow (Robinhood Chain / EVM / ethers v6)
   Anti-"malicious warning" pattern: connect → add/switch chain →
   PRE-SIGN GUARD (balance + estimateGas) → sign only if it will pass.

   ⚡ TO GO LIVE: fill CONFIG.contract + CONFIG.priceEth below.
   While CONFIG.contract is empty, the button stays "Mint — Coming Soon".
   ============================================================ */
(function () {
  'use strict';

  const CONFIG = {
    /* ===== FILL AT LAUNCH ============================================ */
    contract: '',            // deployed Hooded 20 mint contract (0x…). Empty => Coming Soon.
    priceEth: '0',           // mint price in the native gas token, e.g. '0.01'
    payWith: 'native',       // 'native' (ETH) or 'stag' (pay in the $STAG ERC-20)
    stagToken: '',           // $STAG ERC-20 address (only if payWith === 'stag')
    stagPrice: '0',          // $STAG amount in human units (only if payWith === 'stag')
    /* ================================================================ */

    // Robinhood Chain (Arbitrum-Orbit L2). Native gas token = ETH per docs.robinhood.com/chain.
    chain: {
      chainId: '0x1237',     // 4663 mainnet  (testnet 46630 => '0xB616')
      chainName: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
      blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
    },

    // Adjust the mint fragment to match your contract (default: mints one random, payable).
    mintAbi: [
      'function mint() payable',
      'function totalSupply() view returns (uint256)',
      'function MAX_SUPPLY() view returns (uint256)',
    ],
    erc20Abi: [
      'function allowance(address,address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)',
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ],
  };

  const btn = document.getElementById('mint-btn');
  const statusEl = document.getElementById('mint-status');
  if (!btn) return;
  const setStatus = (m, cls) => { if (statusEl) { statusEl.innerHTML = m; statusEl.className = 'mint-status ' + (cls || ''); } };

  // Not configured yet → leave the "Coming Soon" state untouched.
  if (!CONFIG.contract) return;
  if (!window.ethers) { setStatus('Wallet library failed to load — refresh and try again.', 'err'); return; }

  const priceLabel = CONFIG.payWith === 'stag' ? `${CONFIG.stagPrice} $STAG` : `${CONFIG.priceEth} ETH`;
  btn.disabled = false;
  btn.textContent = 'Connect Wallet';
  btn.onclick = connect;
  let me = null;

  function pretty(e) {
    const m = (e && (e.shortMessage || e.reason || e.info?.error?.message || e.message)) || 'Something went wrong';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH for the mint + gas.';
    if (/user rejected|denied|4001/i.test(m)) return 'Cancelled in wallet.';
    if (/sold out|max/i.test(m)) return 'Sold out — all 20 minted.';
    return m.slice(0, 160);
  }

  async function connect() {
    if (!window.ethereum) {
      setStatus('No EVM wallet found — install MetaMask.', 'err');
      window.open('https://metamask.io/download/', '_blank');
      return;
    }
    try {
      setStatus('Connecting…');
      const provider = new window.ethers.BrowserProvider(window.ethereum);
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      // add / switch to Robinhood Chain (prevents wrong-network + odd flags)
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CONFIG.chain.chainId }] });
      } catch (e) {
        if (e.code === 4902) await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [CONFIG.chain] });
        else throw e;
      }
      const signer = await provider.getSigner();
      me = await signer.getAddress();
      btn.textContent = `Mint 1 · ${priceLabel}`;
      btn.onclick = mint;
      setStatus(`Connected ${me.slice(0, 6)}…${me.slice(-4)}`, 'ok');
      refreshSupply(provider);
      window.ethereum.on?.('accountsChanged', () => location.reload());
      window.ethereum.on?.('chainChanged', () => location.reload());
    } catch (e) { setStatus(pretty(e), 'err'); }
  }

  async function mint() {
    try {
      const ethers = window.ethers;
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      me = await signer.getAddress();
      const c = new ethers.Contract(CONFIG.contract, CONFIG.mintAbi, signer);
      const value = CONFIG.payWith === 'native' ? ethers.parseEther(String(CONFIG.priceEth)) : 0n;

      // ERC-20 $STAG payment path: check balance + approve BEFORE minting
      if (CONFIG.payWith === 'stag') {
        const erc = new ethers.Contract(CONFIG.stagToken, CONFIG.erc20Abi, signer);
        const dec = await erc.decimals();
        const need = ethers.parseUnits(String(CONFIG.stagPrice), dec);
        if (await erc.balanceOf(me) < need) { setStatus('Not enough $STAG for the mint.', 'err'); return; }
        if (await erc.allowance(me, CONFIG.contract) < need) {
          setStatus('Approve $STAG spending in your wallet…');
          await (await erc.approve(CONFIG.contract, need)).wait();
        }
      }

      // ---- PRE-SIGN GUARD (this is what stops the "malicious" warning) ----
      setStatus('Checking your balance…');
      const bal = await provider.getBalance(me);
      let gas = null;
      try { gas = await c.mint.estimateGas({ value }); } catch { gas = null; } // reverts ⇒ would fail
      if (gas == null) { setStatus('Transaction would fail — check funds, that the sale is open, or that you haven\'t already minted.', 'err'); return; }
      const fd = await provider.getFeeData();
      const perGas = fd.maxFeePerGas ?? fd.gasPrice ?? 0n;
      if (bal < value + gas * perGas) { setStatus('Not enough ETH for the mint + gas.', 'err'); return; }

      // ---- only now sign + send ----
      setStatus('Confirm in your wallet…');
      const tx = await c.mint({ value });
      setStatus('Minting your random Hooded Stag…');
      await tx.wait();
      const url = CONFIG.chain.blockExplorerUrls[0] + '/tx/' + tx.hash;
      setStatus(`🎉 Minted! <a href="${url}" target="_blank" rel="noopener">View transaction ↗</a>`, 'ok');
      refreshSupply(provider);
    } catch (e) { setStatus(pretty(e), 'err'); }
  }

  async function refreshSupply(provider) {
    try {
      const c = new window.ethers.Contract(CONFIG.contract, CONFIG.mintAbi, provider);
      const t = await c.totalSupply().catch(() => null);
      if (t == null) return;
      const max = await c.MAX_SUPPLY().catch(() => 20n);
      const minted = Number(t), total = Number(max || 20n);
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('m-minted', minted);
      set('supply-count', `${minted} / ${total} minted`);
      const fill = document.getElementById('supply-fill');
      if (fill) fill.style.width = (minted / total * 100) + '%';
      if (minted >= total) { btn.disabled = true; btn.textContent = 'Sold Out'; }
    } catch (_) {}
  }
})();
