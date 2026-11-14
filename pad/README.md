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
- Starting price snaps to the pool's 60-tick grid in the creator's favour: the real start is at or slightly above the request (up to ~0.6%), never below.
- Routers: standard v4 routers work; a router that syncs $STAG before the swap works (the holder flush steps aside).

## Mainnet deployment (see scripts/)
1. Read `scripts/readback.js` pre-flight list; use `hardhat.nolimit.config.js` (real size limits).
2. Mine the salt LAST for the exact compiled bytecode and the deployer EOA + nonce: `node scripts/mine-salt.js --eoa <addr> --nonce <n> --out salt.json`. Send nothing else from that EOA and do not recompile in between.
3. `scripts/deploy.js` deploys `PadDeployer` (constructor-only): CREATE2s the hook with `owner = deployer`, deploys factory and battle, wires, starts the hand-over to the multisig.
4. The multisig calls `hook.acceptOwner()`. Run the readback with `EXPECT_OWNER_ACCEPTED=1`; discard the deployer key.
5. Canary launches (war and peace, both currency orderings), small buys/sells in all four variants, a burn, `collectFees`, a battle, solvency check after each step; then publish addresses and verify source on the Blockscout explorer.
Solvency monitor: `PoolManager.balanceOf(hook, uint160(STAG)) >= platformOwed + sum(chest + creatorOwed + holderOwed)`.

## Tests
`RH_BLOCK=<near head> npx hardhat test` (mainnet fork). `npx hardhat --config hardhat.nolimit.config.js test test/deploy.dryrun.test.js` for the deployment dry run.
