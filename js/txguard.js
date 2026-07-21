/* STAG tx guard — optional GoPlus pre-sign scan.
   Usage before sending a tx:
     const pt = await contract.someMethod.populateTransaction(args, { value });
     if (!(await STAGGuard.guard({ to: pt.to, data: pt.data, value, from }))) return; // user cancelled
     const tx = await contract.someMethod(args, { value });

   FAILS OPEN: if the scan is off (no GoPlus key), unavailable, or clean, guard() returns true and
   the tx proceeds. It only prompts when GoPlus affirmatively flags the tx as risky — so it never
   gets in the way of a normal mint/stake. */
(function () {
  async function scan(tx) {
    try {
      const r = await fetch((location.origin || '') + '/api/txscan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chainId: 4663,
          from: tx.from || null,
          to: tx.to,
          data: tx.data || '0x',
          value: tx.value != null ? tx.value.toString() : '0',
        }),
      });
      return await r.json();
    } catch (e) { return { scanned: false }; }
  }

  // Returns true to proceed, false only if the user cancels a flagged tx.
  async function guard(tx) {
    let v;
    try { v = await scan(tx); } catch (e) { return true; }
    if (!v || !v.scanned || !v.risky) return true; // off / clean / unavailable → proceed
    const why = v.reasons && v.reasons.length ? '\n\n• ' + v.reasons.join('\n• ') : '';
    return confirm('⚠️ GoPlus flagged this transaction as potentially risky:' + why + '\n\nProceed anyway?');
  }

  window.STAGGuard = { scan, guard };
})();
