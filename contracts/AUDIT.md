# The Hooded 20 — Security Audit & Fixes

Internal adversarial audit (multi-reviewer + invariant simulation) of the four contracts, the fixes
applied, and verification. This does **not** replace a professional third-party audit before mainnet —
it raises the floor.

## Method
- Independent adversarial review of each contract (reentrancy, access control, accounting/solvency
  invariants, rounding, DoS, fund drainage).
- 34 unit tests (`test/`) + a randomized invariant simulation (`scripts/simulate.js`): 5 seeds ×
  300 random steps (1,500 total) asserting, after **every** step: solvency (`balance ≥ reserved`),
  weight consistency (`totalWeight == Σ user.weight`), principal integrity, and no reward over-accrual.

## Headline result
**No critical/high fund-theft or insolvency bug** was found in any contract. The Synthetix reward
accounting, the weighted-draw pool, and the Pact escrow were all verified sound. The findings below are
correctness / economic-fairness / DoS / UX issues — all fixed.

## Findings & fixes

### StagStaking
| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| H1 | High | NFT-only staking earned nothing (weight = base×mult with base=0) yet locked the NFT | NFTs now add `nftBaseWeight` to base weight (snapshotted per token) so they earn |
| M1 | Med | Topping up a stake could silently downgrade the lock tier/multiplier | `stakeTokens` requires `tier ≥ current` on an active position |
| M3 | Med | Any partial early unstake forfeited the **entire** position's rewards | Forfeit is now **proportional** to the base weight withdrawn |
| L2 | Low | ETH funded while `totalWeight==0`, or over-funding, was permanently stuck | Added `sweepEth` (bounded to `balance − reserved`, never touches liabilities) |
| L3 | Low | A reverting collector wallet could brick a staker's own claim | Collector sends are best-effort; a failed share falls through to the staker |
| L5 | Low | Unbounded `holdThreshold` array | Capped at 10 |
| M2/L1 | Info | Config changes apply on next user action; `reserved` is a ~wei-dust under-estimate | Documented (prospective by design; dust is harmless — payouts independently bounded) |

### HoodedTwenty
| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | Med | Gamble draw uses on-chain entropy → sequencer/searcher could snipe rares | Hardened entropy + documented as an accepted L2 trade-off; tiered PICK pricing bounds the incentive. Full fix needs a VRF (not available on-chain) |
| 2 | Low | Owner setting a tier weight to 0 could brick the gamble (÷0) | `setTierWeight` requires `> 0`; `_drawWeighted` guards `totalWeight > 0` |
| 3 | Low | Overpayment silently forwarded | Forwards exactly `due`; refunds the excess |
| 4 | Low | A reverting splitter/recipient could brick paid mints | Forwarding is best-effort; ETH stays recoverable via `withdrawETH` |
| — | — | Free-mint allowance was capped by `maxPerWallet` (couldn't use a 20-grant) | Free mints bypass the per-wallet cap |
| 5 | Info | `tx.origin` EOA gate blocks smart-contract wallets; cap not Sybil-proof | Kept (removes the reentrancy/grinding surface); documented |

### SherwoodPact
| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | Med | A silent/censoring oracle could strand a holder's entry forever | `reclaim()` returns the full entry after window + grace |
| 2 | Med | Open-pact entries weren't reserved → owner could sweep them pre-verification | Full entry escrowed in `reservedEntries`, excluded from `freeTreasury` |
| 3 | Low | Oracle-supplied `reward` was unbounded (compromised-key drain) | `maxReward` cap (default `entryFee×10`, owner-tunable) |
| 4 | Low | Overpayment not refunded | Refunded on `createPact` |

### RevenueSplitter
Solvency/rounding sound; the only issue was the mint-DoS coupling (fixed at the NFT layer, above).
Permissionless `distribute`/`splitETH` are safe (funds can only reach the two immutable addresses).

## Residual / accepted
- **Gamble randomness** is influenceable by the chain sequencer (no on-chain VRF). Accepted for a
  20-piece art mint; PICK pricing caps the upside of sniping. Use PICK-only if unacceptable.
- **Oracle trust** in the Pact is inherent to the off-chain proof-of-hold model; bounded by `maxReward`
  and the holder `reclaim` escape hatch.
- Config changes (multipliers/weights) apply on a user's next interaction (prospective).

## Verification after fixes
`npx hardhat test` → 34 passing. `SIM_RUNS=300 SIM_SEED=<1..5> npx hardhat run scripts/simulate.js`
→ all invariants held across 1,500 random steps.
