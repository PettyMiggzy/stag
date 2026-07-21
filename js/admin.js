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
  const H = () => window.HOODED || {};
  const ADDR = {
    mint: () => store.get('mint') || H().mint || '',
    staking: () => store.get('staking') || H().staking || '',
    splitter: () => store.get('splitter') || H().splitter || '',
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
    'function setTierDuration(uint8,uint256)',
    'function setHoldingTiers(uint256[],uint256[])',
    'function setTokenWeight(address,uint256)',
    'function setEarlyPenaltyBps(uint256)',
  ];
  const VAULT_ABI = [
    'function owner() view returns (address)',
    'function totalWeight() view returns (uint256)',
    'function reserved() view returns (uint256)',
    'function collectionsCount() view returns (uint256)',
    'function notifyRewardAmount(uint256,uint256)',
    'function addCollection(address,uint256,bool)',
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
    'function verify(uint256,bool,uint256)',
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

    // Sherwood Vault pool balance (hint next to the vault card)
    const vault = store.get('vault') || (window.HOODED && window.HOODED.vault) || '';
    if ($('vt-bal') && ethers.isAddress(vault)) { try { $('vt-bal').textContent = '· pool: ' + fmt(await p.getBalance(vault)) + ' ETH'; } catch {} }

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
  let wcProvider = null;
  // Resolve a provider: injected first (extension / wallet in-app browser), else WalletConnect for mobile.
  async function resolveProvider() {
    if (window.ethereum) return window.ethereum;
    const pid = (window.HOODED && window.HOODED.walletConnectProjectId) || '';
    if (!pid) { toast('Open /admin inside your wallet’s browser (SafePal → Browser, or MetaMask → Browser) to connect.', 'err'); return null; }
    try {
      const { EthereumProvider } = await import('https://esm.sh/@walletconnect/ethereum-provider@2.17.2');
      const cid = Number(CHAIN_ID);
      wcProvider = await EthereumProvider.init({
        projectId: pid, optionalChains: [cid], rpcMap: { [cid]: CHAIN.rpcUrls[0] }, showQrModal: true,
        metadata: { name: 'STAGWIFHOOD Admin', description: 'Owner controls', url: 'https://stagwifhood.fun', icons: ['https://stagwifhood.fun/assets/img/mark.png'] },
      });
      try{ window.STAGGuard && STAGGuard.wrap(wcProvider); }catch(e){}
      await wcProvider.enable();
      return wcProvider;
    } catch (e) { toast('Couldn’t open WalletConnect. Easiest: open /admin inside your wallet’s own browser.', 'err'); return null; }
  }
  async function connect() {
    const eth = await resolveProvider(); if (!eth) return;
    try {
      await eth.request({ method: 'eth_requestAccounts' });
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] }); }
      catch (e) { try { await eth.request({ method: 'wallet_addEthereumChain', params: [CHAIN] });
                       await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] }); } catch (_) {} }
      provider = new ethers.BrowserProvider(eth);
      if ((await provider.getNetwork()).chainId !== CHAIN_ID) { signer = null; toast('Wrong network — switch to Robinhood Chain (4663) and reconnect.', 'err'); return; }
      signer = await provider.getSigner();
      me = (await signer.getAddress());
      if (eth.removeAllListeners) eth.removeAllListeners('chainChanged');
      eth.on && eth.on('chainChanged', () => { signer = null; provider = null; isOwner = false; $('btn-connect').textContent = 'Connect Wallet'; toast('Network changed — reconnect on Robinhood Chain.', 'err'); });
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

    // ---- Sherwood Saints mint controls ----
    const SAINTS = () => store.get('saints') || (window.HOODED && window.HOODED.saints) || '';
    const SAINTS_ABI = ['function grantFreeMints(address,uint256)', 'function setMintPrice(uint256)', 'function setMintActive(bool)', 'function forwardProceeds()'];
    $('btn-saint-free') && ($('btn-saint-free').onclick = () => ownerSend(SAINTS(), SAINTS_ABI, 'grantFreeMints', [$('in-saint-free-addr').value.trim(), BigInt($('in-saint-free-n').value || '1')], 'Free Saint granted ✓'));
    $('btn-saint-price') && ($('btn-saint-price').onclick = () => ownerSend(SAINTS(), SAINTS_ABI, 'setMintPrice', [parseEth($('in-saint-price').value)], 'Saints price set ✓'));
    $('btn-saint-on') && ($('btn-saint-on').onclick = () => ownerSend(SAINTS(), SAINTS_ABI, 'setMintActive', [true], 'Saints mint opened ✓'));
    $('btn-saint-off') && ($('btn-saint-off').onclick = () => ownerSend(SAINTS(), SAINTS_ABI, 'setMintActive', [false], 'Saints mint paused ✓'));
    $('btn-saint-forward') && ($('btn-saint-forward').onclick = () => ownerSend(SAINTS(), SAINTS_ABI, 'forwardProceeds', [], 'Saints sales forwarded → burn / pool / team ✓'));

    // ---- Burn $STAG (send to the dead address) ----
    const DEAD = '0x000000000000000000000000000000000000dEaD';
    const STAGADDR = () => (window.HOODED && window.HOODED.stag) || '0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49';
    const STAG_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
    async function loadBurnStats() {
      try {
        const c = new ethers.Contract(STAGADDR(), STAG_ABI, new ethers.JsonRpcProvider(CHAIN.rpcUrls[0], CHAIN_ID, { staticNetwork: true }));
        const dec = await c.decimals().catch(() => 18);
        const tot = await c.balanceOf(DEAD);
        const te = $('burn-total'); if (te) te.textContent = '· ' + Number(ethers.formatUnits(tot, dec)).toLocaleString() + ' burned so far';
        if (me) { const mb = await c.balanceOf(me); const be = $('burn-bal'); if (be) be.textContent = Number(ethers.formatUnits(mb, dec)).toLocaleString() + ' $STAG'; }
      } catch (e) {}
    }
    $('btn-burn') && ($('btn-burn').onclick = async () => {
      if (!signer) return toast('Connect your wallet first.', 'err');
      const amtStr = ($('in-burn-amt').value || '').trim();
      if (!amtStr || +amtStr <= 0) return toast('Enter an amount of $STAG to burn.', 'err');
      try {
        const c = new ethers.Contract(STAGADDR(), STAG_ABI, signer);
        const dec = await c.decimals().catch(() => 18);
        const amt = ethers.parseUnits(amtStr, dec);
        if ((await c.balanceOf(me)) < amt) return toast('Not enough $STAG in your wallet to burn that much.', 'err');
        if (!confirm('Burn ' + (+amtStr).toLocaleString() + ' $STAG? This is PERMANENT and cannot be undone.')) return;
        toast('Confirm the burn in your wallet…');
        const tx = await c.transfer(DEAD, amt);
        toast('Submitted — waiting for confirmation…');
        await tx.wait();
        toast('🔥 Burned ' + (+amtStr).toLocaleString() + ' $STAG — gone forever.', 'ok');
        $('in-burn-amt').value = '';
        loadBurnStats();
      } catch (e) { toast(pretty(e), 'err'); }
    });
    loadBurnStats();

    // ---- Fund all pools evenly (Stag Staking + Sherwood Vault) ----
    // Canonical reward pools, deduped so we never fund the same address twice.
    // Each entry is {name, addr}; a stale/duplicate override can't collapse two pools onto one.
    const POOLS = () => {
      const vaultAddr = store.get('vault') || (window.HOODED && window.HOODED.vault) || '';
      const raw = [{ name: 'Stag Staking', addr: ADDR.staking() }, { name: 'Sherwood Vault', addr: vaultAddr }];
      const seen = new Set(), out = [];
      for (const p of raw) {
        if (!ethers.isAddress(p.addr)) continue;
        const k = p.addr.toLowerCase();
        if (seen.has(k)) continue;           // drop duplicates — the bug that sent both halves to Staking
        seen.add(k); out.push(p);
      }
      return out;
    };
    $('btn-poolfund') && ($('btn-poolfund').onclick = async () => {
      if (!signer) return toast('Connect your wallet first.', 'err');
      const amtStr = ($('in-poolfund-amt').value || '').trim();
      if (!amtStr || +amtStr <= 0) return toast('Enter a total ETH amount.', 'err');
      const pools = POOLS();
      if (!pools.length) return toast('No pool addresses configured.', 'err');
      // Verify each pool is a real, distinct contract before touching funds.
      for (const pl of pools) {
        try { if ((await provider.getCode(pl.addr)) === '0x') return toast('No contract at ' + pl.name + ' (' + pl.addr.slice(0, 8) + '…) — check Config.', 'err'); }
        catch (e) { return toast('Could not verify ' + pl.name + ' on-chain. Try again.', 'err'); }
      }
      const daysStr = ($('in-poolfund-days').value || '').trim();
      const total = parseEth(amtStr), each = total / BigInt(pools.length);
      const dur = daysStr && +daysStr > 0 ? BigInt(Math.round(+daysStr * 86400)) : 0n;
      const eachEth = ethers.formatEther(each);
      // Show EXACTLY what's about to happen — distinct pools, amounts, and whether it pays out.
      const plan = pools.map((pl) => '  • ' + pl.name + ' (' + pl.addr.slice(0, 6) + '…' + pl.addr.slice(-4) + ') — ' + eachEth + ' Ξ').join('\n');
      const payLine = dur > 0n
        ? '\nStream: ' + daysStr + ' days → stakers start earning immediately.'
        : '\n⚠ No days entered — this only PARKS the ETH. Nobody gets paid until you set a days value. Continue anyway?';
      if (!confirm('Fund ' + pools.length + ' pool(s) with ' + amtStr + ' Ξ total:\n\n' + plan + '\n' + payLine)) return;
      const DON = ['function donate() payable'], NOT = ['function notifyRewardAmount(uint256,uint256)'];
      try {
        for (const pl of pools) {
          toast('Funding ' + pl.name + '… confirm in wallet');
          await (await new ethers.Contract(pl.addr, DON, signer).donate({ value: each })).wait();
          if (dur > 0n) { toast('Starting stream on ' + pl.name + '…');
            await (await new ethers.Contract(pl.addr, NOT, signer).notifyRewardAmount(each, dur)).wait(); }
        }
        toast('✓ Split ' + amtStr + ' Ξ across ' + pools.map((p) => p.name).join(' + ') + (dur > 0n ? ' — now streaming' : ' — parked (set days to pay out)'), 'ok');
        loadDashboard();
      } catch (e) { toast(pretty(e), 'err'); }
    });
    // live pool balances hint
    (async () => { try { const el = $('pf-bal'); if (!el) return;
      const p = new ethers.JsonRpcProvider(CHAIN.rpcUrls[0], CHAIN_ID, { staticNetwork: true });
      const bals = await Promise.all(POOLS().map((pl) => p.getBalance(pl.addr).catch(() => 0n)));
      el.textContent = '· pools hold ' + bals.reduce((s, b) => s + Number(ethers.formatEther(b)), 0).toFixed(4) + ' ETH'; } catch (e) {} })();

    // show unswept Saints sales sitting in the contract
    (async () => { try { const s = SAINTS(); const el = $('saint-bal'); if (!s || !el) return;
      const b = await new ethers.JsonRpcProvider(CHAIN.rpcUrls[0], CHAIN_ID, { staticNetwork: true }).getBalance(s);
      el.textContent = '· ' + (+ethers.formatEther(b)).toFixed(4) + ' ETH unswept'; } catch (e) {} })();

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
    const stk = () => ADDR.staking(); // falls back to window.HOODED.staking when Config was never saved to this browser
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

    // ----- Sherwood Vault (NFT staking) -----
    const vlt = () => store.get('vault') || (window.HOODED && window.HOODED.vault) || '';
    $('vt-fund') && ($('vt-fund').onclick = async () => {
      if (!signer) return toast('Connect wallet first.', 'err');
      const addr = vlt();
      if (!ethers.isAddress(addr)) return toast('Vault address not set.', 'err');
      if ((await provider.getCode(addr)) === '0x') return toast('No contract at the vault address.', 'err');
      try { const tx = await signer.sendTransaction({ to: addr, value: parseEth($('vt-fund-amt').value) }); await tx.wait(); toast('Vault pool funded ✓', 'ok'); await loadDashboard(); }
      catch (e) { toast(pretty(e), 'err'); }
    });
    $('vt-notify') && ($('vt-notify').onclick = () => ownerSend(vlt(), VAULT_ABI, 'notifyRewardAmount',
      [parseEth($('vt-notify-amt').value), BigInt(Math.round((+$('vt-notify-days').value || 0) * 86400))], 'Vault reward stream started ✓'));
    $('vt-col') && ($('vt-col').onclick = () => ownerSend(vlt(), VAULT_ABI, 'addCollection',
      [$('vt-col-addr').value.trim(), BigInt($('vt-col-w').value || '10000') * (10n ** 18n), !!$('vt-col-lip').checked], 'Collection added ✓'));
    for (let t = 0; t < 3; t++) $('sk-mult-' + t) && ($('sk-mult-' + t).onclick = () =>
      ownerSend(stk(), STAKING_ABI, 'setTierMultBps', [t, BigInt(Math.round((+$('sk-mult-in-' + t).value || 1) * 10000))], 'Lock multiplier set ✓'));
    // Lock period per tier (days -> seconds). Contract floor is 1h, ceiling 365d.
    for (let t = 0; t < 3; t++) $('sk-dur-' + t) && ($('sk-dur-' + t).onclick = () => {
      const days = +$('sk-dur-in-' + t).value;
      if (!(days > 0)) return toast('Enter a lock period in days.', 'err');
      const secs = Math.round(days * 86400);
      if (secs < 3600) return toast('Minimum lock period is 1 hour (≈0.05 days).', 'err');
      if (secs > 365 * 86400) return toast('Maximum lock period is 365 days.', 'err');
      ownerSend(stk(), STAKING_ABI, 'setTierDuration', [t, BigInt(secs)], `Tier ${t + 1} lock set to ${days} day${days === 1 ? '' : 's'} ✓`);
    });
    // Early-unstake penalty (% -> bps, contract max 30%).
    $('sk-pen-set') && ($('sk-pen-set').onclick = () => {
      const pct = +$('sk-pen').value;
      if (!(pct >= 0)) return toast('Enter a penalty percent (0–30).', 'err');
      if (pct > 30) return toast('Max penalty is 30%.', 'err');
      ownerSend(stk(), STAKING_ABI, 'setEarlyPenaltyBps', [BigInt(Math.round(pct * 100))], `Early penalty set to ${pct}% ✓`);
    });
    // One-click migration exit: unlock all tiers (1h floor) + zero the penalty. 4 sequential txns.
    $('sk-openexit') && ($('sk-openexit').onclick = async () => {
      if (!confirm('Open penalty-free exit?\n\nThis sets ALL three lock periods to 1 hour and the early-unstake penalty to 0%, so every current staker can withdraw full principal + rewards. You will confirm 4 transactions.')) return;
      await ownerSend(stk(), STAKING_ABI, 'setTierDuration', [0n, 3600n], 'Tier 1 unlocked ✓');
      await ownerSend(stk(), STAKING_ABI, 'setTierDuration', [1n, 3600n], 'Tier 2 unlocked ✓');
      await ownerSend(stk(), STAKING_ABI, 'setTierDuration', [2n, 3600n], 'Tier 3 unlocked ✓');
      await ownerSend(stk(), STAKING_ABI, 'setEarlyPenaltyBps', [0n], 'Penalty zeroed — exit is open ✓');
      toast('Penalty-free exit is live. Stakers can unstake with no penalty.', 'ok');
    });
    $('sk-hold') && ($('sk-hold').onclick = () => ownerSend(stk(), STAKING_ABI, 'setHoldingTiers',
      [[0n, ethers.parseEther($('sk-h1').value || '1000000'), ethers.parseEther($('sk-h2').value || '10000000')],
       [10000n, BigInt(Math.round((+$('sk-hm1').value || 2) * 10000)), BigInt(Math.round((+$('sk-hm2').value || 3) * 10000))]], 'Holding tiers set ✓'));
    $('sk-approve') && ($('sk-approve').onclick = () => ownerSend(stk(), STAKING_ABI, 'setTokenWeight',
      [$('sk-tok').value.trim(), BigInt(Math.round((+$('sk-tokw').value || 1) * 10000))], 'Token approved ✓'));
    // Whitelist a stakeable token: set weight on-chain AND add it to the site's stake picker.
    $('wl-tok') && ($('wl-tok').onclick = async () => {
      const addr = ($('wl-tok-addr').value || '').trim();
      const sym = ($('wl-tok-sym').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      const dec = parseInt($('wl-tok-dec').value || '18', 10);
      const w = BigInt(Math.round(+($('wl-tok-w').value || '20000')));
      if (!ethers.isAddress(addr)) return toast('Enter a valid token address.', 'err');
      if (!sym) return toast('Enter a token symbol.', 'err');
      if (!(w > 0n && w <= 100000n)) return toast('Weight must be 1–100000 bps.', 'err');
      await ownerSend(stk(), STAKING_ABI, 'setTokenWeight', [addr, w], `Whitelisted $${sym} on-chain ✓`);
      // add to the browser token list the stake page reads (merge, dedupe by address)
      try {
        const base = (window.HOODED && window.HOODED.stakeTokens) ? window.HOODED.stakeTokens.slice() : [];
        const list = base.filter((t) => t.address.toLowerCase() !== addr.toLowerCase());
        list.push({ address: addr, symbol: sym, decimals: isNaN(dec) ? 18 : dec });
        localStorage.setItem('h20_stakeTokens', JSON.stringify(list));
        toast(`$${sym} added to the stake picker (this browser). Deploy it in hooded-config.js to show for everyone.`, 'ok');
      } catch (e) { toast('Set on-chain, but could not update the local picker: ' + e.message, 'err'); }
    });

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
    $('pk-verify') && ($('pk-verify').onclick = () => {
      const id = ($('pk-vid').value || '').trim();
      if (id === '' || isNaN(+id)) return toast('Enter a pact ID.', 'err');
      const held = !!($('pk-vheld') && $('pk-vheld').checked);
      const reward = held ? parseEth($('pk-vreward').value || '0') : 0n;
      ownerSend(pk(), PACT_ABI, 'verify', [BigInt(id), held, reward], held ? 'Pact verified — payout ready to claim ✓' : 'Pact forfeited ✓');
    });
    $('cfg-pact') && ($('cfg-pact').value = store.get('pact'));

    // prefill whitelist
    $('in-free-addr').value = WHITELIST_DEFAULT; $('in-free-n').value = '20';
  }

  document.addEventListener('DOMContentLoaded', () => { wire(); loadDashboard(); });
})();
