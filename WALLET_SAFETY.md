# Wallet-scanner safety (MetaMask/Blockaid · Phantom/Blowfish)

Wallet scanners domain-block a dApp the instant a signed transaction looks like a **drainer** —
most commonly, one user-signed tx that fans funds out to multiple/unknown wallets, or grants an
approval/authority. A block hits the whole domain at "Connect" and kills every conversion. MetaMask
uses **Blockaid**; Phantom uses **Blowfish**; both apply the same heuristics. This is how The Hooded 20
is built to stay clean.

## The golden rule
**Every user-signed transaction is ONE obvious, legible action.** If a human reading the wallet
simulation can't instantly tell what it does, the scanner blocks it.

## How each signed action is shaped

| User action | Signed tx does | Why it's clean |
|---|---|---|
| **Mint (pick / gamble)** | `mintPick`/`mintRandom` — pay EXACT price to the NFT contract, receive 1 NFT. **No ETH fan-out.** | Single recipient (the contract you're minting from). The 90/10 split is moved OUT of the user tx (see below). |
| **Stake** | `approve(staking, exactAmount)` then `stakeTokens` | **Exact-amount** approval (never infinite/unbounded), to the known staking contract. Two legible steps. |
| **Claim** | `claim` — ETH to you (and to collector wallets **you** configured) | You are the recipient / you set the split. No unknown-wallet transfer. |
| **Unstake** | `unstakeTokens` — tokens back to you (minus a fixed penalty if early) | You are the primary recipient; not a drain. |
| **Pact** | `createPact` pays one contract; `claim`/`reclaim` pay you | Single-recipient, legible. |

## The key fix — proceeds split is OUT-OF-BAND
`_mintOne` deliberately keeps proceeds in the NFT contract. There is **no `splitter.call` inside the
signed mint tx**, so a mint never shows ETH going to the pool *and* the owner (a multi-recipient
"drainer" shape). The 90/10 split runs later via **`forwardProceeds()`** — permissionless, called by a
keeper/cron or the `/admin` "Forward" button. Not user-signed, so a multi-recipient transfer there is fine.

## Other rules we follow
- **Exact price on mint** (`require(msg.value == due)`) → no refund leg, so the tx has *zero* outgoing
  transfers. The frontend reads `priceOf`/`randomPrice` on-chain and sends exactly that.
- **Exact-amount ERC-20 approvals** for staking — never `MaxUint256`. (`stake-hooded.js` approves only
  `amount` when allowance is short.)
- **No `approve`/`setApprovalForAll`/delegate/authority** instructions anywhere in a user flow. NFT
  staking is lock-in-place (ERC-5192) — no `setApprovalForAll`, no custody transfer.
- **Simulate before signing** — the frontend runs `estimateGas` as a pre-flight on every write; wallets
  also simulate client-side and will show one clean action.
- **No RPC key exposure, with a paid backup.** Browser reads hit the **free public** Robinhood Chain
  RPC first (no key), and fall back to **`/api/rpc`** — a serverless proxy that uses the **paid Alchemy
  RPC** (`ALCHEMY_RPC_URL` env var, server-side only, never shipped to the browser). Reads only; writes
  go through the user's wallet on the public RPC. The proxy allowlists read methods, caches, and checks
  Origin so it can't be used as an open relay or to burn quota. **Set `ALCHEMY_RPC_URL` in the stag
  Vercel project** to enable the backup (it no-ops to public if unset).

## If you ever get flagged anyway
1. Remove the offending pattern and redeploy — Blockaid/Blowfish auto-re-scan and usually clear.
2. **Verify domain ownership** in the wallet's portal (MetaMask/Blockaid report form; Phantom Portal) —
   this both clears false positives and builds standing trust that prevents future blocks.
3. Keep the mint/stake pages on the primary domain so the verified-domain trust applies.
