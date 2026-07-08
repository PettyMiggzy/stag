# BUILD BRIEF — Robinhood Chain

> Reference for deploying $STAG contracts + minting NFTs on Robinhood Chain.
> Source: docs.robinhood.com/chain. Launched ~mid-2026 — **confirm chain IDs, RPC URLs,
> and contract addresses on the live docs before any mainnet deploy.**

## What it is

Robinhood Chain is a permissionless, EVM-compatible **Ethereum Layer 2**, built on the
**Arbitrum Orbit** stack (Arbitrum "dedicated chains" framework). It's an **optimistic rollup**
that settles to Ethereum, uses Ethereum blobs (EIP-4844) for data availability, and uses
**ETH as the native gas token** (no custom gas token). Chain focus: regulated finance, RWAs,
and 24/7 tokenized equities.

## Network config

| | Value |
|---|---|
| Mainnet Chain ID | **4663** |
| Testnet Chain ID | **46630** |
| Native currency / gas | **ETH** |
| Public RPC (mainnet) | `https://rpc.mainnet.chain.robinhood.com` |
| Public RPC (testnet) | `https://rpc.testnet.chain.robinhood.com` |
| WSS sequencer feed (mainnet) | `wss://feed.mainnet.chain.robinhood.com` |
| Block explorer | `https://robinhoodchain.blockscout.com` (Blockscout) |
| Testnet explorer | `https://explorer.testnet.chain.robinhood.com` |

## Recommended infra (production)

Public RPCs are **rate-limited — not for production.**

- Providers: **Alchemy** (primary), plus QuickNode, Blockdaemon, dRPC, Validation Cloud.
- Alchemy RPC pattern: `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`
- QuickNode pattern: `https://{ENDPOINT}.robinhood-mainnet.quiknode.pro/{TOKEN}`
- Services: Node API (JSON-RPC + WSS), Data API (indexed balances/tx/NFTs),
  Gasless Transaction infra (sponsored gas, batched tx, spending policies).

## Dev toolchain (works as-is)

- Standard EVM: Solidity/Vyper, **Hardhat or Foundry**, ethers.js / viem / wagmi.
- Deploy exactly like Arbitrum/Ethereum — just point the network config at the Robinhood Chain
  RPC + chain ID.
- Verify contracts via the Blockscout explorer.

## Constraints / gotchas to design around

- **Withdrawal delay:** L2→L1 withdrawals go through the canonical Arbitrum bridge and carry the
  standard fraud-proof challenge period (multi-day). Don't design UX assuming instant withdrawal.
- **Bridging:** use the canonical Arbitrum bridge (or supported cross-chain routes) to move assets
  on/off. (Site bridge CTA → `https://portal.arbitrum.io/bridge?...&destinationChain=robinhood-chain`.)
- **L1↔L2 messaging:** arbitrary message passing supported (Arbitrum-style retryable tickets /
  cross-chain messaging primitives).
- **Gas:** paid in ETH; there was a promotional gas-sponsorship window early post-launch — don't
  hardcode assumptions about who pays gas.
- **Rate limits:** get a provider API key before any load testing or mainnet deploy.

## $STAG relevance

- NFT mint (The Hooded 20 + future packs) deploys here — standard EVM ERC-721/1155 or an Arbitrum
  Orbit-compatible mint contract. The existing `assets/nft/stagwifhood/` metadata + manifest are
  chain-agnostic and ready to point at a Robinhood Chain collection address once deployed.
- Milestone-lottery payout logic and the bot will read holders/balances via the Node/Data API.

## TODO before mainnet (confirm on live docs)

- [ ] Confirm chain IDs + RPC URLs are still current.
- [ ] Grab system contract addresses (canonical bridge / inbox / cross-chain messaging).
- [ ] Add ready-to-paste Hardhat + Foundry network config blocks.
- [ ] Get a provider (Alchemy) API key for deploy + load testing.
