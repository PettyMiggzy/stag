# The Hooded 20 — Mint + Staking + Sherwood Pact — Build Spec

Living spec for the mint/staking/loyalty system. Confirms at the bottom before I rewrite the
fund-holding contracts. Chain: Robinhood Chain mainnet 4663 / testnet 46630. **Testnet first.**

Wallets referenced:
- Owner / dev: `0xece5…63aa` (existing RevenueSplitter owner)
- Backend-costs wallet: `0x5db7ca9d2ce3f414b3fd94ec0fcaf9f3ab1a575f`
- $STAG token: `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49`

---

## 1. NFT mint — `HoodedTwenty.sol` (exists; add two mint modes)

Art + animations + traits are done and marketplace-standard (sells + animates anywhere; on-chain
random draw = no duplicate mints). Art stays as-is (baked-in text accepted). Add **two mint modes**:

| Mode | Price | Behavior |
|------|-------|----------|
| **Pick** | **0.015** RH-ETH | Buyer chooses a specific *available* tokenId. |
| **Gamble** | **0.010** RH-ETH | Weighted random draw; **top tiers are rare** to hit. |

- Gamble weighting: each remaining token weighted by tier — Common most likely → Mythic least.
  Weights are **owner-settable** (tune the odds). Draw removes the minted id (no dupes).
- Supply 20. Proceeds → RevenueSplitter.
- **Free mint for whitelisted wallets on testnet** (owner allowlist bypasses price) so you test free.

⚠️ **CONFIRM #1:** In *Pick* mode a buyer could grab a Mythic for 0.015. Intended? Or should the
top tiers (Mythic/Legendary) be **gamble-only**, with Pick limited to Rare/Epic/Common?

---

## 2. Revenue split — `RevenueSplitter.sol` (change 60/40 → 90/10)

- **90% → staking reward pool** (StagStaking).
- **10% → `0x5db7…575f`** (backend costs).
- Handles native RH-ETH + ERC-20. (Note: the old 40% dev cut is gone — dev revenue now only via
  whatever the pool/backend split allows. Flag if you want a dev cut carved out too.)

---

## 3. Staking — `StagStaking.sol` (exists v3; upgrade)

- **Rewards paid in native RH-ETH** (Synthetix accounting — payouts can never exceed funding). ✔ matches v3.
- **Funded by:** 90% of mint proceeds + 15% early-unstake penalties + team top-ups.
- **Lock tiers 30 / 60 / 90 days** — longer lock amplifies rewards. Default multiplier **1× / 1.5× / 2×**, owner-settable.
- **Holding multiplier** by the staker's live $STAG balance (owner-settable thresholds + mults):
  - `< 1M STAG` → **1×**
  - `≥ 1M STAG` → **2×**
  - `≥ 10M STAG` → **3×**
- **Stacking:** rewardWeight = stakedAmount×tokenWeight × lockMult × holdMult (multiplicative).
- **Early unstake:** 15% token penalty + forfeit rewards → pool. NFT early = forfeit rewards, keep NFT. ✔ v3.
- **Withdraw split:** name up to 3 wallets + a share %; when you **unstake**, your withdrawn **$STAG
  principal** is split to them (remainder back to the staking wallet). ETH rewards on `claim` go to the
  staker. **Changeable only by the original staking wallet.**
- **Whitelist** so your wallet can stake/test free on testnet.

⚠️ **CONFIRM #2:** Multipliers stack multiplicatively (lock × hold), and the defaults above are fine to
tune on testnet? (e.g. hold 10M + 90-day lock = 3× × 2× = 6× base.)

---

## 4. Sherwood Pact — proof-of-hold (NEW contract, "no wallet connect to earn")

The "don't connect your wallet, pay to collect later" path. It is **not** custody staking — tokens
never move; the user just keeps holding. A contract **cannot** read historical balances, so holding
is verified **off-chain by our bubble-map indexer** (transfer history), then a signed/owner-approved
result unlocks payout. Trust/oracle model — the only way it can work.

- User makes a Pact: agrees to hold ≥ X $STAG; pays entry (**≈ $11 in RH-ETH**, owner-settable, price via
  Robinhood API → ETH equiv).
- On return + claim: **held the whole time** → refund **≈ $5 RH-ETH + rewards**; **didn't** → forfeit entry + rewards.
- **Separate treasury pool** (my call on your "idk, separate pool, you drive") — Pact entry fees pool here;
  refunds paid from here; forfeits + remainder → backend costs. Keeps it isolated from the staking pool.
- Verification is submitted by an **owner/oracle key** after the indexer confirms continuous holding.

⚠️ **CONFIRM #3:** Cool name — I'm going with **"Sherwood Pact."** Alternatives if you'd rather:
*The Hood Oath*, *Diamond Antlers*, *Hold Bounty*. Pick one.

---

## 5. Pricing (USD → ETH)

Contracts store **ETH amounts** (owner-settable); a backend job uses the **Robinhood API** to compute the
ETH equivalent of the USD targets ($11 entry, $5 refund, and any USD-priced mint) and updates them.

⚠️ **CONFIRM #4:** Robinhood's crypto price API generally needs **API credentials** (Ed25519 keys). Do you
have RH API keys to give the backend? If not, the reliable default is: **you set the ETH amount directly**
in the admin page (I still show you the current USD-equiv for reference from a public price source).

---

## 6. Admin page

Whitelist tokens + weights · set lock-tier & holding multipliers · fund pool · toggle mint + manage
free-mint allowlist · set mint prices + gamble odds · set Pact entry/refund amounts · **review & approve
Pact claims** surfaced from the indexer · pause switches.

---

## 7. Deploy

Testnet (46630) first, **whitelist your wallet** to mint/stake free. No mainnet until reviewed. This
custodies real funds and forfeits balances — get a security review before mainnet.

⚠️ **CONFIRM #5:** Your **test wallet address** to whitelist for free testnet mint/stake?

---

## Build order (on green light)
1. RevenueSplitter 90/10 (trivial, unambiguous).
2. HoodedTwenty two-mode mint + free-mint allowlist.
3. StagStaking upgrade (lock tiers, holding mult, collector wallet, whitelist).
4. SherwoodPact contract + indexer verifier + backend.
5. Admin page + mint/stake frontend pages.
6. Testnet deploy scripts.
