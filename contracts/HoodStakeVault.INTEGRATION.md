# HoodStakeVault — Launchpad Integration Guide

Multi-collection **NFT + token staking** for $STAG on Robinhood Chain (chainId 4663).
Any owner-approved ERC-721 collection (the Hooded 20 + the other two + **any future collection**)
can be staked by **escrow** — the NFT is transferred into the vault. Every staked NFT feeds the
**same** ETH reward pool and acts as a **multiplier** on the staker's weight.

- ABI: `contracts/HoodStakeVault.abi.json`
- Source: `contracts/src/HoodStakeVault.sol`
- solc 0.8.24, optimizer runs=200, evm=paris
- **Constructor:** `constructor(address _stag)` → pass the new $STAG `0xcC142366735c882F7885d3c747db99e45E13E453`
- ⚠️ Not yet deployed. Get a security review + testnet run before real NFTs go in (holds ETH **and** escrows NFTs).

---

## Staker flow (what the launchpad UI wires)

### Stake an NFT (escrow — needs approval first)
```
// 1) one-time approval so the vault can pull the NFT
IERC721(collection).setApprovalForAll(VAULT, true)      // or approve(VAULT, tokenId) per id
// 2) stake
vault.stakeNFT(address collection, uint256 tokenId)
```
`stakeNFT` reverts if the collection isn't approved, if the NFT is already staked, or if the caller
doesn't own it. The NFT moves into the vault.

### Unstake an NFT (returns it)
```
vault.unstakeNFT(address collection, uint256 tokenId)
```
Returns the escrowed NFT to the staker. Before the lock elapses this is an *early* unstake:
the NFT still comes back, but rewards attributable to it are forfeited (no NFT penalty).

### Stake / unstake tokens (incl. $STAG)
```
IERC20(token).approve(VAULT, amount)
vault.stakeTokens(address token, uint256 amount, uint8 tier)   // tier 0/1/2 = 30/60/90d
vault.unstakeTokens(address token, uint256 amount)             // early = 15% penalty + forfeit
```

### Claim ETH rewards (after lock)
```
vault.claim()
```

---

## Views for the UI

| Call | Returns |
|---|---|
| `userInfo(addr)` | `(baseWeight, lockMultBps, holdMult, weight, stakedAt, lockTier, unlockAt, pendingEth, Nft[] nfts, bool locked)` |
| `stakedNfts(addr)` | `Nft[]` where `Nft = (address collection, uint256 tokenId)` |
| `earned(addr)` | pending ETH rewards (wei) |
| `holdMultBpsOf(addr)` | current holding multiplier (bps, 10000 = 1×) |
| `collectionCfg(collection)` | `(bool approved, uint256 boostBps, uint256 baseWeight)` |
| `nftStaker(collection, tokenId)` | staker address (0 = not staked) |
| `collectionsCount()` / `collectionList(i)` | enumerate approved collections |
| `tierInfo()` | `(uint256[3] durations, uint256[3] mults)` |

## Events to index
`StakedNFT(user, collection, tokenId)` · `UnstakedNFT(user, collection, tokenId, early)` ·
`StakedTokens` · `UnstakedTokens` · `Claimed` · `CollectionSet` · `RewardAdded`

---

## Owner setup (once, after deploy)

```
// approve each NFT collection: (collection, approved, boostBps, baseWeight)
vault.setCollection(0x4384cB362D908d36266bDF3C31F18DB95EB127dc, true, 1000, 10000e18)  // Hooded 20
vault.setCollection(<collection #2>, true, 1000, 10000e18)
vault.setCollection(<collection #3>, true, 1000, 10000e18)
// future collections: just call setCollection again, any time.

// fund + stream ETH rewards (RevenueSplitter should already route 90% here)
vault.notifyRewardAmount(amount, duration)
```

- `boostBps` = multiplier boost **per staked NFT** (1000 = +10%), capped 50%. Per-id override:
  `setNftBoostBps(collection, tokenId, bps)` (e.g. bigger boost for rares).
- `baseWeight` = base reward weight each staked NFT adds so NFT-only staking still earns.
- Multipliers stack multiplicatively: `weight = Σ(amount×tokenWeight) × lockMult × holdMult × nftMult`.

## Notes for the dev
- NFT identity is **(collection, tokenId)** everywhere — not tokenId alone — because it's multi-collection.
- The vault implements `onERC721Received`, so `safeTransferFrom` works. NFTs sent **directly**
  (not via `stakeNFT`) have no staker record and can be recovered by the owner via `rescueNFT`.
- De-approving a collection blocks **new** stakes but never traps already-staked NFTs (unstake always works).
