/* ============================================================
   STAGWIFHOOD — Admin Dashboard (Robinhood Chain / ethers v6)
   Owner-gated control center for The Hooded 20 mint + staking pool.
   Reads live on-chain stats; every write runs a pre-sign guard
   (owner check + estimateGas) so the wallet never shows a scary
   "this may fail" warning. Deployed addresses are pasted in the
   Config card and persisted to localStorage — no redeploy to wire.
   ============================================================ */
(function () {
  'use strict';

  const CHAIN = {
    chainId: '0x1237', // 4663 mainnet (testnet 46630 => '0xB626')
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
  };
  const STAG = '0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49';
  const WHITELIST_DEFAULT = '0x5db7ca9d2ce3f414b3fd94ec0fcaf9f3ab1a575f';
  const TIERS = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];
  const TIER_COUNT = [4, 5, 5, 4, 2]; // supply per tier (for odds preview)

  // deployed addresses — persisted; paste in the Config card once live
  const store = {
    get: (k) => localStorage.getItem('h20_' + k) || '',
    set: (k, v) => localStorage.setItem('h20_' + k, v),
  };
  const ADDR = {
    mint: () => store.get('mint'),
    staking: () => store.get('staking'),
    splitter: () => store.get('splitter'),
  };

  const HOODED_ABI = [
    'function owner() view returns (address)',
    'function mintActive() view returns (bool)',
    'function minted() view returns (uint256)',
    'function remaining() view returns (uint256)',
    'function MAX_SUPPLY() view returns (uint256)',
    'function maxPerWallet() view returns (uint256)',
    'function randomPrice() view returns (uint256)',
    'function tierPrice(uint256) view returns (uint256)',
    'function tierWeight(uint256) view returns (uint256)',
    'function splitter() view returns (address)',
    'function locker() view returns (address)',
    'function freeMints(address) view returns (uint256)',
    'function setMintActive(bool)',
    'function setTierPrice(uint8,uint256)',
    'function setRandomPrice(uint256)',
    'function setTierWeight(uint8,uint256)',
    'function setMaxPerWallet(uint256)',
    'function setBaseURI(string)',
    'function setSplitter(address)',
    'function setLocker(address)',
    'function setRoyalty(address,uint96)',
    'function grantFreeMints(address,uint256)',
    'function withdrawETH(address)',
  ];
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

  let provider, signer, me, isOwner = false;
  const $ = (id) => document.getElementById(id);
  const fmt = (wei, d = 4) => { try { return (+ethers.formatEther(wei)).toFixed(d); } catch { return '—'; } };
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
  const toast = (m, cls) => { const t = $('toast'); if (!t) return; t.textContent = m; t.className = 'adm-toast show ' + (cls || ''); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 5000); };

  /* ---------- read-only provider (dashboard works before connecting) ---------- */
  function ro() {
    return new ethers.JsonRpcProvider(CHAIN.rpcUrls[0], { name: CHAIN.chainName, chainId: parseInt(CHAIN.chainId, 16) });
  }

  async function loadDashboard() {
    const p = provider || ro();
    // Reward pool = ETH held by the staking contract
    const stk = ADDR.staking();
    if (stk) { try { $('kpi-pool').textContent = fmt(await p.getBalance(stk)) + ' ETH'; } catch { $('kpi-pool').textContent = '—'; } }
    else $('kpi-pool').textContent = 'awaiting deploy';

    // Total $STAG staked (reads staking contract's STAG balance as a proxy)
    if (stk) {
      try {
        const stag = new ethers.Contract(STAG, ERC20_ABI, p);
        const [bal, dec] = await Promise.all([stag.balanceOf(stk), stag.decimals()]);
        $('kpi-staked').textContent = Number(ethers.formatUnits(bal, dec)).toLocaleString() + ' STAG';
      } catch { $('kpi-staked').textContent = '—'; }
    } else $('kpi-staked').textContent = 'awaiting deploy';

    // Stakeable projects (whitelist count — 1 = $STAG for now)
    $('kpi-projects').textContent = store.get('projects') || '1';

    // NFT mint progress
    const mint = ADDR.mint();
    if (mint) {
      try {
        const c = new ethers.Contract(mint, HOODED_ABI, p);
        const [m, max, active] = await Promise.all([c.minted(), c.MAX_SUPPLY(), c.mintActive()]);
        $('kpi-minted').textContent = `${m} / ${max}`;
        $('kpi-mintstate').textContent = active ? 'LIVE' : 'paused';
        $('kpi-mintstate').className = 'adm-kpi-tag ' + (active ? 'on' : 'off');
        await hydrateMintControls(c);
      } catch (e) { $('kpi-minted').textContent = '—'; }
    } else { $('kpi-minted').textContent = 'awaiting deploy'; }

    renderOdds();
  }

  async function hydrateMintControls(c) {
    try {
      const [rand, mpw, spl, lock] = await Promise.all([c.randomPrice(), c.maxPerWallet(), c.splitter(), c.locker()]);
      $('in-random').value = ethers.formatEther(rand);
      $('in-mpw').value = mpw.toString();
      $('in-splitter').value = spl;
      $('in-locker').value = lock;
      for (let t = 0; t < 5; t++) {
        const [price, w] = await Promise.all([c.tierPrice(t), c.tierWeight(t)]);
        $('price-' + t).value = ethers.formatEther(price);
        $('weight-' + t).value = w.toString();
      }
      renderOdds();
    } catch {}
  }

  function renderOdds() {
    let weights = [], total = 0;
    for (let t = 0; t < 5; t++) {
      const w = parseFloat(($('weight-' + t) || {}).value) || 0;
      weights[t] = w * TIER_COUNT[t]; total += weights[t];
    }
    for (let t = 0; t < 5; t++) {
      const el = $('odds-' + t); if (!el) continue;
      el.textContent = total ? (weights[t] / total * 100).toFixed(1) + '%' : '—';
    }
  }

  /* ---------- wallet ---------- */
  async function connect() {
    if (!window.ethereum) { toast('No EVM wallet found — install MetaMask.', 'err'); return; }
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] }); }
      catch (e) { if (e.code === 4902) await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [CHAIN] }); }
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      me = (await signer.getAddress());
      $('btn-connect').textContent = short(me);
      // owner check against the mint contract
      const mint = ADDR.mint();
      if (mint) {
        const owner = await new ethers.Contract(mint, HOODED_ABI, provider).owner();
        isOwner = owner.toLowerCase() === me.toLowerCase();
        $('owner-flag').textContent = isOwner ? '✓ owner — controls unlocked' : '⚠ not the owner wallet (read-only)';
        $('owner-flag').className = 'adm-owner ' + (isOwner ? 'ok' : 'warn');
        document.body.classList.toggle('is-owner', isOwner);
      } else {
        $('owner-flag').textContent = 'set the mint address in Config to verify owner';
      }
      await loadDashboard();
    } catch (e) { toast(pretty(e), 'err'); }
  }

  function pretty(e) {
    const m = (e && (e.shortMessage || e.reason || e.info?.error?.message || e.message)) || 'error';
    if (/user rejected|denied|4001/i.test(m)) return 'Cancelled in wallet.';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH for gas.';
    return String(m).slice(0, 180);
  }

  // pre-sign guard: require owner + estimateGas before prompting a signature
  async function send(method, args, okMsg) {
    if (!signer) return toast('Connect your wallet first.', 'err');
    const mint = ADDR.mint();
    if (!mint) return toast('Set the mint contract address in Config first.', 'err');
    if (!isOwner) return toast('Connected wallet is not the contract owner.', 'err');
    const c = new ethers.Contract(mint, HOODED_ABI, signer);
    try {
      await c[method].estimateGas(...args);           // guard
    } catch (e) { return toast('Would revert: ' + pretty(e), 'err'); }
    try {
      toast('Confirm in wallet…');
      const tx = await c[method](...args);
      toast('Submitted — waiting for confirmation…');
      await tx.wait();
      toast(okMsg || 'Done ✓', 'ok');
      await loadDashboard();
    } catch (e) { toast(pretty(e), 'err'); }
  }

  const parseEth = (v) => ethers.parseEther(String(v || '0'));

  /* ---------- wire controls ---------- */
  function wire() {
    $('btn-connect').onclick = connect;

    $('btn-mint-on').onclick = () => send('setMintActive', [true], 'Mint activated ✓');
    $('btn-mint-off').onclick = () => send('setMintActive', [false], 'Mint paused ✓');
    $('btn-random').onclick = () => send('setRandomPrice', [parseEth($('in-random').value)], 'Gamble price set ✓');
    $('btn-mpw').onclick = () => send('setMaxPerWallet', [BigInt($('in-mpw').value || '0')], 'Max/wallet set ✓');
    $('btn-baseuri').onclick = () => send('setBaseURI', [$('in-baseuri').value.trim()], 'Base URI set ✓');
    $('btn-splitter').onclick = () => send('setSplitter', [$('in-splitter').value.trim()], 'Splitter set ✓');
    $('btn-locker').onclick = () => send('setLocker', [$('in-locker').value.trim()], 'Locker set ✓');
    $('btn-royalty').onclick = () => send('setRoyalty', [$('in-roy-addr').value.trim(), BigInt($('in-roy-bps').value || '0')], 'Royalty set ✓');
    $('btn-withdraw').onclick = () => send('withdrawETH', [$('in-withdraw').value.trim() || me], 'Withdrawn ✓');
    $('btn-free').onclick = () => send('grantFreeMints', [$('in-free-addr').value.trim(), BigInt($('in-free-n').value || '0')], 'Free mints granted ✓');

    for (let t = 0; t < 5; t++) {
      $('btn-price-' + t).onclick = () => send('setTierPrice', [t, parseEth($('price-' + t).value)], TIERS[t] + ' price set ✓');
      $('btn-weight-' + t).onclick = () => send('setTierWeight', [t, BigInt($('weight-' + t).value || '0')], TIERS[t] + ' weight set ✓');
      $('weight-' + t).oninput = renderOdds;
    }

    // config: paste deployed addresses
    $('cfg-mint').value = ADDR.mint(); $('cfg-staking').value = ADDR.staking(); $('cfg-splitter').value = ADDR.splitter();
    $('cfg-projects').value = store.get('projects') || '1';
    $('btn-cfg-save').onclick = async () => {
      store.set('mint', $('cfg-mint').value.trim());
      store.set('staking', $('cfg-staking').value.trim());
      store.set('splitter', $('cfg-splitter').value.trim());
      store.set('projects', $('cfg-projects').value.trim());
      toast('Config saved ✓', 'ok');
      if (signer) await connect(); else await loadDashboard();
    };

    // prefill whitelist
    $('in-free-addr').value = WHITELIST_DEFAULT; $('in-free-n').value = '20';
  }

  document.addEventListener('DOMContentLoaded', () => { wire(); loadDashboard(); });
})();
