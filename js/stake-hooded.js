/* ============================================================
   STAGWIFHOOD — Stake & Earn (StagStaking v4)
   $STAG staking with 30/60/90 lock tiers, holding multiplier,
   ETH rewards, up to 3 collector wallets. ethers v6.
   ============================================================ */
(function () {
  'use strict';
  const H = window.HOODED || {};
  const CHAIN_ID = BigInt(parseInt((H.chain && H.chain.chainId) || '0x1237', 16)); // 4663
  const $ = (id) => document.getElementById(id);
  const STAKE = () => H.staking;
  const STAG = H.stag;

  const ABI = [
    'function stakeTokens(address,uint256,uint8)',
    'function unstakeTokens(address,uint256)',
    'function claim()',
    'function setCollectors(address[],uint256[])',
    'function stakedOf(address,address) view returns (uint256)',
    'function holdMultBpsOf(address) view returns (uint256)',
    'function totalWeight() view returns (uint256)',
    'function tierInfo() view returns (uint256[3],uint256[3])',
    'function userInfo(address) view returns (uint256 baseWeight,uint256 lockMultBps,uint256 holdMult,uint256 weight,uint256 stakedAt,uint8 lockTier,uint256 unlockAt,uint256 pendingEth,uint256[] nfts,bool locked)',
  ];
  const ERC20 = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
  ];

  let provider, signer, me, tier = 0, durations = [30, 60, 90], mults = [10000, 15000, 20000];
  const ro = () => (H.readProvider ? H.readProvider() : new ethers.JsonRpcProvider(H.chain.rpcUrls[0], { name: H.chain.chainName, chainId: parseInt(H.chain.chainId, 16) }));
  const setStatus = (m, c) => { const e = $('sk-status'); if (e) { e.textContent = m; e.className = 'mint-status ' + (c || ''); } };
  async function chainOk() { try { return provider && (await provider.getNetwork()).chainId === CHAIN_ID; } catch { return false; } }
  const fmt = (v, d = 4) => { try { return (+ethers.formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: d }); } catch { return '—'; } };
  const days = (s) => Math.round(Number(s) / 86400);

  async function boot() {
    if (!STAKE() || !window.ethers) { setStatus('Staking goes live at launch — connect enabled once deployed.', ''); return; }
    try {
      const c = new ethers.Contract(STAKE(), ABI, ro());
      const ti = await c.tierInfo();
      durations = ti[0].map(days); mults = ti[1].map(Number);
      renderTiers();
      await loadStats();
      const cb = $('sk-connect'); if (cb) { cb.disabled = false; cb.onclick = connect; }
    } catch (e) { setStatus('Could not reach the staking contract yet.', ''); }
  }

  function renderTiers() {
    const wrap = $('sk-tiers'); if (!wrap) return;
    wrap.innerHTML = durations.map((d, i) =>
      `<button class="sk-tier${i === tier ? ' active' : ''}" data-t="${i}">
        <span class="sk-tier-d">${d}d</span><span class="sk-tier-m">${(mults[i] / 10000).toFixed(mults[i] % 10000 ? 1 : 0)}× rewards</span></button>`
    ).join('');
    wrap.querySelectorAll('.sk-tier').forEach((b) => b.onclick = () => { tier = +b.dataset.t; renderTiers(); previewMult(); });
  }

  async function loadStats() {
    const p = provider || ro();
    try { $('sk-pool').textContent = fmt(await p.getBalance(STAKE())) + ' Ξ'; } catch {}
    try {
      const stag = new ethers.Contract(STAG, ERC20, p);
      $('sk-total').textContent = Number(ethers.formatEther(await stag.balanceOf(STAKE()))).toLocaleString() + ' STAG';
    } catch {}
    if (me) await loadUser();
  }

  async function loadUser() {
    const p = provider || ro();
    const c = new ethers.Contract(STAKE(), ABI, p);
    try {
      const [info, staked, bal] = await Promise.all([
        c.userInfo(me), c.stakedOf(me, STAG),
        new ethers.Contract(STAG, ERC20, p).balanceOf(me),
      ]);
      $('sk-your').textContent = Number(ethers.formatEther(staked)).toLocaleString() + ' STAG';
      $('sk-claimable').textContent = fmt(info.pendingEth) + ' Ξ';
      const mult = (Number(info.lockMultBps) / 10000) * (Number(info.holdMult) / 10000);
      $('sk-mult').textContent = mult ? mult.toFixed(2).replace(/\.00$/, '') + '×' : '1×';
      const balEl = $('sk-bal'); if (balEl) balEl.textContent = 'Balance: ' + Number(ethers.formatEther(bal)).toLocaleString() + ' $STAG';
      if (Number(staked) > 0) {
        const unlock = new Date(Number(info.unlockAt) * 1000);
        $('sk-unlock').textContent = info.locked ? `Locked until ${unlock.toLocaleDateString()}` : 'Unlocked — claim/unstake anytime';
      } else $('sk-unlock').textContent = '';
    } catch (e) {}
  }

  function previewMult() {
    const holdEl = $('sk-mult');
    // preview lock tier * current hold mult text lives in loadUser; just show lock tier hint
    const hint = $('sk-preview'); if (hint) hint.textContent = `Selected: ${durations[tier]}-day lock · ${(mults[tier] / 10000)}× lock multiplier (stacks with your $STAG holding tier)`;
  }

  async function connect() {
    if (!window.ethereum) { setStatus('No EVM wallet found — install MetaMask.', 'err'); return; }
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: H.chain.chainId }] }); }
      catch (e) { if (e.code === 4902) await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [H.chain] }); }
      provider = new ethers.BrowserProvider(window.ethereum);
      if (!(await chainOk())) { signer = null; setStatus('Wrong network — switch to Robinhood Chain (4663) and reconnect.', 'err'); return; }
      signer = await provider.getSigner(); me = await signer.getAddress();
      if (window.ethereum.removeAllListeners) window.ethereum.removeAllListeners('chainChanged');
      window.ethereum.on && window.ethereum.on('chainChanged', () => { signer = null; provider = null; $('sk-connect').textContent = 'Connect Wallet'; setStatus('Network changed — reconnect on Robinhood Chain.', 'err'); });
      $('sk-connect').textContent = me.slice(0, 6) + '…' + me.slice(-4);
      ['sk-stake', 'sk-unstake', 'sk-claim', 'sk-setcol'].forEach((id) => { const b = $(id); if (b) b.disabled = false; });
      setStatus('Wallet connected.', 'ok');
      await loadStats();
    } catch (e) { setStatus(pretty(e), 'err'); }
  }

  function pretty(e) {
    const m = (e && (e.shortMessage || e.reason || e.info?.error?.message || e.message)) || 'error';
    if (/user rejected|4001|denied/i.test(m)) return 'Cancelled in wallet.';
    if (/locked/i.test(m)) return 'Still locked — claim/unstake after the lock ends (early unstake = 15% + forfeit).';
    if (/insufficient/i.test(m)) return 'Not enough balance / gas.';
    return String(m).slice(0, 160);
  }

  async function tx(run, okMsg) {
    if (!signer) return connect();
    if (!(await chainOk())) return setStatus('Wrong network — switch to Robinhood Chain (4663).', 'err');
    try { const t = await run(); setStatus('Confirming…'); await t.wait(); setStatus(okMsg, 'ok'); await loadStats(); }
    catch (e) { setStatus(pretty(e), 'err'); }
  }

  async function stake() {
    const amtStr = ($('sk-amount').value || '').trim();
    if (!amtStr || +amtStr <= 0) return setStatus('Enter an amount to stake.', 'err');
    const amount = ethers.parseEther(amtStr);
    const stag = new ethers.Contract(STAG, ERC20, signer);
    const allowance = await stag.allowance(me, STAKE());
    if (allowance < amount) {
      setStatus('Approve $STAG spending…');
      try { await (await stag.approve(STAKE(), amount)).wait(); } catch (e) { return setStatus(pretty(e), 'err'); }
    }
    const c = new ethers.Contract(STAKE(), ABI, signer);
    await tx(() => c.stakeTokens(STAG, amount, tier), `Staked ${amtStr} $STAG for ${durations[tier]} days ✓`);
  }
  async function unstake() {
    const staked = await new ethers.Contract(STAKE(), ABI, provider).stakedOf(me, STAG);
    if (staked === 0n) return setStatus('Nothing staked.', 'err');
    const c = new ethers.Contract(STAKE(), ABI, signer);
    await tx(() => c.unstakeTokens(STAG, staked), 'Unstaked ✓');
  }
  async function claim() {
    const c = new ethers.Contract(STAKE(), ABI, signer);
    await tx(() => c.claim(), 'Rewards claimed ✓');
  }
  async function setCollectors() {
    const rows = [1, 2, 3].map((i) => ({ a: ($('col-a' + i).value || '').trim(), b: ($('col-b' + i).value || '').trim() }))
      .filter((r) => r.a && r.b);
    const wallets = rows.map((r) => r.a), bps = rows.map((r) => Math.round(+r.b * 100)); // % -> bps
    if (!wallets.every((w) => ethers.isAddress(w))) return setStatus('One of the collector addresses is invalid.', 'err');
    if (bps.reduce((s, x) => s + x, 0) > 10000) return setStatus('Collector shares add up to more than 100%.', 'err');
    const c = new ethers.Contract(STAKE(), ABI, signer);
    await tx(() => c.setCollectors(wallets, bps), 'Collector wallets saved ✓');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const bind = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    bind('sk-stake', stake); bind('sk-unstake', unstake); bind('sk-claim', claim); bind('sk-setcol', setCollectors);
    const max = $('sk-max'); if (max) max.onclick = async () => {
      if (!me) return; const bal = await new ethers.Contract(STAG, ERC20, ro()).balanceOf(me);
      $('sk-amount').value = ethers.formatEther(bal);
    };
    renderTiers(); previewMult(); // show tiers with defaults immediately
    boot();
  });
})();
