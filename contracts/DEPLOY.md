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

**Deploy:**
- Constructor args:
  - `_stakingToken`: `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49` ($STAG)
  - `_rewardToken`: `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49` ($STAG) — or a different reward token

**Fund + turn on rewards:**
1. `approve()` the staking contract on the reward token, then `fund(amount)` to load the reward pool.
2. `setRewardRate(tokensPerSecond)` — pick a rate your funded pool sustains.

Flexible: users `stake`, `unstake`, `claim`, or `exit` (claim + unstake all) anytime.
Reward accounting is the Synthetix pattern. Since reward token == staking token, always
keep the contract holding ≥ `totalStaked` + unclaimed rewards.

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
