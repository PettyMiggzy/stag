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
  const CHAIN_ID = BigInt(parseInt(CHAIN.chainId, 16)); // 4663
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
    'function forwardProceeds()',
  ];
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
  const STAKING_ABI = [
    'function owner() view returns (address)',
    'function totalWeight() view returns (uint256)',
    'function reserved() view returns (uint256)',
    'function tierInfo() view returns (uint256[3],uint256[3])',
    'function notifyRewardAmount(uint256,uint256)',
    'function setTierMultBps(uint8,uint256)',
    'function setHoldingTiers(uint256[],uint256[])',
    'function setTokenWeight(address,uint256)',
    'function setEarlyPenaltyBps(uint256)',
  ];
  const PACT_ABI = [
    'function owner() view returns (address)',
    'function entryFee() view returns (uint256)',
    'function refundAmount() view returns (uint256)',
    'function oracle() view returns (address)',
    'function freeTreasury() view returns (uint256)',
    'function pactCount() view returns (uint256)',
    'function setEntryFee(uint256)',
    'function setRefundAmount(uint256)',
    'function setOracle(address)',
  ];

  // generic owner write against any contract (guarded)
  async function ownerSend(addr, abi, method, args, okMsg, valueWei) {
    if (!signer) return toast('Connect your wallet first.', 'err');
    if (!addr) return toast('Set the contract address in Config first.', 'err');
    const c = new ethers.Contract(addr, abi, signer);
    const ov = valueWei != null ? { value: valueWei } : {};
    try { await c[method].estimateGas(...args, ov); } catch (e) { return toast('Would revert: ' + pretty(e), 'err'); }
    try {
      toast('Confirm in wallet…');
      const tx = await c[method](...args, ov);
      toast('Submitted — waiting…');
      await tx.wait();
      toast(okMsg || 'Done ✓', 'ok');
      await loadDashboard();
    } catch (e) { toast(pretty(e), 'err'); }
  }

  let provider, signer, me, isOwner = false;
  const $ = (id) => document.getElementById(id);
  const fmt = (wei, d = 4) => { try { return (+ethers.formatEther(wei)).toFixed(d); } catch { return '—'; } };
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
  const toast = (m, cls) => { const t = $('toast'); if (!t) return; t.textContent = m; t.className = 'adm-toast show ' + (cls || ''); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 5000); };

  /* ---------- read-only provider: FREE public RPC first, /api/rpc (paid Alchemy) backup ---------- */
  function ro() {
    const net = { name: CHAIN.chainName, chainId: parseInt(CHAIN.chainId, 16) };
    const pub = new ethers.JsonRpcProvider(CHAIN.rpcUrls[0], net, { staticNetwork: true });
    try {
      if (typeof location !== 'undefined' && /^https?:/.test(location.protocol)) {
        const proxy = new ethers.JsonRpcProvider(location.origin + '/api/rpc', net, { staticNetwork: true });
        return new ethers.FallbackProvider(
          [{ provider: pub, priority: 1, stallTimeout: 1500, weight: 1 },
           { provider: proxy, priority: 2, stallTimeout: 3000, weight: 1 }], net, { quorum: 1 });
      }
    } catch (e) { /* fall through */ }
    return pub;
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
      if ((await provider.getNetwork()).chainId !== CHAIN_ID) { signer = null; toast('Wrong network — switch to Robinhood Chain (4663) and reconnect.', 'err'); return; }
      signer = await provider.getSigner();
      me = (await signer.getAddress());
      if (window.ethereum.removeAllListeners) window.ethereum.removeAllListeners('chainChanged');
      window.ethereum.on && window.ethereum.on('chainChanged', () => { signer = null; provider = null; isOwner = false; $('btn-connect').textContent = 'Connect Wallet'; toast('Network changed — reconnect on Robinhood Chain.', 'err'); });
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
    $('btn-forward') && ($('btn-forward').onclick = () => ownerSend(ADDR.mint(), HOODED_ABI, 'forwardProceeds', [], 'Mint proceeds forwarded to the pool ✓'));
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
      if ($('cfg-pact')) store.set('pact', $('cfg-pact').value.trim());
      store.set('projects', $('cfg-projects').value.trim());
      toast('Config saved ✓', 'ok');
      if (signer) await connect(); else await loadDashboard();
    };

    // ----- staking admin -----
    const stk = () => store.get('staking');
    $('sk-fund') && ($('sk-fund').onclick = async () => {
      if (!signer) return toast('Connect wallet first.', 'err');
      const addr = stk();
      if (!ethers.isAddress(addr)) return toast('Set a valid staking address in Config.', 'err');
      if ((await provider.getCode(addr)) === '0x') return toast('No contract at the staking address — check Config.', 'err');
      try { const tx = await signer.sendTransaction({ to: addr, value: parseEth($('sk-fund-amt').value) }); await tx.wait(); toast('Pool funded ✓', 'ok'); await loadDashboard(); }
      catch (e) { toast(pretty(e), 'err'); }
    });
    $('sk-notify') && ($('sk-notify').onclick = () => ownerSend(stk(), STAKING_ABI, 'notifyRewardAmount',
      [parseEth($('sk-notify-amt').value), BigInt(Math.round((+$('sk-notify-days').value || 0) * 86400))], 'Reward period started ✓'));
    for (let t = 0; t < 3; t++) $('sk-mult-' + t) && ($('sk-mult-' + t).onclick = () =>
      ownerSend(stk(), STAKING_ABI, 'setTierMultBps', [t, BigInt(Math.round((+$('sk-mult-in-' + t).value || 1) * 10000))], 'Lock multiplier set ✓'));
    $('sk-hold') && ($('sk-hold').onclick = () => ownerSend(stk(), STAKING_ABI, 'setHoldingTiers',
      [[0n, ethers.parseEther($('sk-h1').value || '1000000'), ethers.parseEther($('sk-h2').value || '10000000')],
       [10000n, BigInt(Math.round((+$('sk-hm1').value || 2) * 10000)), BigInt(Math.round((+$('sk-hm2').value || 3) * 10000))]], 'Holding tiers set ✓'));
    $('sk-approve') && ($('sk-approve').onclick = () => ownerSend(stk(), STAKING_ABI, 'setTokenWeight',
      [$('sk-tok').value.trim(), BigInt(Math.round((+$('sk-tokw').value || 1) * 10000))], 'Token approved ✓'));

    // ----- pact admin -----
    const pk = () => store.get('pact');
    $('pk-entry') && ($('pk-entry').onclick = () => ownerSend(pk(), PACT_ABI, 'setEntryFee', [parseEth($('pk-entry-v').value)], 'Entry fee set ✓'));
    $('pk-refund') && ($('pk-refund').onclick = () => ownerSend(pk(), PACT_ABI, 'setRefundAmount', [parseEth($('pk-refund-v').value)], 'Refund set ✓'));
    $('pk-oracle') && ($('pk-oracle').onclick = () => ownerSend(pk(), PACT_ABI, 'setOracle', [$('pk-oracle-v').value.trim()], 'Oracle set ✓'));
    $('pk-fund') && ($('pk-fund').onclick = async () => {
      if (!signer) return toast('Connect wallet first.', 'err');
      const addr = pk();
      if (!ethers.isAddress(addr)) return toast('Set a valid Pact address in Config.', 'err');
      if ((await provider.getCode(addr)) === '0x') return toast('No contract at the Pact address — check Config.', 'err');
      try { const tx = await signer.sendTransaction({ to: addr, value: parseEth($('pk-fund-v').value) }); await tx.wait(); toast('Pact treasury funded ✓', 'ok'); }
      catch (e) { toast(pretty(e), 'err'); }
    });
    $('cfg-pact') && ($('cfg-pact').value = store.get('pact'));

    // prefill whitelist
    $('in-free-addr').value = WHITELIST_DEFAULT; $('in-free-n').value = '20';
  }

  document.addEventListener('DOMContentLoaded', () => { wire(); loadDashboard(); });
})();
