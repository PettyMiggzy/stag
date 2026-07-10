# STAGWIFHOOD — Contract Deploy Guide (Robinhood Chain)

Robinhood Chain is **permissionless** — deploy directly with Remix/Foundry/Hardhat,
no approval. **Deploy + test on testnet (chainId 46630) first, then mainnet (4663).**
You deploy from your own wallet (keys stay with you). Send me the deployed addresses
and I'll flip the site's mint + stake pages live.

| | |
|---|---|
| $STAG (18 decimals) | `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49` |
| Your wallet (owner + dev, gets 40%) | `0xece5d15e567c801c835029a49b2e4067b0eb63aa` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Chain ID | 4663 (0x1237) mainnet · 46630 (0xB626) testnet |
| Explorer | `https://robinhoodchain.blockscout.com` |

## Economics (as configured)
- **Mint paid in native ETH.** Proceeds → RevenueSplitter → **60% to the staking pool,
  40% to your wallet.**
- **Stakers earn ETH** (real yield) from that 60%. Owner streams it via `notifyRewardAmount`.
- Stake **approved Robinhood-Chain tokens and/or Hooded 20 NFTs**. **$STAG counts 2×**;
  other owner-approved tokens 1× (or whatever weight you set). NFTs **boost** your weight
  (rarity-weighted). **Staking only NFTs (no tokens) earns nothing.**
  ⚠️ Tokens are an owner-approved list on purpose — accepting *any* token by raw amount is a
  drain vector. You enable the ones you want to support.
- **NFT staking is lock-in-place** — the NFT stays in your wallet, just can't be sold while
  staked (no custody, no `setApprovalForAll`).
- **Early unstake** (before the 7-day lock, tunable): tokens → **15% penalty + forfeit
  rewards**; NFTs → **forfeit rewards** (no penalty, you keep the NFT).

---

## Deploy order (breaks the circular refs)

**1. `HoodedTwenty` (the lockable NFT)** — deploy with splitter = `0x0` for now:
- `_price`: mint fee in wei (e.g. `0.01 ETH` = `10000000000000000`; `0` = free)
- `baseURI_`: `https://stagwifhood.fun/assets/nft/stagwifhood/metadata/`
- `_splitter`: `0x0000000000000000000000000000000000000000` (set in step 4)
- `royaltyBps`: e.g. `500` (5%)

**2. `StagStaking`** —
- `_stag`: `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49`
- `_hood`: the HoodedTwenty address from step 1

**3. `RevenueSplitter`** —
- `_pool`: the **StagStaking** address from step 2 (the pool gets 60%)
- `_owner`: `0xece5d15e567c801c835029a49b2e4067b0eb63aa` (gets 40%)

**4. Wire them on the NFT (as owner):**
- `setSplitter(<RevenueSplitter>)`
- `setRoyalty(<RevenueSplitter>, 500)`
- `setLocker(<StagStaking>)`   ← lets staking lock/unlock NFTs
- `setMintPrice(...)`, `setMaxPerWallet(2)`, then `setMintActive(true)` at go-live

**5. Configure staking (as owner):**
- $STAG is already 2× from the constructor. To let people stake other Robinhood-Chain
  tokens, `setTokenWeight(token, 10000)` (1×) for each one you approve — set the weight to
  reflect its decimals/value; only approve tokens you trust.
- **Admin panel / operator:** **approving a NEW stakeable token is owner-only** (approving a
  manipulable/junk token is the main pool-drain vector). Call `setOperator(<wallet>)` to let a
  teammate **adjust the weight of already-approved tokens** from the admin panel with *their
  own* wallet (no key sharing, not full owner). The panel's access code only hides the UI —
  the on-chain change is still signed by that wallet.
- Set rarity boosts: `setNftBoostBps(tokenId, bps)` per NFT (e.g. Mythic `5000` = +50% …
  Common `500` = +5%), or leave `defaultNftBoostBps` (+10% each).
- Optionally tune `setLockPeriod(seconds)` / `setEarlyPenaltyBps(1500)`.
- Rewards flow in automatically as ETH from mint sales. To start paying them out, call
  `notifyRewardAmount(amountWei, durationSeconds)` — it refuses to distribute more ETH
  than the contract holds, so payouts can never exceed funding.

---

## Users
- **Mint:** `mint()` payable (≤ maxPerWallet).
- **Token staking:** approve exact amount → `stakeTokens(token, amount)` / `unstakeTokens(token, amount)` / `claim`.
- **NFT staking:** `stakeNFT(id)` / `unstakeNFT(id)` (locks in place — NFT never leaves wallet).
- `userInfo(addr)` → amount, multiplier, pending ETH, staked NFTs, locked?

## Wire the site
Send me the three deployed addresses (NFT, Staking, Splitter) and I'll:
- flip the mint button live (`js/mint-wallet.js`),
- build `js/stake-wallet.js` (WalletConnect/AppKit, exact-amount approve, chainId re-check,
  balance+gas pre-sign guard, lock-in-place stake — no `setApprovalForAll`).

## ⚠️ Before mainnet
Test the full mint + stake/unstake/claim + lock/unlock flow on testnet (46630). Get a
review — these hold real funds. On-chain randomness in the mint (prevrandao) is fair for
20 pieces but not manipulation-proof; fine here, don't reuse for high-stakes RNG.
