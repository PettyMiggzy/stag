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

## Second-pass (regression) re-audit
A fresh reviewer re-audited the fixed code specifically for regressions and new issues:
- Confirmed the `totalWeight == Σ user.weight` invariant, `appliedBaseWeight` snapshot correctness
  (safe even if `nftBaseWeight` changes between stake/unstake), no proportional-forfeit underflow
  (`f ≤ rewards` always), best-effort collector sends disburse exactly `r` with no loss, and the Pact
  solvency invariant `balance ≥ reservedPayouts + reservedEntries` with no double-decrement.
- **No new medium/high issues, no regressions.** One low note actioned: free mints no longer increment
  the paid `mintedBy` counter, so a whitelisted wallet can still buy its normal allocation later.

## Verification after round-1 fixes
`npx hardhat test` → 34 passing. `scripts/simulate.js` → all invariants held across 2,100+ random steps.

---

# Round 2 — "ultracode" 8-agent deep audit

Eight independent adversarial auditors (per-contract deep dives + cross-contract + whole-system
economic/MEV + deploy script + frontend wallet-safety + compiler/OZ-v5), each hunting what round 1
missed. Consolidated, verified, and fixed.

## Confirmed fixed
| Sev | Area | Finding | Fix |
|-----|------|---------|-----|
| **HIGH** | StagStaking | `sweepEth` used stale `reserved` and excluded the still-streaming reward schedule — owner could sweep ETH backing an active period and brick claims (a regression from the round-1 sweepEth add) | `sweepEth` now settles first and subtracts `reserved` **and** `rewardRate*(periodFinish-now)`; can never unfund live rewards |
| **CRIT (frontend)** | mint/stake/admin JS | no chainId check before sending value → a user on the wrong network could send real ETH into the void (estimateGas guard doesn't catch it) | verify `chainId==4663` after connect + before every value path; drop signer on `chainChanged` |
| MED | SherwoodPact | owner could raise the live-read, unbounded `grace` to permanently strand holder entries | `grace` snapshotted per pact; `setGrace` capped at 90d; oracle can't forfeit after window+grace (holder reclaim wins) |
| MED | SherwoodPact | same STAG bag → unlimited pacts → farm rewards | one open pact per wallet |
| MED | StagStaking↔NFT | re-pointing the locker while NFTs staked silently bricked the NFT (swallowed `unlock` revert) | `pendingUnlock` + `NftUnlockFailed` event + `retryUnlock()` |
| MED | StagStaking | config changes only applied on a user's next action → stale-weight unfairness; tier duration could be set to 0 (enables notify-sandwich) | permissionless `poke()`; lock-tier floor of 1h |
| MED | StagStaking | `nftBaseWeight` default (100k) let NFTs cheaply dominate the pool | lowered default; documented as a tokenomics knob |
| LOW | frontend | double-click double-mint; unescaped manifest via innerHTML (XSS); unvalidated admin fund address; price mapped from manifest not chain | in-flight lock; escape + textContent; isAddress+getCode; read `priceOf`/`randomPrice` on-chain |
| LOW | RevenueSplitter | `distribute` reverted/stranded fee-on-transfer tokens | second leg pays live remaining balance |
| LOW | HoodedTwenty | silent unfunded pool if splitter forward failed | `SplitterForwardFailed` event |
| LOW | all | missing events; unpinned evmVersion (Cancun `MCOPY` risk on L2) | added events; pinned `evmVersion=paris` |
| HIGH (ops) | deploy | 20-count free-mint could mint the whole collection free; immutable `poolBps`/owner typo misroutes funds; no ownership handover | count→2 + guard; checksum + `poolBps` assert; transfer ownership/penaltyRecipient/oracle to admin; apply prices from config |

## Verified sound (no fix needed)
Reward accounting & `totalWeight == Σ weight` invariant, proportional-forfeit math (no underflow),
reentrancy/CEI everywhere, Pact escrow solvency on every path, mint pool integrity & weighted-draw,
OZ-v5 overrides (`supportsInterface`, `_update`), ERC-5192/2981, holding-multiplier can't be flashed,
the notify-sandwich (defended by drip+lock+forfeit), and the self-mint-then-stake loop (bounded by the
10% owner cut).

## Residual — need a product decision (documented, not silently shipped)
1. **Gamble randomness** — on-chain entropy is sequencer-influenceable; a real fix needs a VRF (not on
   Robinhood Chain). Options: commit-reveal (keeps gamble, 2-tx), PICK-only, or accept for a 20-piece drop.
2. **Gamble pricing** — flat 0.010 gamble has higher expected pick-value (~0.0142) than its price, so a
   rational buyer always gambles over PICK. This is your intended "cheap gamble" design; raise
   `randomPrice`, draw uniformly, or accept. Both are owner-tunable, not code bugs.

## Verification after round-2 fixes
`npx hardhat test` → **38 passing** (added sweepEth-solvency, one-pact, grace-snapshot, reclaim tests).
`scripts/simulate-full.js` (whole-system, every action) → **2,100 steps across 9 seeds, all invariants
held**, including the strengthened `balance ≥ reserved + outstanding-schedule` solvency check.
