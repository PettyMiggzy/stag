// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*  HOODSTAKEVAULT — multi-collection NFT + token staking (Robinhood Chain)
 *
 *  What's new vs StagStaking v4 (single-collection, lock-in-place):
 *   • MULTI-COLLECTION NFT STAKING via ESCROW. Any owner-approved ERC-721 collection can be
 *     staked — the Hooded 20 AND the other two collections AND any FUTURE collection the owner
 *     adds later. NFTs are transferred INTO this vault (escrow) so it works with ANY standard
 *     ERC-721 with zero cooperation from the NFT contract (no custom locker interface needed).
 *   • Every staked NFT feeds the SAME reward pool and acts as a MULTIPLIER (per-collection boost,
 *     plus a per-token override) on top of your staked-token weight — exactly the "stake a hood,
 *     amplify your $STAG rewards" model, now across all collections.
 *
 *  Unchanged from the audited v4 engine:
 *   • Stake approved ERC-20s (incl. $STAG) with lock tiers 30/60/90d (1× / 1.5× / 2×, tunable).
 *   • HOLDING MULTIPLIER by STAKED $STAG (≥1M → 2×, ≥10M → 3×, tunable). Stacks multiplicatively.
 *        weight = Σ(amount×tokenWeight) × lockMult × holdMult × nftMult
 *   • ETH rewards (Synthetix accounting — payouts can never exceed funding). Funded by 90% of mint
 *     proceeds (RevenueSplitter → here) + early-unstake penalties + owner top-ups.
 *   • Withdraw-split: name up to 3 wallets to receive your withdrawn TOKENS on unstake.
 *   • Early unstake: tokens → penalty + forfeit proportional rewards; NFTs → forfeit proportional
 *     rewards, NFT returned.
 *
 *  ⚠️ Holds real funds AND escrows NFTs — get a fresh security review before mainnet.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract HoodStakeVault is Ownable, ReentrancyGuard, ERC721Holder {
    using SafeERC20 for IERC20;

    address public immutable stag;         // $STAG — drives the holding multiplier
    uint256 public constant BASE = 1e18;

    // ---- approved staking ERC-20s → weight bps (10000 = 1×). 0 = not stakeable.
    mapping(address => uint256) public tokenWeightBps;
    mapping(address => bool) public everStakeable;
    mapping(address => mapping(address => uint256)) public stakedOf;   // user => token => amount
    mapping(address => mapping(address => uint256)) private _weighted; // user => token => amount×weight/1e4

    // ---- approved NFT collections (escrow). Add current + FUTURE collections here. ----
    struct Collection {
        bool    approved;
        uint256 boostBps;     // default multiplier boost per staked NFT of this collection (bps of 1×)
        uint256 baseWeight;   // base reward weight each staked NFT of this collection adds
    }
    mapping(address => Collection) public collectionCfg;
    address[] public collectionList;                                   // enumerable (may contain de-approved)
    mapping(address => bool) private _collectionSeen;
    // per-token boost override (0 = use collection default). keyed collection => tokenId => bps
    mapping(address => mapping(uint256 => uint256)) public nftBoostBps;
    // staked-NFT ledger, keyed collection => tokenId
    mapping(address => mapping(uint256 => address)) public nftStaker;
    mapping(address => mapping(uint256 => uint256)) public appliedBoost;      // snapshot at stake time
    mapping(address => mapping(uint256 => uint256)) public appliedBaseWeight; // snapshot at stake time

    // ---- ETH reward distribution (Synthetix) ----
    uint256 public rewardRate;
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightStored;
    uint256 public totalWeight;
    uint256 public reserved;

    // ---- lock tiers (30/60/90) ----
    uint256[3] public tierDuration = [uint256(30 days), 60 days, 90 days];
    uint256[3] public tierMultBps  = [uint256(10000), 15000, 20000];   // 1× / 1.5× / 2×

    // ---- holding multiplier (by staked $STAG), ascending thresholds ----
    uint256[] public holdThreshold = [uint256(0), 1_000_000 ether, 10_000_000 ether];
    uint256[] public holdMultBps   = [uint256(10000), 20000, 30000];   // 1× / 2× / 3×

    // ---- policy ----
    uint256 public earlyPenaltyBps = 1500;      // 15% on early token unstake
    uint256 public defaultNftBoostBps = 1000;   // +10% per NFT unless collection/id override
    uint256 public defaultNftBaseWeight = 10_000 ether; // used when a collection's baseWeight is 0
    address public penaltyRecipient;
    address public operator;

    struct Nft { address collection; uint256 tokenId; }

    struct UserInfo {
        uint256 baseWeight;   // Σ amount×tokenWeight/1e4 + Σ nft baseWeight
        uint256 mult;         // NFT multiplier: BASE + boosts
        uint256 weight;       // effective (base × lock × hold × nft)
        uint256 stakedAt;     // reset on any stake (lock timer)
        uint8   lockTier;     // 0/1/2 → 30/60/90 days
        uint256 rewardPerWeightPaid;
        uint256 rewards;
        Nft[]   nfts;
        address[] splitTo;      // up to 3 wallets that receive the STAKED TOKENS on unstake
        uint256[] splitBps;     // their shares (bps); remainder goes back to the staking wallet
    }
    mapping(address => UserInfo) private _u;

    event StakedTokens(address indexed user, address indexed token, uint256 amount, uint8 tier);
    event UnstakedTokens(address indexed user, address indexed token, uint256 amount, uint256 penalty, bool early);
    event StakedNFT(address indexed user, address indexed collection, uint256 indexed tokenId);
    event UnstakedNFT(address indexed user, address indexed collection, uint256 indexed tokenId, bool early);
    event Claimed(address indexed user, uint256 ethAmount);
    event WithdrawSplitSet(address indexed user, address[] wallets, uint256[] bps);
    event RewardAdded(uint256 amount, uint256 duration);
    event PoolDonation(address indexed from, uint256 amount);
    event EthSwept(address indexed to, uint256 amount);
    event CollectionSet(address indexed collection, bool approved, uint256 boostBps, uint256 baseWeight);
    event ConfigChanged(bytes32 indexed what);

    constructor(address _stag) Ownable(msg.sender) {
        stag = _stag;
        penaltyRecipient = msg.sender;
        if (_stag != address(0)) { tokenWeightBps[_stag] = 20000; everStakeable[_stag] = true; } // $STAG token weight 2×
    }

    /* ---------------- reward math ---------------- */
    function lastTimeApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }
    function rewardPerWeight() public view returns (uint256) {
        if (totalWeight == 0) return rewardPerWeightStored;
        return rewardPerWeightStored + ((lastTimeApplicable() - lastUpdateTime) * rewardRate * BASE) / totalWeight;
    }
    function earned(address a) public view returns (uint256) {
        UserInfo storage u = _u[a];
        return (u.weight * (rewardPerWeight() - u.rewardPerWeightPaid)) / BASE + u.rewards;
    }
    modifier update(address a) {
        uint256 rpw = rewardPerWeight();
        reserved += ((rpw - rewardPerWeightStored) * totalWeight) / BASE;
        rewardPerWeightStored = rpw;
        lastUpdateTime = lastTimeApplicable();
        if (a != address(0)) {
            _u[a].rewards = earned(a);
            _u[a].rewardPerWeightPaid = rewardPerWeightStored;
        }
        _;
    }

    // effective weight = base × lockMult × holdMult × nftMult
    function holdMultBpsOf(address a) public view returns (uint256 m) {
        uint256 staked = stag == address(0) ? 0 : stakedOf[a][stag];
        m = 10000;
        uint256 n = holdThreshold.length;
        for (uint256 i = 0; i < n; i++) { if (staked >= holdThreshold[i]) m = holdMultBps[i]; }
    }
    function _effectiveWeight(address a) internal view returns (uint256) {
        UserInfo storage u = _u[a];
        uint256 w = u.baseWeight;
        if (w == 0) return 0;
        w = (w * tierMultBps[u.lockTier]) / 10000;
        w = (w * holdMultBpsOf(a)) / 10000;
        w = (w * (u.mult == 0 ? BASE : u.mult)) / BASE;
        return w;
    }
    function _resync(address a) internal {
        UserInfo storage u = _u[a];
        uint256 newW = _effectiveWeight(a);
        totalWeight = totalWeight - u.weight + newW;
        u.weight = newW;
    }

    /* ---------------- token staking ---------------- */
    function stakeTokens(address token, uint256 amount, uint8 tier) external nonReentrant update(msg.sender) {
        require(tier < 3, "bad tier");
        uint256 w = tokenWeightBps[token];
        require(w > 0, "token not approved");
        require(amount > 0, "amount=0");
        uint256 pre = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - pre;
        require(received > 0, "no tokens received");
        UserInfo storage u = _u[msg.sender];
        if (u.baseWeight > 0) require(tier >= u.lockTier, "cannot lower lock tier");
        if (u.mult == 0) u.mult = BASE;
        uint256 add = (received * w) / 10000;
        stakedOf[msg.sender][token] += received;
        _weighted[msg.sender][token] += add;
        u.baseWeight += add;
        u.lockTier = tier;
        u.stakedAt = block.timestamp;
        _resync(msg.sender);
        emit StakedTokens(msg.sender, token, received, tier);
    }

    function unstakeTokens(address token, uint256 amount) public nonReentrant update(msg.sender) {
        uint256 have = stakedOf[msg.sender][token];
        require(amount > 0 && have >= amount, "bad amount");
        UserInfo storage u = _u[msg.sender];
        bool early = block.timestamp < u.stakedAt + tierDuration[u.lockTier];

        uint256 baseBefore = u.baseWeight;
        uint256 wRemoved = (_weighted[msg.sender][token] * amount) / have;
        _weighted[msg.sender][token] -= wRemoved;
        u.baseWeight -= wRemoved;
        stakedOf[msg.sender][token] = have - amount;
        _resync(msg.sender);

        uint256 penalty;
        if (early) {
            penalty = (amount * earlyPenaltyBps) / 10000;
            uint256 f = baseBefore > 0 ? (u.rewards * wRemoved) / baseBefore : u.rewards;
            u.rewards -= f;
            reserved = reserved >= f ? reserved - f : 0;
            if (penalty > 0) IERC20(token).safeTransfer(penaltyRecipient, penalty);
        }
        _distributeWithdrawal(token, u, amount - penalty);
        emit UnstakedTokens(msg.sender, token, amount, penalty, early);
    }

    /* ---------------- NFT staking (multi-collection escrow) ---------------- */
    function stakeNFT(address collection, uint256 tokenId) external nonReentrant update(msg.sender) {
        Collection storage c = collectionCfg[collection];
        require(c.approved, "collection not approved");
        require(nftStaker[collection][tokenId] == address(0), "already staked");
        UserInfo storage u = _u[msg.sender];
        if (u.mult == 0) u.mult = BASE;

        uint256 idBoost = nftBoostBps[collection][tokenId];
        uint256 boostBps = idBoost != 0 ? idBoost : (c.boostBps != 0 ? c.boostBps : defaultNftBoostBps);
        uint256 boost = (boostBps * BASE) / 10000;
        u.mult += boost;
        appliedBoost[collection][tokenId] = boost;

        uint256 bw = c.baseWeight != 0 ? c.baseWeight : defaultNftBaseWeight;
        u.baseWeight += bw;
        appliedBaseWeight[collection][tokenId] = bw;

        u.nfts.push(Nft(collection, tokenId));
        nftStaker[collection][tokenId] = msg.sender;
        u.stakedAt = block.timestamp;
        _resync(msg.sender);

        // ESCROW: pull the NFT in. Reverts (rolling back all effects above) if not owned/approved.
        // Interactions last; nonReentrant + effects-before-interaction guard against re-entry.
        IERC721(collection).safeTransferFrom(msg.sender, address(this), tokenId);
        emit StakedNFT(msg.sender, collection, tokenId);
    }

    function unstakeNFT(address collection, uint256 tokenId) external nonReentrant update(msg.sender) {
        require(nftStaker[collection][tokenId] == msg.sender, "not your stake");
        UserInfo storage u = _u[msg.sender];
        bool early = block.timestamp < u.stakedAt + tierDuration[u.lockTier];

        uint256 n = u.nfts.length;
        uint256 idx = type(uint256).max;
        for (uint256 i; i < n; i++) {
            if (u.nfts[i].collection == collection && u.nfts[i].tokenId == tokenId) { idx = i; break; }
        }
        require(idx != type(uint256).max, "not staked");
        u.nfts[idx] = u.nfts[n - 1];
        u.nfts.pop();
        delete nftStaker[collection][tokenId];

        uint256 boost = appliedBoost[collection][tokenId];
        delete appliedBoost[collection][tokenId];
        u.mult = u.mult > boost ? u.mult - boost : BASE;

        uint256 baseBefore = u.baseWeight;
        uint256 bw = appliedBaseWeight[collection][tokenId];
        delete appliedBaseWeight[collection][tokenId];
        u.baseWeight = u.baseWeight > bw ? u.baseWeight - bw : 0;
        if (early) {
            uint256 f = baseBefore > 0 ? (u.rewards * bw) / baseBefore : u.rewards;
            u.rewards -= f;
            reserved = reserved >= f ? reserved - f : 0;
        }
        _resync(msg.sender);

        // return the escrowed NFT (interactions last)
        IERC721(collection).safeTransferFrom(address(this), msg.sender, tokenId);
        emit UnstakedNFT(msg.sender, collection, tokenId, early);
    }

    /* ---------------- withdraw split (up to 3 destination wallets for the STAKED TOKENS) ---------------- */
    function setWithdrawSplit(address[] calldata wallets, uint256[] calldata bps) external {
        require(wallets.length == bps.length && wallets.length <= 3, "bad len");
        uint256 sum;
        for (uint256 i; i < wallets.length; i++) {
            require(wallets[i] != address(0) && wallets[i] != address(this), "bad wallet");
            sum += bps[i];
        }
        require(sum <= 10000, "bps > 100%");
        UserInfo storage u = _u[msg.sender];
        u.splitTo = wallets;
        u.splitBps = bps;
        emit WithdrawSplitSet(msg.sender, wallets, bps);
    }

    function _distributeWithdrawal(address token, UserInfo storage u, uint256 net) internal {
        uint256 paidOut;
        uint256 n = u.splitTo.length;
        for (uint256 i; i < n; i++) {
            uint256 part = (net * u.splitBps[i]) / 10000;
            if (part > 0) {
                try IERC20(token).transfer(u.splitTo[i], part) returns (bool ok) { if (ok) paidOut += part; } catch {}
            }
        }
        if (net > paidOut) IERC20(token).safeTransfer(msg.sender, net - paidOut);
    }

    function claim() public nonReentrant update(msg.sender) {
        UserInfo storage u = _u[msg.sender];
        require(block.timestamp >= u.stakedAt + tierDuration[u.lockTier], "locked");
        uint256 r = u.rewards;
        if (r == 0) return;
        u.rewards = 0;
        reserved = reserved >= r ? reserved - r : 0;
        _sendEth(msg.sender, r);
        emit Claimed(msg.sender, r);
    }

    function _sendEth(address to, uint256 v) internal {
        (bool ok, ) = payable(to).call{value: v}("");
        require(ok, "eth send failed");
    }

    // Permissionless: settle + resync a batch of stakers so owner config changes apply to EXISTING
    // positions immediately and fairly. Caller pays gas; can only move weights to the current config.
    function poke(address[] calldata users) external update(address(0)) {
        for (uint256 i; i < users.length; i++) {
            address u_ = users[i];
            _u[u_].rewards = earned(u_);
            _u[u_].rewardPerWeightPaid = rewardPerWeightStored;
            _resync(u_);
        }
    }

    /* ---------------- funding / owner ---------------- */
    receive() external payable {}

    function donate() external payable {
        require(msg.value > 0, "no value");
        emit PoolDonation(msg.sender, msg.value);
    }

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

    // ---- collection management (add current + future NFT collections) ----
    function setCollection(address collection, bool approved, uint256 boostBps, uint256 baseWeight) external onlyOwner {
        require(collection != address(0), "zero");
        require(boostBps <= 5000, "boost max 50%");          // per-NFT multiplier boost cap
        Collection storage c = collectionCfg[collection];
        c.approved = approved;
        c.boostBps = boostBps;
        c.baseWeight = baseWeight;
        if (!_collectionSeen[collection]) { _collectionSeen[collection] = true; collectionList.push(collection); }
        emit CollectionSet(collection, approved, boostBps, baseWeight);
    }
    function collectionsCount() external view returns (uint256) { return collectionList.length; }

    function setOperator(address o) external onlyOwner { operator = o; }
    function setTokenWeight(address token, uint256 weightBps) external {
        require(weightBps <= 50000, "max 5x");
        if (!everStakeable[token]) require(msg.sender == owner(), "new token: owner only");
        else require(msg.sender == owner() || (operator != address(0) && msg.sender == operator), "not manager");
        tokenWeightBps[token] = weightBps;
        if (weightBps > 0) everStakeable[token] = true;
    }
    function setTierDuration(uint8 tier, uint256 secs) external onlyOwner { require(tier < 3 && secs >= 1 hours && secs <= 365 days, "bad"); tierDuration[tier] = secs; emit ConfigChanged("tierDuration"); }
    function setTierMultBps(uint8 tier, uint256 bps) external onlyOwner { require(tier < 3 && bps >= 10000 && bps <= 100000, "bad"); tierMultBps[tier] = bps; }
    function setDefaultNftBaseWeight(uint256 v) external onlyOwner { defaultNftBaseWeight = v; }
    function setHoldingTiers(uint256[] calldata thresholds, uint256[] calldata mults) external onlyOwner {
        require(thresholds.length == mults.length && thresholds.length > 0 && thresholds.length <= 10, "len");
        for (uint256 i; i < mults.length; i++) {
            require(mults[i] >= 10000 && mults[i] <= 100000, "mult");
            if (i > 0) require(thresholds[i] > thresholds[i - 1], "ascending");
        }
        holdThreshold = thresholds;
        holdMultBps = mults;
    }
    function setEarlyPenaltyBps(uint256 bps) external onlyOwner { require(bps <= 3000, "max 30%"); earlyPenaltyBps = bps; }
    function setDefaultNftBoostBps(uint256 bps) external onlyOwner { require(bps <= 5000, "max 50%"); defaultNftBoostBps = bps; }
    function setNftBoostBps(address collection, uint256 tokenId, uint256 bps) external onlyOwner { require(bps <= 5000, "max 50%"); nftBoostBps[collection][tokenId] = bps; }
    function setPenaltyRecipient(address to) external onlyOwner { require(to != address(0), "zero"); penaltyRecipient = to; }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(!everStakeable[token], "staking token");
        IERC20(token).safeTransfer(to, amount);
    }
    // Rescue an NFT that was sent here directly (NOT via stakeNFT) and so has no staker record.
    // Cannot touch an escrowed stake — nftStaker must be zero.
    function rescueNFT(address collection, uint256 tokenId, address to) external onlyOwner {
        require(nftStaker[collection][tokenId] == address(0), "staked");
        require(to != address(0), "zero");
        IERC721(collection).safeTransferFrom(address(this), to, tokenId);
    }

    // Sweep only ETH NOT owed to stakers (accrued + committed-remainder of the active schedule).
    function sweepEth(address to, uint256 amount) external onlyOwner update(address(0)) {
        uint256 outstanding = block.timestamp < periodFinish ? rewardRate * (periodFinish - block.timestamp) : 0;
        uint256 locked = reserved + outstanding;
        uint256 free = address(this).balance > locked ? address(this).balance - locked : 0;
        require(amount <= free, "exceeds free ETH");
        (bool ok, ) = payable(to).call{value: amount}(""); require(ok, "eth send failed");
        emit EthSwept(to, amount);
    }

    /* ---------------- views ---------------- */
    function userInfo(address a) external view returns (
        uint256 baseWeight, uint256 lockMultBps_, uint256 holdMult, uint256 weight,
        uint256 stakedAt, uint8 lockTier, uint256 unlockAt, uint256 pendingEth, Nft[] memory nfts, bool locked
    ) {
        UserInfo storage u = _u[a];
        uint256 unlockTs = u.stakedAt + tierDuration[u.lockTier];
        return (u.baseWeight, tierMultBps[u.lockTier], holdMultBpsOf(a), u.weight,
                u.stakedAt, u.lockTier, unlockTs, earned(a), u.nfts, block.timestamp < unlockTs);
    }
    function stakedNfts(address a) external view returns (Nft[] memory) { return _u[a].nfts; }
    function withdrawSplitOf(address a) external view returns (address[] memory, uint256[] memory) {
        return (_u[a].splitTo, _u[a].splitBps);
    }
    function tierInfo() external view returns (uint256[3] memory durations, uint256[3] memory mults) {
        return (tierDuration, tierMultBps);
    }
}
