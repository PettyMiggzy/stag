/* ============================================================
   STAGWIFHOOD — site-wide GoPlus transaction guard.

   Patches the wallet provider's request() ONCE so EVERY eth_sendTransaction on
   EVERY page (mint, stake, unstake, claim, pact, locker, admin, trades…) is
   simulated by GoPlus before the user signs.

   • Injected wallets (MetaMask, Trust, SafePal, mobile in-wallet browsers) are
     auto-patched on load — nothing else to wire.
   • WalletConnect providers are separate objects created on demand, so each
     init site calls STAGGuard.wrap(provider) once.

   FAILS OPEN: no GoPlus key, scan error, or timeout → the tx proceeds normally.
   It only prompts when GoPlus AFFIRMATIVELY flags the tx as risky.
   ============================================================ */
(function () {
  var WRAPPED = '__stagGuarded';

  async function scan(tx) {
    try {
      var r = await fetch((location.origin || '') + '/api/txscan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chainId: 4663,
          from: tx.from || null,
          to: tx.to || null,
          data: tx.data || tx.input || '0x',
          value: tx.value != null ? String(tx.value) : '0',
        }),
      });
      return await r.json();
    } catch (e) { return { scanned: false }; }
  }

  // true => the user cancelled a flagged tx (block the send). Fail-open on any error.
  async function blocks(tx) {
    if (!tx || !tx.to) return false;
    var v; try { v = await scan(tx); } catch (e) { return false; }
    if (!v || !v.scanned || !v.risky) return false;
    var why = v.reasons && v.reasons.length ? '\n\n• ' + v.reasons.join('\n• ') : '';
    return !confirm('⚠️ GoPlus flagged this transaction as potentially risky:' + why + '\n\nProceed anyway?');
  }

  function wrap(provider) {
    try {
      if (!provider || provider[WRAPPED] || typeof provider.request !== 'function') return provider;
      var orig = provider.request.bind(provider);
      provider.request = async function (args) {
        try {
          if (args && args.method === 'eth_sendTransaction' && args.params && args.params[0]) {
            if (await blocks(args.params[0])) {
              var e = new Error('Transaction cancelled — GoPlus flagged it as risky.'); e.code = 4001; throw e;
            }
          }
        } catch (err) { if (err && err.code === 4001) throw err; /* scan failure => fail open */ }
        return orig(args);
      };
      try { Object.defineProperty(provider, WRAPPED, { value: true, enumerable: false }); } catch (e) { provider[WRAPPED] = true; }
    } catch (e) { /* provider not patchable (frozen) — fail open */ }
    return provider;
  }

  function wrapInjected() {
    try {
      if (!window.ethereum) return;
      if (Array.isArray(window.ethereum.providers)) window.ethereum.providers.forEach(wrap);
      wrap(window.ethereum);
    } catch (e) {}
  }

  wrapInjected();
  // wallets that inject late, or announce via EIP-6963
  window.addEventListener('ethereum#initialized', wrapInjected);
  window.addEventListener('eip6963:announceProvider', function (ev) { try { wrap(ev.detail && ev.detail.provider); } catch (e) {} });
  setTimeout(wrapInjected, 1200); setTimeout(wrapInjected, 3500);

  window.STAGGuard = { scan: scan, wrap: wrap, guard: async function (tx) { return !(await blocks(tx)); } };
})();
