# STAGWIFHOOD — Contract Deploy Guide (Robinhood Chain)

Two contracts power the NFT mint and staking. They're written against OpenZeppelin
v5 and are Remix-ready. **Deploy to the Robinhood Chain testnet (chainId 46630) and
test first**, then mainnet (chainId 4663). You deploy from your own wallet — I can't
(no keys). Once deployed, send me the two addresses and I'll flip the site live.

Live token — `$STAG`: `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49`

---

## 1. The Hooded 20 — NFT mint (`HoodedTwenty.sol`)

**Deploy (Remix → Injected Provider on Robinhood Chain):**
- Constructor args:
  - `_price`: mint fee in wei. e.g. `10000000000000000` = 0.01 ETH. Use `0` for free mint.
  - `baseURI_`: `https://stagwifhood.fun/assets/nft/stagwifhood/metadata/`
- After deploy, call `setMintActive(true)` when you want minting open.

**Facts:** 20 supply, random draw, no duplicates, `tokenURI` → the hosted metadata
(already made marketplace-ready with absolute image/animation URLs). `withdraw(you)`
pulls the mint proceeds.

**Wire the site:** in `js/mint-wallet.js` set:
```js
contract: '0xYOUR_NFT_ADDRESS',
priceEth: '0.01',        // must match _price
payWith: 'native',
```
Button auto-flips from "Coming Soon" to live minting once `contract` is set.

---

## 2. Staking (`StagStaking.sol`)

**Model (per the team spec):**
- Stake **$STAG tokens and/or Hooded 20 NFTs**.
- **Rewards are paid in ETH** (real yield). The pool is funded by **30% of NFT mint
  sales** (auto-forwarded from the mint contract) + owner top-ups.
- Rewards accrue on **weight = staked tokens × NFT multiplier**. NFTs boost your
  multiplier; **staking only NFTs (no tokens) earns nothing.**
- **Early unstake** (before the lock): **15% penalty** on the tokens pulled **and you
  forfeit all unclaimed rewards.** After the lock (default **7 days**): no penalty.

**Deploy order (NFT first, they reference each other):**
1. Deploy `HoodedTwenty` (section 1) → note its address.
2. Deploy `StagStaking` with:
   - `_stag`: `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49` ($STAG)
   - `_hood`: the HoodedTwenty address from step 1
3. On the NFT contract call `setStakingPool(<staking address>)` so 30% of mint sales flow to it.

**Configure (owner):**
- `setNftBoostBps(tokenId, bps)` per NFT to set rarity boosts (e.g. Mythic 5000 = +50%,
  Common 500 = +5%); or leave `defaultNftBoostBps` (+10% each).
- `setLockPeriod(seconds)` / `setEarlyPenaltyBps(1500)` if you want to change the 7-day / 15% defaults.
- Fund rewards: send ETH to the contract (NFT sales do this automatically; you can also
  send directly), then `notifyRewardAmount(amountWei, durationSeconds)` to stream it out.
  The contract refuses to distribute more ETH than it holds.

Users: `stakeTokens` / `stakeNFT` / `unstakeTokens` / `unstakeNFT` / `claim`. `userInfo(addr)`
returns amount, multiplier, pending ETH, staked NFTs and whether they're still locked.

**Wire the site:** the stake UI (`/stake`) is currently cosmetic. Send me the deployed
staking address and I'll add `js/stake-wallet.js` (connect → approve → stake/unstake/claim
with the same pre-sign guard as the mint) and flip it live.

---

## Network
| | |
|---|---|
| RPC | `https://rpc.mainnet.chain.robinhood.com` (or your Alchemy URL) |
| Chain ID | 4663 mainnet · 46630 testnet |
| Currency | ETH |
| Explorer | `https://robinhoodchain.blockscout.com` |

## ⚠️ Before mainnet
- Deploy + test the full mint and stake/unstake/claim flow on testnet.
- Consider a quick audit — these are standard patterns but they hold real funds.
- On-chain randomness in the mint (prevrandao) is fair for 20 pieces but not
  manipulation-proof; fine for this, don't reuse for high-stakes RNG.
