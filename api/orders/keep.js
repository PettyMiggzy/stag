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

// Out-of-band fee sweeps. Swap/Market hold their 1% fee in-contract (so a user's
// signed tx never fans ETH out to the marketing wallet — that shape is what wallet
// scanners flag). These permissionless sweeps move the accrued fees to the fee wallet;
// each reverts on a zero balance, so we swallow those. STAG is the common market pay-token.
const SWAP = '0xd43d5aa252077d0Cfd2CFdCD13f9B8e85C5C1392';
const MARKET = '0x6Dfb9800864Bd483Ffe17052B28e9a50EE81B6E7';
const STAG = '0xcC142366735c882F7885d3c747db99e45E13E453';
const SWAP_ABI = ['function forwardFees()'];
const MARKET_ABI = ['function forwardFees(address token)', 'function forwardFeesEth()'];

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
    // ---- out-of-band fee sweeps (best-effort; ignore "no fees" reverts) ----
    const swept = [];
    const sweep = async (label, fn) => { try { const tx = await fn(); await tx.wait(); swept.push(label); } catch { /* no fees / raced */ } };
    const swap = new ethers.Contract(SWAP, SWAP_ABI, wallet);
    const market = new ethers.Contract(MARKET, MARKET_ABI, wallet);
    await sweep('swap.eth', () => swap.forwardFees());
    await sweep('market.eth', () => market.forwardFeesEth());
    await sweep('market.stag', () => market.forwardFees(STAG));

    res.end(JSON.stringify({ ok: true, open: ids.length, checked, filled, swept }));
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: (e && e.message) || 'error' }));
  }
};
