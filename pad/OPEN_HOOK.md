# Open hook: bring your token (v2)

**Status: NEW, UNAUDITED, NOT DEPLOYED.** Nothing here has had the review the first pad contracts had. The contracts in this note are not in `audited-manifest.json` and there is no deployment script for them. Do not deploy, announce or link to any of it before an independent audit of the points in "What an auditor must check".

The existing contracts (`PadHook`, `PadFactory`, `PadBattle`, `PadDeployer`, `PadToken`, `PadRouter`) are not changed by a single byte. Their tests run unchanged.

## What it is for

Today a token can only have a war chest and fight battles if it was launched through the pad. This lets a project that already has an ERC-20 open a $STAG pool for it with the same 3% tax, the same war chest and the same battles.

## The pieces

| File | What it is | New code? |
|---|---|---|
| `contracts/OpenHook.sol` | The hook for brought-in pools. `PadHook.sol` copied line for line, with the changes listed below. | Copy of audited code + 14 changed/added lines, 36 removed |
| `contracts/OpenPad.sol` | The launcher. One call, `bring`, checks the token, opens the pool and locks the seed. Owns every position, has no way to remove one. | New (about 200 lines of code) |
| `contracts/PadRegistry.sol` | Read-only directory of both systems: which pool is a pad pool, which system, which battle contract can run a given fight. No owner, no state, holds nothing. | New (about 60 lines of code) |
| `contracts/PadBattle.sol` | **Unchanged.** A second instance is deployed pointing at `OpenHook`. | None |
| `contracts/PadRouter.sol` | **Unchanged.** A second instance is deployed pointing at `OpenHook`. | None |
| `contracts/TestOpenTokens.sol` | Test only: a token with switches for every bad behaviour tested. | Test only |

### Why the hook is a copy and not an extension

`PadHook`'s functions are not `virtual`, and its build is pinned by hash in `audited-manifest.json` (the hash covers the compiler metadata, so even adding the word `virtual` or a comment changes it). So it can be neither inherited-and-overridden nor edited. Two things in it cannot work for somebody else's token: it calls `token.burn()` and it pays the holders' share into the token contract (`sync()`), which a foreign token does not have.

To keep the copy from drifting, `test/open.drift.test.js` compares the two files as code and fails unless the difference is exactly the reviewed list in `test/fixtures/openhook.delta.json`. An auditor reads that list, not 400 lines.

One alternative was considered and rejected: deploy a second instance of the unchanged `PadHook` with a controller contract standing in as every pool's creator. It adds no hook code at all, but it only works for tokens that have a `burn(uint256)` function, and it needs peace mode blocked by the controller. That excludes too many existing tokens.

### The changes in OpenHook (the whole list)

1. **Burn.** A chest burn sends the bought tokens straight from the PoolManager to the dead address (`0x…dEaD`). The hook never calls the token and never holds it. Total supply does not fall; the tokens are just unreachable.
2. **Peace mode.** No money is ever sent to the token contract. In peace mode the buy tax splits 1/3 to the pool's creator and 2/3 to the pool's chest. `pushHolders`, the per-swap flush and its transient flag are removed. `holderOwed` stays in the struct (always 0) so storage layout and the `info()` getter match `PadHook`.
3. **Bar.** `setBarred(poolId, bool)`, platform owner only. A barred pool cannot make or accept a battle offer. That is all it does (see "Platform owner powers").

War mode, the sell tax, the fill rules, the burn limits (one per pool per hour, about 1.5% price move per call), forced burns, chest settlement and the ERC-6909 bookkeeping are the same lines as `PadHook`.

## How a token is brought in

`OpenPad.bring(token, amount, stagPerToken, war)`:

- The caller approves `amount + 2,000,000` token-wei. `amount` goes into the pool; 1,000,000 wei (a millionth of a millionth of a token) is sent to the dead address as a test and is lost; the other 1,000,000 wei and any rounding dust come back.
- The pool is $STAG / token, 0.30% LP fee, tick spacing 60, hook = `OpenHook`. The key is fully determined by the token, so there is exactly one pool per token.
- Liquidity is one-sided, tokens only, from the start price up about 1000x. Same shape as a pad launch. The start is the 60-tick step at or just above `stagPerToken` (never below, at most about 0.6% above).
- The position belongs to `OpenPad`. `OpenPad` has six state-changing functions: `bring`, `collectFees`, `setCurated`, `allow`, `deny`, `unlockCallback`. None passes a negative liquidity amount. There is no remove path for the seeder, the platform owner or anyone else. The hook refuses liquidity from anyone but `OpenPad`.
- Minimum seed: at least 1% of the token's total supply **and** worth at least 1,000,000 $STAG at the start price. (Both numbers are product choices; confirm them.)

If the start price is below what the token trades for elsewhere, the first buyers take the difference. That is the seeder's loss and nobody else's.

## Token checks at registration

Checked on chain, in the same transaction, or the whole call reverts and nothing is registered:

- the address is a contract, and is not $STAG, the PoolManager, the hook or the pad;
- `decimals()` exists and returns exactly 18 (other decimals are rejected, not handled);
- total supply is between 1 wei and 1e33;
- pulling the tokens (`transferFrom`) moves exactly the amount on both sides;
- a 1,000,000-wei `transfer` to the dead address and one back to the caller each move exactly that amount on both sides;
- the `transfer` into the PoolManager moves exactly what the pool is owed;
- total supply and the pad's own balance are the same at the end as at the start.

This catches: a fee on transfer of one part in a million or more (on any of the four transfer paths used), a rebase, mint or burn triggered by a transfer, a token that refuses the PoolManager or the dead address, a re-entrant callback into `bring` or `collectFees`.

**What cannot be detected, and is therefore NOT protected:**

- **Blacklists and pausing.** The token's owner can later block the PoolManager or any buyer. The pool freezes; buyers cannot sell.
- **Upgradeable tokens / proxies.** Tomorrow's code is not today's code.
- **Minting.** A token whose owner can mint can sell fresh tokens into the pool and take the $STAG buyers paid in. "Liquidity locked" does not stop this. (Tested, see below.)
- **A fee, rebase or callback switched on after registration**, or one that only applies to addresses or amounts the checks did not use (for example only when the PoolManager is the *sender*, or only above some size).
- **Fees smaller than one part in a million.**
- **Tokens whose `balanceOf` or `totalSupply` lie.**

In every one of these cases the damage stays on that token's side of that token's pool, with one exception (battles, next section). The hook's $STAG books are not affected: tax claims are minted only against $STAG a swapper actually pays into the PoolManager, and the tests check after every hostile case that the hook's claims equal exactly what it owes across all pools.

## Creator identity

**The creator of a brought-in pool is the wallet that called `bring`.** There is no argument to name anyone else and no way to change it afterwards. The creator controls: war / peace switch, chest burn timing, the creator share (peace mode), the pool's 0.30% LP fees, and offering / accepting battles.

**This does not prove the wallet owns or represents the token's project.** On chain there is no such thing as "the project's wallet" for an arbitrary ERC-20. The website's verified list has to carry that, off chain. Without it:

- a look-alike token (same name and symbol, different address) registers just as well;
- in open mode, anyone holding 1% of a real token's supply can bring it first and is its creator for good (one pool per token). They can also pick a bad start price and leave the token with a dead pool.

The answer to the second point is curated mode.

## Platform owner powers (and their limits)

The platform owner is the owner of `OpenHook` (same two-step hand-over as `PadHook`). `OpenPad` reads it live from the hook.

| Power | Where | What it does | What it cannot do |
|---|---|---|---|
| `setCurated(bool)` | OpenPad | `true`: only listed tokens can be brought. `false`: any token not denied. | Touch any pool that exists. |
| `allow(token, seeder)` | OpenPad | Lists a token for one named wallet, or for anyone, or unlists it. | Same. |
| `deny(token, bool)` | OpenPad | Refuses a token in both modes. | Same. A denied token's existing pool keeps trading. |
| `setBarred(poolId, bool)` | OpenHook | A barred pool cannot make or accept a battle offer. | Stop trading, burning or claiming; move a chest; stop or steer a running battle (unlocking is never blocked). |
| `claimPlatform` | OpenHook | Takes the sell-side tax collected so far. | Take a chest, a creator share or liquidity. |
| `wire` (once), `setOwner` | OpenHook | As in `PadHook`. | |

No owner function reaches liquidity, a chest, a creator share or a pool's price. This is tested (`platform owner: limited powers`, `the owner's bar`).

**Recommended starting position: `curated = true`**, each token listed for the one wallet the project named. That closes creator squatting and keeps hostile tokens out of battles. Opening it up later is one call.

## Battles

Battles between brought-in pools run on a second, unchanged `PadBattle` pointed at `OpenHook`. Same rules as today.

### What works

- Any two brought-in pools can fight (tested end to end, including loot and the forced burn).
- A token that was launched through the pad can fight brought-in tokens **by being brought in itself**: its holder seeds a second pool for it on `OpenHook` (a `PadToken` is an ordinary ERC-20). Tested. The cost: it is a second pool, so liquidity is split; only the volume and chest of the open pool count; the original pool and its chest are not involved; on the open pool there is no holder payout, and burns go to the dead address.

### What does not work, and why (precisely)

**A pool on `PadHook` and a pool on `OpenHook` cannot fight each other.** Two reasons in the existing, unchangeable code:

1. `PadHook` obeys exactly one battle contract, set once by `wire`. Only that contract can lock its pools or settle its chests. A new battle contract cannot lock an old pool.
2. `PadHook.settleChests` moves a chest between two pools inside the same hook. A chest is a claim held by the hook at the PoolManager, and `PadHook` has no function that hands a claim to another hook.

So no wrapper or registry can make it happen without replacing `PadHook`. `PadRegistry.battleFor(a, b)` returns the right battle contract for two pools on the same hook and zero for two pools on different hooks; the site should use it to decide whether to offer a fight.

### What remains for true "any two pools"

Pick one, each needs its own audit:

- **A.** Keep it as delivered: launched tokens join by being brought in.
- **B.** One hook for both kinds going forward: give `OpenHook` a per-pool flag (launched: `burn()` + holder payout as in `PadHook`; brought in: as here) and let it accept two registrars. Old pools on `PadHook` still stay where they are.
- **C.** If `PadHook` is not yet live with pools, replace it before launch with the hook from B. That gives up the audited build.

### New battle risk (read this)

With pad-launched tokens, a won chest is really spent: it buys a fixed-supply token. With a brought-in token whose owner can mint (or otherwise controls the contract), the owner can sell fresh tokens into the pool afterwards and take that $STAG back out, minus 3%. So a hostile token's creator can treat a battle win as income, and wash trading to win costs them less than it looks. An honest creator who accepts a fight against such a token is staking their fight earnings against a rigged opponent.

What limits it: a battle needs the opponent's creator to accept on chain; the owner can bar a pool from battles; curated mode keeps unknown tokens out. **The site must not encourage accepting fights from unverified tokens.**

## Threat model

| Threat | Outcome | Test |
|---|---|---|
| Fee-on-transfer token (fee on any path, or only to pad / PoolManager / dead / seeder) | Rejected at registration | `fee-on-transfer tokens are rejected` |
| Token that rebases during registration | Rejected | `a token that rebases` |
| Token that refuses the PoolManager or the dead address | Rejected, seeder loses nothing | `refuses transfers to the pool manager` |
| Not a contract, $STAG itself, wrong / missing decimals | Rejected | `rejects what is not a plain 18-decimal token` |
| Dust seed at an absurd price; seed under 1% or under 1,000,000 $STAG | Rejected | `rejects a seed that is too small` |
| Same token registered twice (any wallet, any price) | Rejected | `can never be registered twice` |
| Front-run: open the pool first at a skewed price, or register around the pad | Impossible: the hook refuses to initialise a pool the pad has not registered, in the same transaction | `front-running` |
| Creator spoofing: take creator rights, or name someone else | Impossible on chain | `creator spoofing` |
| Look-alike token; squatting a real token in open mode | **Not protected on chain.** Verified list; curated mode | `WHAT IS NOT PROTECTED on chain`, `curated mode` |
| Token calls back into `bring` / `collectFees` | Blocked by the lock | `calls back into the pad` |
| Token (as its own creator) calls back into the hook during a chest burn | Inner calls fail; books exact | `calling back into the hook from inside a chest burn` |
| Token fires a swap on its own pool from inside the burn | Swap is taxed normally; chest, volume and claims exact | `a taxed swap fired from inside the burn` |
| Fee switched on after registration | Sells into that pool fail. Other pools and $STAG books fine | `a fee switched on later` |
| Blacklist on the PoolManager after registration | That pool freezes, its chest is stuck. Other pools fine | `a blacklist on the pool manager` |
| Owner mints and dumps | **Not protected.** Buyers of that token lose their $STAG | `a token whose owner can mint` |
| Rebase after registration | That pool's token side breaks. $STAG books fine | `a rebase after registration` |
| Anyone adds or removes liquidity | Impossible | `liquidity is locked` |
| Platform owner takes liquidity, a chest or a creator share | No such function | `limited powers` |
| Owner bars a pool mid-fight to change the result | No effect on a running fight | `the owner's bar` |
| Wash trading to win a fight | Accepted as today; pays 3% of every $STAG counted | `ACCEPTED, as today` |
| Old-hook pool vs open-hook pool | Cannot fight | `THE LIMIT` |

Inherited from `PadHook` unchanged (same known limits as in `README.md`): one person running both sides of a battle, forcing a tie, a pool pumped to the top of its range, and a pool whose price has been pushed below its range having nothing to burn until someone buys.

## What an auditor must check

In this order:

1. **The delta list** (`test/fixtures/openhook.delta.json`), line by line. In particular:
   - Removing `_flush` and the transient "booked" flag: nothing else relied on them.
   - Peace mode's 2/3 now lands in `chest`. A pool can only be locked while in war mode (`challenge` and `accept` require war; `setMode` reverts while locked). Confirm a chest can never grow from the peace branch during a fight, so the end-of-fight snapshot logic is untouched.
   - `holderOwed` can never be non-zero.
2. **`poolManager.take(token, DEAD, got)` inside the burn**, with a token that runs code in `transfer`. The PoolManager is unlocked at that point. Enumerate what a hostile token can do from there (swap on the same pool, on another pad pool, settle) and confirm the `chest` / `forced` arithmetic in `_spend` holds when a taxed swap on the same pool happens in the middle. The tests cover re-entering `burnChest`, `claimCreator`, `claimPlatform` and `collectFees` (all fail), and a taxed buy on the same pool fired from inside the burn (it goes through and the books stay exact). They do not cover a sell from inside the burn, or a swap on a different pad pool.
3. **`OpenPad.bring`**: order of checks; that the checks cannot be satisfied by a token that then short-pays the PoolManager; `_range` rounding (start never below the request, in both currency orders); the two minimums; that `unlockCallback` can only ever add the one seed and poke with zero liquidity; that the pad can hold no leftover tokens.
4. **Solvency with hostile tokens**: that no token behaviour can mint the hook a $STAG claim that was not paid for, or make one pool's chest payable from another's. This is the property the whole "damage stays in its own pool" claim rests on.
5. **The battle economics with a mintable token** (section "New battle risk"). Decide whether the bar plus curated mode is enough, or whether brought-in tokens should be kept out of battles against each other until verified.
6. **Owner powers**: that `setBarred`, `setCurated`, `allow`, `deny` are the whole list and do only what the table says.
7. **`PadBattle` and `PadRouter` reused unchanged against `OpenHook`**: the four functions the battle calls (`poolState`, `forced`, `setLocked`, `settleChests`) have identical signatures and meaning.
8. **Deployment**, which does not exist yet: `OpenHook` needs a CREATE2 salt with the same flag bits as `PadHook` (0x28CC), and hook + pad + battle + `wire` + owner hand-over should happen in one transaction as `PadDeployer` does for the first system. Until that deployer is written and reviewed there is a window in which the hook exists unwired.
9. `PadRegistry`: trivial, but confirm it cannot be constructed with a mismatched hook / battle pair.

## Known gaps

- No deployer, no deployment script, no readback script, no manifest entry for the new contracts.
- No website work. The site must show, for every brought-in pool: unaudited contracts, "creator = the wallet that seeded this pool, not necessarily the project", verified or not, and the token-risk list above.
- Only 18-decimal tokens.
- From inside a burn, only a re-entrant buy on the same pool is tested; a sell, or a swap on another pool, is not.
- No fuzzing or invariant run; tests are scenario tests on a fork.
- The two minimums (1% of supply, 1,000,000 $STAG) and the probe size are first guesses.
- Peace mode on a brought-in pool pays the *seeder* 1% of buys. Whether that is wanted for unverified creators is a product (and possibly legal) decision.
- Old-hook pools cannot fight open-hook pools (see Battles).

## Tests

`RH_BLOCK=<head-20> npx hardhat test` from `pad/` (mainnet fork; refresh the block before each run).

New files (42 tests):

- `test/open.fork.test.js` (16): registration checks, the liquidity lock, tax and chest side by side with a launched pool, the unchanged router.
- `test/open.hostile.test.js` (15): creator identity, owner limits, curated mode, tokens that turn hostile after registration, reentrancy.
- `test/open.battle.test.js` (9): battles between brought-in pools, a launched token brought in, the bar, the registry, the cross-hook limit, wash trading.
- `test/open.drift.test.js` (2): the copy has not drifted from `PadHook.sol`.
- `test/open.helpers.js`: helpers. The existing test files and `test/helpers.js` are untouched.

Last full run (one process, fork at head-20): **162 passing, 0 failing, about 9 minutes**: the 120 existing tests plus the 42 new ones.

**Running on the public RPC.** The public RPC drops state older than roughly ten minutes and slows down sharply under load (measured: from under 0.1 s to about 2 s per request). The whole suite needs about nine minutes when the RPC is fast, so there is little margin: two earlier attempts on a throttled RPC were cut off by the fork provider with `historical state ... is not available` before any test had failed. That is the RPC, not a test failure. If it happens, wait a few minutes and run again, run file by file with a fresh block each (`RH_BLOCK=<head-20> npx hardhat test test/<file>`), or use an archive RPC through `RH_RPC`.
