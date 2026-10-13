# stag-pad-sdk

Trade and snipe **$STAG Pad** launches on Robinhood Chain (chain 4663) from a script or bot.
Built on [viem](https://viem.sh). Buy and sell with **ETH or USDG** in a single transaction.

Bots and snipers are welcome: this is the same route the website uses, and the SDK is the
easy way to do it.

    npm install viem            # then copy src/index.ts, or: npm install ./pad-sdk

```ts
import { createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPad, chain } from 'stag-pad-sdk';

const pad = createPad();                                   // free public RPC by default; createPad({ rpcUrl })
const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain, transport: http() });

pad.watchLaunches(async (l) => {                           // fires the block a launch is mined
  console.log(l.symbol, l.token, `buy tax ${l.buyTaxBps / 100}%`);
  await pad.buyWithEth(wallet, l.token, parseEther('0.005'), { slippageBps: 500 });
});
```

## API

| call | what it does |
| --- | --- |
| `pad.watchLaunches(cb)` | Live feed of new launches (`token, creator, name, symbol, buyTaxBps, sellTaxBps, poolId, ...`). Returns an unsubscribe function. |
| `pad.launches(fromBlock?)` | Every past launch from the main pad, scanned in 100k-block chunks. |
| `pad.price(token)` | Current price in USDG, read from the pool. |
| `pad.quoteBuyWithEth(token, wei)` / `quoteBuyWithUsdg` | Exact tokens out from the live pools, tax and fees included. |
| `pad.quoteSellForEth(token, tokens)` / `quoteSellForUsdg` | Exact ETH / USDG out. |
| `pad.buyWithEth(wallet, token, wei, opts)` | Wrap ETH, swap WETH to USDG (Uniswap v3 0.01% pool), swap USDG to the token (v4). One tx, no approvals. |
| `pad.sellForEth(wallet, token, tokens, opts)` | Token to USDG to WETH, unwrapped to ETH in your wallet. Approves the router first if needed. |
| `pad.buyWithUsdg` / `pad.sellForUsdg` | Same, paying and receiving USDG. |

Options: `slippageBps` (default 100 = 1%), `deadlineSec` (default 120). For the fastest snipes skip the
quote by passing `minTokensOut` and `minUsdg` to `buyWithEth` (or `minEthOut` to `sellForEth`).

## Good to know

- **Tax is enforced by the pool, not the site.** Every launch pool is a Uniswap v4 pool with the pad's hook,
  so the creator's buy/sell tax applies to every swap: this SDK, the website, or your own contract calling the
  PoolManager. There is no path around it. `buyTaxBps` / `sellTaxBps` are in the launch event; factor them in.
- **First trade.** Every launch pool opens with all 1,000,000,000 tokens as one-sided liquidity above the
  opening price, so you can buy from the first block. Selling only works once someone has bought (the pool
  needs USDG in it); quotes return `0` until then.
- **Gas is ETH.** Robinhood Chain blocks are fast (~10/s). Use a good RPC for sniping (`createPad({ rpcUrl })`).
- **Addresses** are exported as `ADDRESSES` and listed in `../pad-contracts/DEPLOYED.md`.
- **No API key, no fees from us.** The SDK talks to the chain and Uniswap's contracts directly.
- Not financial advice; launches are unaudited-token code written by anyone. Check the tax before you buy.

## Examples and tests

- `examples/sniper.ts`: buys every new launch (env `BUY_ETH`, `MAX_BUY_TAX_PCT`).
- `examples/trade.ts`: quote, buy, sell one token.
- `test-fork.ts`: runs the whole thing against an anvil fork of the chain.
