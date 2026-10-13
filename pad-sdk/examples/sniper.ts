// Buys every new launch the block it appears. Run: PRIVATE_KEY=0x... npx tsx examples/sniper.ts
// Env: BUY_ETH (default 0.005), MAX_BUY_TAX_PCT (skip launches taxing buys above this, default 10)
import { createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPad, chain, ADDRESSES } from '../src/index.js';

const pad = createPad();
const wallet = createWalletClient({ account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`), chain, transport: http(ADDRESSES.rpcUrl) });
const buyEth = parseEther(process.env.BUY_ETH ?? '0.005');
const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_PCT ?? 10) * 100;

console.log('watching for launches as', wallet.account.address);
pad.watchLaunches(async (l) => {
  console.log(`new launch ${l.symbol} ${l.token}  buy tax ${l.buyTaxBps / 100}%  sell tax ${l.sellTaxBps / 100}%`);
  if (l.buyTaxBps > maxBuyTaxBps) return console.log('  skipped: buy tax too high');
  try {
    const hash = await pad.buyWithEth(wallet, l.token, buyEth, { slippageBps: 500 });
    console.log('  bought:', hash);
  } catch (e) { console.log('  failed:', (e as Error).message.split('\n')[0]); }
});
