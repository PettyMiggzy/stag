// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD staking (Robinhood Chain) — v4
 *
 *  Model:
 *   • Stake approved Robinhood-Chain tokens AND/OR Hooded 20 NFTs.
 *   • ETH rewards (real yield), funded by 90% of NFT mint sales (via RevenueSplitter →
 *     this contract) + early-unstake penalties + owner top-ups. Synthetix accounting so
 *     payouts can never exceed funding.
 *   • LOCK TIERS: pick 30 / 60 / 90 days when you stake. Longer lock = bigger reward
 *     multiplier (default 1× / 1.5× / 2×, owner-tunable).
 *   • HOLDING MULTIPLIER: your STAKED $STAG amount amplifies rewards — default
 *     ≥1M → 2×, ≥10M → 3× (owner-tunable thresholds/mults). Staked (not wallet) so it
 *     can't be flash-borrowed. Stacks MULTIPLICATIVELY with the lock tier.
 *        weight = Σ(amount×tokenWeight) × lockMult × holdMult × nftMult
 *   • WITHDRAW SPLIT: name up to 3 wallets with a bps share each; when you UNSTAKE, your withdrawn
 *     $STAG principal is split to them (remainder back to you). ETH rewards on claim go to the staker.
 *     Change anytime — only the original staking wallet can.
 *   • NFT staking is LOCK-IN-PLACE (NFT never leaves the wallet; we call lock()/unlock()).
 *   • Early unstake (before the lock): tokens → 15% penalty + forfeit rewards; NFTs →
 *     forfeit rewards (no penalty, keep the NFT).
 *
 *  ⚠️ Holds real funds — get a security review before mainnet.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IHoodLockable {
    function ownerOf(uint256 tokenId) external view returns (address);
    function lock(uint256 tokenId) external;
    function unlock(uint256 tokenId) external;
}

contract StagStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IHoodLockable public immutable hood;   // Hooded 20 NFT (0 to disable NFT staking)
    address public immutable stag;         // $STAG — drives the holding multiplier
    uint256 public constant BASE = 1e18;

    // approved staking tokens → weight bps (10000 = 1×). 0 = not stakeable.
    mapping(address => uint256) public tokenWeightBps;
    mapping(address => bool) public everStakeable;
    mapping(address => mapping(address => uint256)) public stakedOf;   // user => token => amount
    mapping(address => mapping(address => uint256)) private _weighted; // user => token => amount×weight/1e4

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
    uint256 public defaultNftBoostBps = 1000;   // +10% per NFT unless set per-id
    address public penaltyRecipient;
    address public operator;
    mapping(uint256 => uint256) public nftBoostBps;
    mapping(uint256 => address) public nftStaker;
    mapping(uint256 => uint256) public appliedBoost;
    uint256 public nftBaseWeight = 10_000 ether;          // base weight each staked NFT adds (owner-tuned tokenomics knob; keep modest vs token weights to avoid cheap pool dominance)
    mapping(uint256 => uint256) public appliedBaseWeight;  // snapshot of base weight added per staked NFT

    struct UserInfo {
        uint256 baseWeight;   // Σ amount×tokenWeight/1e4
        uint256 mult;         // NFT multiplier: BASE + boosts
        uint256 weight;       // effective (base × lock × hold × nft)
        uint256 stakedAt;     // reset on any stake (lock timer)
        uint8   lockTier;     // 0/1/2 → 30/60/90 days
        uint256 rewardPerWeightPaid;
        uint256 rewards;
        uint256[] nfts;
        address[] splitTo;      // up to 3 wallets that receive the STAKED TOKENS on unstake
        uint256[] splitBps;     // their shares (bps); remainder goes back to the staking wallet
    }
    mapping(address => UserInfo) private _u;

    event StakedTokens(address indexed user, address indexed token, uint256 amount, uint8 tier);
    event UnstakedTokens(address indexed user, address indexed token, uint256 amount, uint256 penalty, bool early);
    event StakedNFT(address indexed user, uint256 tokenId);
    event UnstakedNFT(address indexed user, uint256 tokenId, bool early);
    event Claimed(address indexed user, uint256 ethAmount);
    event WithdrawSplitSet(address indexed user, address[] wallets, uint256[] bps);
    event RewardAdded(uint256 amount, uint256 duration);
    event PoolDonation(address indexed from, uint256 amount);
    event EthSwept(address indexed to, uint256 amount);
    event NftUnlockFailed(uint256 indexed tokenId, address indexed staker); // unlock() reverted (locker migrated) — recover via retryUnlock or hood.adminUnlock
    event ConfigChanged(bytes32 indexed what);

    mapping(uint256 => bool) public pendingUnlock; // tokenId => unlock() failed and is owed

    constructor(address _stag, address _hood) Ownable(msg.sender) {
        hood = IHoodLockable(_hood);
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
        // adding to an active position may raise the lock tier but never lower it (no multiplier downgrade)
        if (u.baseWeight > 0) require(tier >= u.lockTier, "cannot lower lock tier");
        if (u.mult == 0) u.mult = BASE;
        uint256 add = (received * w) / 10000;
        stakedOf[msg.sender][token] += received;
        _weighted[msg.sender][token] += add;
        u.baseWeight += add;
        u.lockTier = tier;             // adding to a stake (re)commits to this tier…
        u.stakedAt = block.timestamp;  // …and restarts the lock timer (claim before topping up)
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
            // forfeit rewards PROPORTIONAL to the base weight withdrawn (not the whole position)
            uint256 f = baseBefore > 0 ? (u.rewards * wRemoved) / baseBefore : u.rewards;
            u.rewards -= f;
            reserved = reserved >= f ? reserved - f : 0;
            if (penalty > 0) IERC20(token).safeTransfer(penaltyRecipient, penalty);
        }
        // withdrawn tokens go to the staker's chosen split wallets (up to 3), remainder to the staker
        _distributeWithdrawal(token, u, amount - penalty);
        emit UnstakedTokens(msg.sender, token, amount, penalty, early);
    }

    /* ---------------- NFT staking (lock-in-place) ---------------- */
    function stakeNFT(uint256 tokenId) external nonReentrant update(msg.sender) {
        require(address(hood) != address(0), "nft disabled");
        require(hood.ownerOf(tokenId) == msg.sender, "not owner");
        require(nftStaker[tokenId] == address(0), "already staked");
        UserInfo storage u = _u[msg.sender];
        if (u.mult == 0) u.mult = BASE;
        uint256 boostBps = nftBoostBps[tokenId] == 0 ? defaultNftBoostBps : nftBoostBps[tokenId];
        uint256 boost = (boostBps * BASE) / 10000;
        u.mult += boost;
        appliedBoost[tokenId] = boost;
        // NFTs also add BASE weight so NFT-only staking actually earns (not just a multiplier on 0)
        u.baseWeight += nftBaseWeight;
        appliedBaseWeight[tokenId] = nftBaseWeight;
        u.nfts.push(tokenId);
        nftStaker[tokenId] = msg.sender;
        u.stakedAt = block.timestamp;
        _resync(msg.sender);
        hood.lock(tokenId);
        emit StakedNFT(msg.sender, tokenId);
    }

    function unstakeNFT(uint256 tokenId) external nonReentrant update(msg.sender) {
        require(nftStaker[tokenId] == msg.sender, "not your stake");
        UserInfo storage u = _u[msg.sender];
        bool early = block.timestamp < u.stakedAt + tierDuration[u.lockTier];
        uint256 n = u.nfts.length;
        uint256 idx = type(uint256).max;
        for (uint256 i; i < n; i++) { if (u.nfts[i] == tokenId) { idx = i; break; } }
        require(idx != type(uint256).max, "not staked");
        u.nfts[idx] = u.nfts[n - 1];
        u.nfts.pop();
        delete nftStaker[tokenId];
        uint256 boost = appliedBoost[tokenId];
        delete appliedBoost[tokenId];
        u.mult = u.mult > boost ? u.mult - boost : BASE;
        uint256 baseBefore = u.baseWeight;
        uint256 bw = appliedBaseWeight[tokenId];
        delete appliedBaseWeight[tokenId];
        u.baseWeight = u.baseWeight > bw ? u.baseWeight - bw : 0;
        if (early) {  // forfeit rewards proportional to the base weight this NFT contributed
            uint256 f = baseBefore > 0 ? (u.rewards * bw) / baseBefore : u.rewards;
            u.rewards -= f;
            reserved = reserved >= f ? reserved - f : 0;
        }
        _resync(msg.sender);
        // Don't let a migrated/broken locker brick unstaking; but DON'T fail silently — flag it.
        try hood.unlock(tokenId) {} catch { pendingUnlock[tokenId] = true; emit NftUnlockFailed(tokenId, msg.sender); }
        emit UnstakedNFT(msg.sender, tokenId, early);
    }

    /* ---------------- withdraw split (up to 3 destination wallets for the STAKED TOKENS) ---------------- */
    // Name up to 3 wallets + a share (bps) each; when you unstake, your withdrawn $STAG is split to
    // them (remainder back to you). Change anytime — only the original staking wallet can.
    function setWithdrawSplit(address[] calldata wallets, uint256[] calldata bps) external {
        require(wallets.length == bps.length && wallets.length <= 3, "bad len");
        uint256 sum;
        for (uint256 i; i < wallets.length; i++) {
            require(wallets[i] != address(0) && wallets[i] != address(this), "bad wallet"); // no self-strand
            sum += bps[i];
        }
        require(sum <= 10000, "bps > 100%");
        UserInfo storage u = _u[msg.sender];
        u.splitTo = wallets;
        u.splitBps = bps;
        emit WithdrawSplitSet(msg.sender, wallets, bps);
    }

    // Split `net` withdrawn tokens across the staker's chosen wallets (best-effort so a bad
    // destination can't brick unstaking); anything unsent goes back to the staker.
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
        _sendEth(msg.sender, r);   // ETH rewards go to the staker; the up-to-3 split is on the TOKENS at unstake
        emit Claimed(msg.sender, r);
    }

    function _sendEth(address to, uint256 v) internal {
        (bool ok, ) = payable(to).call{value: v}("");
        require(ok, "eth send failed");
    }

    // Permissionless: settle + resync a batch of stakers so owner config changes (multipliers,
    // weights, nftBaseWeight) apply to EXISTING positions immediately and fairly — not only on
    // each user's next action. Caller pays the gas; it can only move weights to the current config.
    function poke(address[] calldata users) external update(address(0)) {
        for (uint256 i; i < users.length; i++) {
            address u_ = users[i];
            _u[u_].rewards = earned(u_);
            _u[u_].rewardPerWeightPaid = rewardPerWeightStored;
            _resync(u_);
        }
    }

    // Re-attempt a previously-failed NFT unlock (e.g. after the locker is restored). No-op-safe.
    function retryUnlock(uint256 tokenId) external {
        require(pendingUnlock[tokenId], "no pending");
        hood.unlock(tokenId);           // reverts (no state change) if this is still not the locker
        pendingUnlock[tokenId] = false;
    }

    /* ---------------- funding / owner ---------------- */
    receive() external payable {}

    /// @notice Anyone can top up the reward pool with ETH. Funds sit in the pool until the
    /// owner streams them via `notifyRewardAmount`. Named + evented so wallets/explorers show
    /// a clear "Donate" action (scanner-legible, single recipient = this pool).
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
    function setNftBaseWeight(uint256 v) external onlyOwner { nftBaseWeight = v; }
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
    function setNftBoostBps(uint256 tokenId, uint256 bps) external onlyOwner { require(bps <= 5000, "max 50%"); nftBoostBps[tokenId] = bps; }
    function setPenaltyRecipient(address to) external onlyOwner { require(to != address(0), "zero"); penaltyRecipient = to; }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(!everStakeable[token], "staking token");
        IERC20(token).safeTransfer(to, amount);
    }

    // Sweep only ETH NOT owed to stakers. `update(address(0))` first settles accrual into `reserved`,
    // and we ALSO subtract the still-streaming scheduled emissions of the active period. So a sweep
    // can never unfund already-accrued rewards OR the committed remainder of a live reward schedule.
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
        uint256 stakedAt, uint8 lockTier, uint256 unlockAt, uint256 pendingEth, uint256[] memory nfts, bool locked
    ) {
        UserInfo storage u = _u[a];
        uint256 unlock = u.stakedAt + tierDuration[u.lockTier];
        return (u.baseWeight, tierMultBps[u.lockTier], holdMultBpsOf(a), u.weight,
                u.stakedAt, u.lockTier, unlock, earned(a), u.nfts, block.timestamp < unlock);
    }
    function withdrawSplitOf(address a) external view returns (address[] memory, uint256[] memory) {
        return (_u[a].splitTo, _u[a].splitBps);
    }
    function tierInfo() external view returns (uint256[3] memory durations, uint256[3] memory mults) {
        return (tierDuration, tierMultBps);
    }
}
