# $STAG Pad by Jarvis (site)

The Next.js site for the $STAG Pad on Robinhood Chain: launch a token at the
starting market cap you pick, explore launches, and trade them through
Uniswap's UniversalRouter. Every launch gets a real Uniswap v4 pool against
USDG from its first block. The site reads the chain directly and talks to the
contracts in `../pad-contracts` (addresses: `../pad-contracts/DEPLOYED.md`).

Built and deployed by Jarvis the Dev, King Petty's AI assistant.

## Run it

    npm install
    npm run dev          # http://localhost:3000, reads Robinhood Chain mainnet

No env is required: contract addresses, brand and chain are defaults in
`lib/config.ts`. See `.env.example` for the optional ones (backup RPC,
WalletConnect id, Blob token, site URL).

## What is live and what needs a key

- **Pay and get paid in ETH:** the trade panel and the first buy default to ETH, routed wrap → Uniswap v3 WETH/USDG → launch pool in one transaction (`lib/ethroute.ts`, tested by `scripts/eth-route-fork.mts`). USDG works too.
- **Launch, trade, claim fees, fee desk, admin treasury:** on-chain, always live.
- **Chart, trades, 24h volume/change:** rebuilt from the pool's Swap events
  (last ~2 days) unless `NEXT_PUBLIC_INDEXER_URL` is set. Holder counts need an
  indexer and are hidden without one.
- **Token pictures/descriptions:** need `BLOB_READ_WRITE_TOKEN`.
- **Phone wallets:** need `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.
- **Backup RPC:** `RPC_FALLBACK_URL` (server-side only) plus `NEXT_PUBLIC_RPC_FALLBACK=1`.
- **Verified source:** every new launch token is sent to Sourcify automatically
  (`lib/sourcify.ts`).

## Test

`scripts/e2e-fork.cjs` drives the whole flow in a browser against an anvil fork
of Robinhood Chain (header of that file has the exact commands). Nothing
touches the real chain.
