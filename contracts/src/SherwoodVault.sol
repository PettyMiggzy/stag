// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*  SherwoodVault — STAGWIFHOOD's future-proof NFT staking (Robinhood Chain 4663).
 *
 *  Why it exists: the live StagStaking hardcodes ONE NFT collection (the Hooded 20) forever.
 *  This vault is collection-AGNOSTIC — the owner registers any collection with one call
 *  (addCollection), so Sherwood Saints and every future drop can be staked with NO redeploy.
 *
 *  Two staking modes:
 *   • CUSTODY      — works with ANY ERC-721 as-is (e.g. Saints). Deposit the NFT to earn; unstake to return.
 *   • LOCK-IN-PLACE — for collections that expose lock()/unlock() (ERC-5192 style, like the Hooded 20):
 *                     the NFT never leaves the wallet; the vault just locks/unlocks it.
 *
 *  Rewards: real ETH, streamed by weight (same proven mechanism as StagStaking). Its OWN pool,
 *  fundable by donate()/receive() and streamed by the owner via notifyRewardAmount — so future
 *  mint revenue can feed it (send a slice to this address, then stream it). Runs ALONGSIDE
 *  StagStaking; nothing migrates.
 *
 *  Custody note: uses plain transferFrom (no receiver hook), and does NOT implement
 *  IERC721Receiver — so a stray safeTransferFrom to this vault reverts instead of stranding an NFT.
 *  Only stake() (with prior approval) can deposit.
 *
 *  ⚠️ Holds NFTs + an ETH reward pool. Audited + tested before mainnet.
 */

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ILockable { function lock(uint256 tokenId) external; function unlock(uint256 tokenId) external; }

contract SherwoodVault is Ownable, ReentrancyGuard {
    uint256 private constant BASE = 1e18;

    struct Collection { bool known; bool enabled; bool lockInPlace; uint256 weight; } // weight added per staked NFT
    mapping(address => Collection) public collections;
    address[] public collectionList;

    struct StakeInfo { address staker; uint256 weight; uint64 since; } // snapshot weight at stake time
    mapping(address => mapping(uint256 => StakeInfo)) public stakeOf; // collection => tokenId => info

    struct Ref { address collection; uint256 tokenId; }
    mapping(address => Ref[]) private _userStakes;                       // user => staked (collection,tokenId) list
    mapping(address => mapping(uint256 => uint256)) private _refPos;     // collection => tokenId => (index+1) in staker's list

    // ---- reward streaming by weight (mirrors StagStaking) ----
    uint256 public totalWeight;
    mapping(address => uint256) public weightOf;
    uint256 public rewardRate;
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightStored;
    uint256 public reserved;                       // rewards already accrued to stakers (never re-streamable)
    mapping(address => uint256) public rewardPerWeightPaid;
    mapping(address => uint256) public rewards;

    event CollectionSet(address indexed nft, uint256 weight, bool lockInPlace, bool enabled);
    event Staked(address indexed user, address indexed nft, uint256 indexed tokenId, uint256 weight);
    event Unstaked(address indexed user, address indexed nft, uint256 indexed tokenId);
    event Claimed(address indexed user, uint256 amount);
    event Donated(address indexed from, uint256 amount);
    event RewardAdded(uint256 amount, uint256 duration);

    constructor(address admin) Ownable(admin) {}

    /* ---------------- reward math ---------------- */
    function lastTimeApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }
    function rewardPerWeight() public view returns (uint256) {
        if (totalWeight == 0) return rewardPerWeightStored;
        return rewardPerWeightStored + ((lastTimeApplicable() - lastUpdateTime) * rewardRate * BASE) / totalWeight;
    }
    function earned(address a) public view returns (uint256) {
        return (weightOf[a] * (rewardPerWeight() - rewardPerWeightPaid[a])) / BASE + rewards[a];
    }
    modifier update(address a) {
        uint256 rpw = rewardPerWeight();
        reserved += ((rpw - rewardPerWeightStored) * totalWeight) / BASE;
        rewardPerWeightStored = rpw;
        lastUpdateTime = lastTimeApplicable();
        if (a != address(0)) { rewards[a] = earned(a); rewardPerWeightPaid[a] = rewardPerWeightStored; }
        _;
    }

    /* ---------------- staking ---------------- */
    function stake(address nft, uint256 tokenId) external nonReentrant update(msg.sender) {
        Collection memory c = collections[nft];
        require(c.enabled, "collection not enabled");
        require(stakeOf[nft][tokenId].staker == address(0), "already staked");
        require(IERC721(nft).ownerOf(tokenId) == msg.sender, "not owner");

        // effects (CEI) — snapshot the weight so a later weight change can't strand accounting
        stakeOf[nft][tokenId] = StakeInfo(msg.sender, c.weight, uint64(block.timestamp));
        weightOf[msg.sender] += c.weight;
        totalWeight += c.weight;
        _userStakes[msg.sender].push(Ref(nft, tokenId));
        _refPos[nft][tokenId] = _userStakes[msg.sender].length;

        // interaction: lock in place, or take custody
        if (c.lockInPlace) ILockable(nft).lock(tokenId);
        else IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        emit Staked(msg.sender, nft, tokenId, c.weight);
    }

    function unstake(address nft, uint256 tokenId) external nonReentrant update(msg.sender) {
        StakeInfo memory s = stakeOf[nft][tokenId];
        require(s.staker == msg.sender, "not staker");

        // effects (CEI)
        weightOf[msg.sender] -= s.weight;
        totalWeight -= s.weight;
        delete stakeOf[nft][tokenId];
        _removeRef(msg.sender, nft, tokenId);

        // interaction: unlock in place, or return custody
        if (collections[nft].lockInPlace) ILockable(nft).unlock(tokenId);
        else IERC721(nft).transferFrom(address(this), msg.sender, tokenId);
        emit Unstaked(msg.sender, nft, tokenId);
    }

    /// @notice Claim accrued ETH rewards. Reward accrues while staked; no lock period.
    function claim() external nonReentrant update(msg.sender) {
        uint256 r = rewards[msg.sender];
        if (r == 0) return;
        rewards[msg.sender] = 0;
        reserved = reserved >= r ? reserved - r : 0;
        (bool ok, ) = payable(msg.sender).call{value: r}("");
        require(ok, "eth send failed");
        emit Claimed(msg.sender, r);
    }

    /* ---------------- funding / owner ---------------- */
    receive() external payable {}

    /// @notice Anyone can top up the pool. Owner then streams it via notifyRewardAmount. Future
    ///         mint splitters can send a slice here — that's how new drops "feed the pool".
    function donate() external payable { require(msg.value > 0, "no value"); emit Donated(msg.sender, msg.value); }

    function notifyRewardAmount(uint256 amount, uint256 duration) external onlyOwner update(address(0)) {
        require(duration > 0, "duration=0");
        if (block.timestamp >= periodFinish) rewardRate = amount / duration;
        else rewardRate = (amount + (periodFinish - block.timestamp) * rewardRate) / duration;
        require(rewardRate > 0, "rate=0");
        uint256 avail = address(this).balance > reserved ? address(this).balance - reserved : 0;
        require(rewardRate * duration <= avail, "insufficient ETH funded");
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(amount, duration);
    }

    /// @notice Register (or update) a stakeable collection. weight = reward weight added per staked NFT.
    ///         lockInPlace=true requires the collection to expose lock()/unlock() and to trust this
    ///         vault as its locker. New/updated weight applies to FUTURE stakes; existing stakes keep
    ///         their snapshot weight (fair — no retro-nerf or griefing).
    function addCollection(address nft, uint256 weight, bool lockInPlace) external onlyOwner {
        require(nft != address(0), "zero");
        require(weight > 0, "weight=0");
        Collection storage c = collections[nft];
        if (!c.known) { c.known = true; collectionList.push(nft); }
        c.enabled = true; c.lockInPlace = lockInPlace; c.weight = weight;
        emit CollectionSet(nft, weight, lockInPlace, true);
    }

    /// @notice Pause/resume NEW stakes for a collection. Existing stakes are unaffected (can always unstake).
    function setCollectionEnabled(address nft, bool enabled) external onlyOwner {
        require(collections[nft].known, "unknown");
        collections[nft].enabled = enabled;
        Collection memory c = collections[nft];
        emit CollectionSet(nft, c.weight, c.lockInPlace, enabled);
    }

    /* ---------------- enumerable views (UI, no indexer needed) ---------------- */
    function _removeRef(address user, address nft, uint256 tokenId) internal {
        uint256 idx1 = _refPos[nft][tokenId];
        if (idx1 == 0) return;
        uint256 idx = idx1 - 1;
        Ref[] storage arr = _userStakes[user];
        uint256 last = arr.length - 1;
        if (idx != last) {
            Ref memory moved = arr[last];
            arr[idx] = moved;
            _refPos[moved.collection][moved.tokenId] = idx + 1;
        }
        arr.pop();
        _refPos[nft][tokenId] = 0;
    }

    function stakedByUser(address user) external view returns (Ref[] memory) { return _userStakes[user]; }
    function stakedCountOf(address user) external view returns (uint256) { return _userStakes[user].length; }
    function collectionsCount() external view returns (uint256) { return collectionList.length; }
    function allCollections() external view returns (address[] memory) { return collectionList; }
}
