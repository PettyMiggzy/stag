# Pad: Uniswap v4 launchpad on Robinhood Chain (quote token = $STAG)

Status: audited internally in repeated hostile rounds; NOT yet deployed; needs lawyer sign-off on the holder payout (peace mode) before mainnet.

## What it does
- `PadFactory.launch` makes a token, opens a $STAG / token v4 pool with `PadHook` attached and seeds the whole 1B supply as one-sided liquidity the factory owns and can never remove. The creator collects the pool's LP fee (0.30%). No launch minimum, no bonding curve. Minimum starting value is 1,000,000 $STAG.
- `PadHook` takes 3% of the $STAG leg of every swap. Buy tax: **war mode** -> the project's war chest; **peace mode** -> 1/3 creator, 2/3 holders (paid in $STAG through the token's dividend counter). Sell tax -> platform. The hook keeps everything as ERC-6909 claims at the PoolManager.
- A war chest can only buy the project's own token through its own pool and burn it. The creator burns whenever they like, at most one burn per pool per hour, each call limited to ~1.5% price impact.
- `PadBattle`: a creator challenges another project (their own pool locks while the offer is open), the opponent accepts, both pools lock, the clock runs. Higher $STAG volume since acceptance wins. Only what each pool earned DURING the fight is at stake: the loser's fight earnings move into the winner's chest, and the winner's fight earnings plus that loot are marked "forced" and get burned (creator first; strangers may burn it in steps). Older chest money stays with its pool. Ties move nothing.

## Rules worth knowing
- Where the $STAG side of a swap is specified, the swap must fill completely or it reverts (so tax and volume are always on what really traded). Swaps that fill nothing revert.
- Only the factory can add liquidity to a pool. Zero-liquidity pokes (fee collection) are allowed.
- Dividends are staged and credited at the first token interaction of a later block, so tokens borrowed for one transaction never earn.
- Hook owner powers: take the platform's sell-side share, hand ownership over in two steps, wire the factory and battle once.
- Names/symbols: letters, digits, space and `. _ - + ! ? : #` only. The site must still trim, collapse whitespace and flag duplicates/look-alikes.

## Known limits (accepted, documented)
- **Wash trading** can win battles; it costs the trader tax and fills chests.
- **One person can run both sides of a battle** and move the loser's fight earnings into the winner's chest. A creator already controls their own chest (they can choose never to burn it), so this adds no power over honest buyers; in audits it lost money in every measured case (burn cap 1.5%/hour, 3% sell tax). It cannot be prevented by any rule (second wallet).
- **A loser can try to force an exact tie** by topping up volume in the last second; a tie moves nothing.
- **A pool pumped to the top of its range** has nothing left to buy: burns revert, a forced chest then stays stuck and that creator cannot start the next fight until it can be burned.
- **`block.number` on this chain is the Ethereum (L1) block number** (Arbitrum-style): "a later block" for dividend crediting means a later L1 block, ~12 s, spanning many chain blocks. This is stricter than intended and flash-take protection still holds.
- Parked dividends (eligible supply under 1 token) go to whoever first holds a token across the next block boundary.
- Exact-in and exact-out trades differ by ~3% in effective tax; volume is the pool's actual $STAG leg.
- Third parties can create their own hook-less pool for the same token; it is outside this system.
- Starting price snaps to the pool's 60-tick grid in the creator's favour: the real start is at or slightly above the request (up to ~0.6%). In the token-is-currency0 ordering an adversarially chosen request can land up to 1 wei of STAG below it (integer square-root rounding); this cannot undercut the 1,000,000 STAG minimum.
- The PoolManager's owner can set a protocol fee (at most 0.1%) on any pool, pad pools included; it would slightly reduce creators' LP fees and has no effect on solvency.
- Aggregators that price from a pool's raw price alone will miss the 3% tax; quoters that simulate the hook price it correctly.
- Routers: standard v4 routers work; a router that syncs $STAG before the swap works (the holder flush steps aside).

## Mainnet deployment (see scripts/)
Rules of the road: never launch, announce an address or send anyone to the pad until the FINAL readback (after the multisig accepts, with `EXPECT_OWNER_ACCEPTED=1`) passes. The deployer key is a throwaway: fund it only for gas and discard it afterwards. Work from a clean git tree at a tagged commit, with `package-lock.json` as committed, and run `node scripts/make-manifest.js` only after a reviewed source change (it rewrites `audited-manifest.json`; `deploy.js` and `readback.js` refuse a build that differs from it).

1. **Pre-flight (read-only).** Chain id 4663; PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951` and STAG `0x67Ef4460A1280fBD9d31D6312FEd2Ce1EFd66305` have code (they are hard-coded in the scripts); the multisig is a Safe whose threshold is at least 2 and whose signers you have rehearsed with a no-op transaction (the hook side is simulated by the readback, but only you can prove the signers can sign).
2. **Compile with the audited settings** (`npx hardhat compile`; solc 0.8.26, cancun, viaIR, 200 runs). Use `hardhat.nolimit.config.js` for rehearsals so the real size limits (24,576 runtime / 49,152 init) apply.
3. **Mine the salt last**, for exactly this build and this deployer account and nonce: `node scripts/mine-salt.js --eoa <deployer EOA> --nonce <its current nonce> --out salt.json`. Send nothing else from that account and do not recompile before step 4.
4. **Deploy**: `MULTISIG=<safe> DEPLOYER_KEY=<throwaway key> SALT_FILE=salt.json npx hardhat run scripts/deploy.js --network robinhood`. It refuses to run off mainnet (unless `DRYRUN=1` on the in-process fork), refuses a multisig that does not answer like a Safe, refuses a build that differs from the manifest, requires `latest == pending` nonce, and sends with an explicit nonce and a 30% gas margin. `PadDeployer` then deploys everything in its constructor and starts the hand-over; it has no functions afterwards.
5. **Readback before accept**: `RPC=<rpc1> RPC2=<a second independent rpc> DEPLOYER=<PadDeployer> MULTISIG=<safe> SALT_FILE=salt.json EXPECT_OWNERS=<owner1,owner2,...> EXPECT_THRESHOLD=<n> node scripts/readback.js`. On mainnet `SALT_FILE`, `RPC2`, `EXPECT_OWNERS` and `EXPECT_THRESHOLD` are mandatory (the script exits otherwise), the whole readback runs on both RPCs and any differing row is a FAIL, the multisig owner list must equal `EXPECT_OWNERS` exactly and the threshold `EXPECT_THRESHOLD` (>= 2), `salt.json` must carry `initcodeHash` and the deployer must equal CREATE(salt.eoa, salt.nonce), and a missing `audited-manifest.json` is a FAIL. All rows PASS; WARNs read and understood. Install with `npm ci --ignore-scripts`. Compare the printed manifest digest with the one published out of band, and independently re-verify the three addresses on a different machine (Blockscout read-contract or `cast call`).
6. **The multisig calls `hook.acceptOwner()`** promptly (until it does, the functionless PadDeployer is the owner and the platform share just accumulates). If the target was wrong, nothing has launched: redeploy with a new salt.
7. **Readback after accept**: same command with `EXPECT_OWNER_ACCEPTED=1`. Then canary launches (war and peace, both currency orderings), small buys and sells in all four variants, a burn, `collectFees`, a battle, solvency check after each step; publish addresses; verify source on the Blockscout explorer (`https://robinhoodchain.blockscout.com`).
Solvency monitor: `PoolManager.balanceOf(hook, uint160(STAG)) >= platformOwed + sum(chest + creatorOwed + holderOwed)`.

## Tests
`RH_BLOCK=<near head> npx hardhat test` (mainnet fork). `npx hardhat --config hardhat.nolimit.config.js test test/deploy.dryrun.test.js` for the deployment dry run.
