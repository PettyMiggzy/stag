/* ============================================================
   SherwoodOrders keeper — fills triggered limit / take-profit orders.

   For every open order it STATICCALLs execute(id): if that doesn't revert,
   the order is fillable right now (Uniswap can meet the maker's minOut), so it
   sends the real execute() tx from the keeper wallet. No price math, fully
   trustless — the contract's own minOut is the judge; the keeper only pays gas.

   ENV: KEEPER_KEY (funded wallet, gas only), CRON_SECRET (guards this endpoint).
   Cron: hit /api/orders/keep every ~1 min.
   ============================================================ */
'use strict';
const { ethers } = require('ethers');

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const ORDERS = '0x689988a1adB3Da7554Ba1fFc256904498aaF1F54';
const ABI = [
  'function openOrders(uint256 start,uint256 limit) view returns (uint256[])',
  'function execute(uint256 id) returns (uint256)',
];
const MAX_FILLS = 8;   // cap per run so one invocation can't run long

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const secret = process.env.CRON_SECRET;
  const key = (req.query && req.query.key) || '';
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || (key !== secret && bearer !== secret)) { res.statusCode = 401; res.end(JSON.stringify({ error: 'unauthorized' })); return; }
  if (!process.env.KEEPER_KEY) { res.statusCode = 500; res.end(JSON.stringify({ error: 'KEEPER_KEY not set' })); return; }

  try {
    const provider = new ethers.JsonRpcProvider(RPC, { chainId: 4663, name: 'rh' }, { staticNetwork: true });
    const wallet = new ethers.Wallet(process.env.KEEPER_KEY, provider);
    const c = new ethers.Contract(ORDERS, ABI, wallet);

    const ids = await c.openOrders(0, 300);
    const filled = [];
    let checked = 0;
    for (const id of ids) {
      if (filled.length >= MAX_FILLS) break;
      checked++;
      // is it fillable now? staticCall reverts if minOut can't be met
      try { await c.execute.staticCall(id); } catch { continue; }
      // fillable -> send the real tx
      try { const tx = await c.execute(id); await tx.wait(); filled.push(Number(id)); }
      catch (e) { /* another keeper/tx beat us, or transient — skip */ }
    }
    res.end(JSON.stringify({ ok: true, open: ids.length, checked, filled }));
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: (e && e.message) || 'error' }));
  }
};
