// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD staking (Robinhood Chain) — v3
 *
 *  Model:
 *   • Stake approved Robinhood-Chain tokens AND/OR Hooded 20 NFTs.
 *   • Each approved token has a weight; $STAG is 2× (weight 20000 bps) vs a
 *     1× (10000 bps) baseline for other approved tokens.
 *     ⚠️ Owner-APPROVED list on purpose: letting the contract accept ANY token
 *     by raw amount is a drain vector (mint a quadrillion junk tokens → steal
 *     the pool). Owner enables the tokens to support + sets each weight.
 *   • Rewards paid in ETH (real yield), funded by 60% of NFT mint sales (via
 *     RevenueSplitter → this contract) + owner top-ups.
 *   • Reward WEIGHT = (Σ stakedAmount×tokenWeight) × nftMultiplier.
 *     NFTs boost your multiplier (rarity, owner-set). Staking ONLY NFTs = weight 0
 *     = no rewards.
 *   • NFT staking is LOCK-IN-PLACE (NFT never leaves the wallet; we call the
 *     NFT's lock()/unlock(); no custody, no setApprovalForAll).
 *   • Early unstake (before the lock): tokens → 15% penalty + forfeit rewards;
 *     NFTs → forfeit rewards (no penalty, you keep the NFT).
 *
 *  Synthetix notifyRewardAmount accounting so ETH payouts never exceed funding.
 *  ⚠️ Holds real funds — test on testnet (46630), get a review before mainnet.
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

    IHoodLockable public immutable hood;                 // Hooded 20 NFT (0 to disable NFT staking)
    uint256 public constant BASE = 1e18;

    // approved staking tokens → weight bps (10000 = 1×). 0 = not stakeable. $STAG = 20000 (2×).
    mapping(address => uint256) public tokenWeightBps;
    mapping(address => bool) public everStakeable;    // ever approved → holds principal, never rescuable
    mapping(address => mapping(address => uint256)) public stakedOf;        // user => token => amount
    mapping(address => mapping(address => uint256)) private _weighted;      // user => token => amount×weight/1e4 recorded at stake

    // ---- ETH reward distribution (Synthetix) ----
    uint256 public rewardRate;         // wei/sec
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightStored;
    uint256 public totalWeight;
    uint256 public reserved;           // ETH already allocated to stakers but not yet claimed (a liability)

    // ---- policy (owner-tunable) ----
    uint256 public lockPeriod = 7 days;
    uint256 public earlyPenaltyBps = 1500;             // 15% on early token unstake
    uint256 public defaultNftBoostBps = 1000;          // +10% per NFT unless set per-id
    address public penaltyRecipient;
    address public operator;                           // may approve stakeable tokens (owner-appointed)
    mapping(uint256 => uint256) public nftBoostBps;    // tokenId => boost bps (owner sets by rarity)
    mapping(uint256 => address) public nftStaker;      // tokenId => who staked it
    mapping(uint256 => uint256) public appliedBoost;   // tokenId => mult fraction added at stake (snapshot)

    struct UserInfo {
        uint256 baseWeight;            // Σ amount×tokenWeight/1e4 across staked tokens
        uint256 mult;                  // BASE + NFT boosts
        uint256 weight;                // baseWeight × mult / BASE
        uint256 stakedAt;             // reset on any stake (lock timer)
        uint256 rewardPerWeightPaid;
        uint256 rewards;
        uint256[] nfts;
    }
    mapping(address => UserInfo) private _u;

    event StakedTokens(address indexed user, address indexed token, uint256 amount);
    event UnstakedTokens(address indexed user, address indexed token, uint256 amount, uint256 penalty, bool early);
    event StakedNFT(address indexed user, uint256 tokenId);
    event UnstakedNFT(address indexed user, uint256 tokenId, bool early);
    event Claimed(address indexed user, uint256 ethAmount);
    event RewardAdded(uint256 amount, uint256 duration);

    constructor(address _stag, address _hood) Ownable(msg.sender) {
        hood = IHoodLockable(_hood);
        penaltyRecipient = msg.sender;
        if (_stag != address(0)) { tokenWeightBps[_stag] = 20000; everStakeable[_stag] = true; }   // $STAG = 2×
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
        reserved += ((rpw - rewardPerWeightStored) * totalWeight) / BASE;   // ETH allocated since last update
        rewardPerWeightStored = rpw;
        lastUpdateTime = lastTimeApplicable();
        if (a != address(0)) {
            _u[a].rewards = earned(a);
            _u[a].rewardPerWeightPaid = rewardPerWeightStored;
        }
        _;
    }
    function _resync(address a) internal {
        UserInfo storage u = _u[a];
        uint256 newW = (u.baseWeight * u.mult) / BASE;
        totalWeight = totalWeight - u.weight + newW;
        u.weight = newW;
    }

    /* ---------------- token staking (multi-token, weighted) ---------------- */
    function stakeTokens(address token, uint256 amount) external nonReentrant update(msg.sender) {
        uint256 w = tokenWeightBps[token];
        require(w > 0, "token not approved");
        require(amount > 0, "amount=0");
        // credit what we ACTUALLY receive (defends against fee-on-transfer tokens crediting
        // more than was deposited, which would let a staker siphon others' principal).
        // Rebasing tokens still shouldn't be approved — only standard ERC-20s.
        uint256 pre = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - pre;
        require(received > 0, "no tokens received");
        UserInfo storage u = _u[msg.sender];
        if (u.mult == 0) u.mult = BASE;
        uint256 add = (received * w) / 10000;
        stakedOf[msg.sender][token] += received;
        _weighted[msg.sender][token] += add;
        u.baseWeight += add;
        u.stakedAt = block.timestamp;
        _resync(msg.sender);
        emit StakedTokens(msg.sender, token, received);
    }

    function unstakeTokens(address token, uint256 amount) public nonReentrant update(msg.sender) {
        uint256 have = stakedOf[msg.sender][token];
        require(amount > 0 && have >= amount, "bad amount");
        UserInfo storage u = _u[msg.sender];
        bool early = block.timestamp < u.stakedAt + lockPeriod;

        // reduce weight proportionally (robust to any weight change since staking)
        uint256 wRemoved = (_weighted[msg.sender][token] * amount) / have;
        _weighted[msg.sender][token] -= wRemoved;
        u.baseWeight -= wRemoved;
        stakedOf[msg.sender][token] = have - amount;
        _resync(msg.sender);

        uint256 penalty;
        if (early) {
            penalty = (amount * earlyPenaltyBps) / 10000;
            uint256 f = u.rewards; u.rewards = 0;       // forfeit unclaimed rewards (free the ETH)
            reserved = reserved >= f ? reserved - f : 0;
            if (penalty > 0) IERC20(token).safeTransfer(penaltyRecipient, penalty);
        }
        IERC20(token).safeTransfer(msg.sender, amount - penalty);
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
        appliedBoost[tokenId] = boost;                 // snapshot the exact boost applied
        u.nfts.push(tokenId);
        nftStaker[tokenId] = msg.sender;
        u.stakedAt = block.timestamp;
        _resync(msg.sender);
        hood.lock(tokenId);                            // NFT stays in wallet, becomes non-transferable
        emit StakedNFT(msg.sender, tokenId);
    }

    function unstakeNFT(uint256 tokenId) external nonReentrant update(msg.sender) {
        require(nftStaker[tokenId] == msg.sender, "not your stake");
        UserInfo storage u = _u[msg.sender];
        bool early = block.timestamp < u.stakedAt + lockPeriod;
        uint256 n = u.nfts.length;
        uint256 idx = type(uint256).max;
        for (uint256 i; i < n; i++) { if (u.nfts[i] == tokenId) { idx = i; break; } }
        require(idx != type(uint256).max, "not staked");
        u.nfts[idx] = u.nfts[n - 1];
        u.nfts.pop();
        delete nftStaker[tokenId];
        uint256 boost = appliedBoost[tokenId];         // exact boost added at stake (config-change safe)
        delete appliedBoost[tokenId];
        u.mult = u.mult > boost ? u.mult - boost : BASE;
        if (early) { uint256 f = u.rewards; u.rewards = 0; reserved = reserved >= f ? reserved - f : 0; } // forfeit
        _resync(msg.sender);
        try hood.unlock(tokenId) {} catch {}   // clean up staking state even if locker was migrated
        emit UnstakedNFT(msg.sender, tokenId, early);
    }

    function claim() public nonReentrant update(msg.sender) {
        // rewards are claimable only after the lock — otherwise you could claim, then
        // early-unstake forfeiting nothing, defeating the "lose rewards if you exit early" rule.
        // (Adding to your stake restarts the lock; see stakedAt.)
        require(block.timestamp >= _u[msg.sender].stakedAt + lockPeriod, "locked");
        uint256 r = _u[msg.sender].rewards;
        if (r > 0) {
            _u[msg.sender].rewards = 0;
            reserved = reserved >= r ? reserved - r : 0;
            (bool ok, ) = payable(msg.sender).call{value: r}("");
            require(ok, "eth send failed");
            emit Claimed(msg.sender, r);
        }
    }

    /* ---------------- funding / owner ---------------- */
    receive() external payable {}     // ETH from the splitter (60% of mint sales) + owner top-ups

    function notifyRewardAmount(uint256 amount, uint256 duration) external onlyOwner update(address(0)) {
        require(duration > 0, "duration=0");
        if (block.timestamp >= periodFinish) rewardRate = amount / duration;
        else rewardRate = (amount + (periodFinish - block.timestamp) * rewardRate) / duration;
        require(rewardRate > 0, "rate=0");
        // only ETH not already owed to stakers may back a new period (prevents over-commit / insolvency)
        uint256 avail = address(this).balance > reserved ? address(this).balance - reserved : 0;
        require(rewardRate * duration <= avail, "insufficient ETH funded");
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(amount, duration);
    }

    function setOperator(address o) external onlyOwner { operator = o; }

    // Set a stakeable token's weight (10000 = 1×, 20000 = 2×). 0 = stop new stakes.
    // Approving a NEW token is owner-only — approving a manipulable/junk token is the main
    // drain vector, so a lower-trust operator can only ADJUST tokens the owner already vetted.
    function setTokenWeight(address token, uint256 weightBps) external {
        require(weightBps <= 50000, "max 5x");
        if (!everStakeable[token]) require(msg.sender == owner(), "new token: owner only");
        else require(msg.sender == owner() || (operator != address(0) && msg.sender == operator), "not manager");
        tokenWeightBps[token] = weightBps;
        if (weightBps > 0) everStakeable[token] = true;
    }
    function setLockPeriod(uint256 s) external onlyOwner { require(s <= 90 days, "too long"); lockPeriod = s; }
    function setEarlyPenaltyBps(uint256 bps) external onlyOwner { require(bps <= 3000, "max 30%"); earlyPenaltyBps = bps; }
    function setDefaultNftBoostBps(uint256 bps) external onlyOwner { require(bps <= 5000, "max 50%"); defaultNftBoostBps = bps; }
    function setNftBoostBps(uint256 tokenId, uint256 bps) external onlyOwner { require(bps <= 5000, "max 50%"); nftBoostBps[tokenId] = bps; }
    function setPenaltyRecipient(address to) external onlyOwner { require(to != address(0), "zero"); penaltyRecipient = to; }

    // rescue a token that was never a staking token (so it holds no user principal)
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(!everStakeable[token], "staking token");
        IERC20(token).safeTransfer(to, amount);
    }

    /* ---------------- views ---------------- */
    function userInfo(address a) external view returns (
        uint256 baseWeight, uint256 mult, uint256 weight, uint256 stakedAt, uint256 pendingEth, uint256[] memory nfts, bool locked
    ) {
        UserInfo storage u = _u[a];
        return (u.baseWeight, u.mult == 0 ? BASE : u.mult, u.weight, u.stakedAt, earned(a), u.nfts, block.timestamp < u.stakedAt + lockPeriod);
    }
}
