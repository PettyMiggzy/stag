// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD staking (Robinhood Chain) — v2
 *
 *  Model (per project spec):
 *   • Stake $STAG tokens and/or The Hooded 20 NFTs.
 *   • Rewards are paid in ETH (real yield). The pool is funded by 30% of NFT
 *     mint sales (auto-forwarded from HoodedTwenty) plus owner top-ups.
 *   • Rewards accrue on your WEIGHT = stakedTokens × nftMultiplier.
 *     Staking NFTs boosts your multiplier (by rarity, owner-configurable).
 *     Staking ONLY NFTs (zero tokens) = weight 0 = no rewards. ✓
 *   • Early unstake (before lockPeriod): 15% penalty on the tokens unstaked
 *     AND you forfeit all unclaimed rewards. After the lock: no penalty.
 *
 *  Reward accounting is the Synthetix notifyRewardAmount pattern, adapted to a
 *  weighted stake and native-ETH rewards, so payouts can never exceed funding.
 *
 *  ⚠️ Holds real funds — TEST on Robinhood Chain testnet (46630) and get a
 *  review before mainnet.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract StagStaking is Ownable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    IERC20  public immutable stag;   // $STAG staking token
    IERC721 public immutable hood;   // The Hooded 20 NFT (address(0) to disable NFT staking)

    uint256 public constant BASE = 1e18;              // multiplier base = 1.0x

    // ---- ETH reward distribution (Synthetix-style) ----
    uint256 public rewardRate;        // wei/sec
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightStored;
    uint256 public totalWeight;

    // ---- policy (owner-tunable) ----
    uint256 public lockPeriod = 7 days;
    uint256 public earlyPenaltyBps = 1500;            // 15%
    uint256 public defaultNftBoostBps = 1000;         // +10% per NFT unless set per-id
    address public penaltyRecipient;                  // where penalty $STAG goes (default owner)
    mapping(uint256 => uint256) public nftBoostBps;   // tokenId => boost bps (owner sets by rarity)

    struct UserInfo {
        uint256 amount;               // $STAG staked
        uint256 mult;                 // BASE + sum of NFT boosts
        uint256 weight;               // amount * mult / BASE
        uint256 stakedAt;             // set when tokens are added (lock timer)
        uint256 rewardPerWeightPaid;
        uint256 rewards;              // accrued ETH
        uint256[] nfts;               // staked token ids
    }
    mapping(address => UserInfo) private _u;

    event StakedTokens(address indexed user, uint256 amount);
    event UnstakedTokens(address indexed user, uint256 amount, uint256 penalty, bool early);
    event StakedNFT(address indexed user, uint256 tokenId);
    event UnstakedNFT(address indexed user, uint256 tokenId);
    event Claimed(address indexed user, uint256 ethAmount);
    event RewardAdded(uint256 amount, uint256 duration);

    constructor(address _stag, address _hood) Ownable(msg.sender) {
        stag = IERC20(_stag);
        hood = IERC721(_hood);
        penaltyRecipient = msg.sender;
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
        rewardPerWeightStored = rewardPerWeight();
        lastUpdateTime = lastTimeApplicable();
        if (a != address(0)) {
            _u[a].rewards = earned(a);
            _u[a].rewardPerWeightPaid = rewardPerWeightStored;
        }
        _;
    }

    // recompute a user's weight after amount/mult change, keeping totalWeight in sync
    function _resync(address a) internal {
        UserInfo storage u = _u[a];
        uint256 newW = (u.amount * u.mult) / BASE;
        totalWeight = totalWeight - u.weight + newW;
        u.weight = newW;
    }

    /* ---------------- staking ---------------- */
    function stakeTokens(uint256 amount) external nonReentrant update(msg.sender) {
        require(amount > 0, "amount=0");
        UserInfo storage u = _u[msg.sender];
        if (u.mult == 0) u.mult = BASE;      // first interaction
        u.amount += amount;
        u.stakedAt = block.timestamp;         // (re)start the lock on new tokens
        _resync(msg.sender);
        stag.safeTransferFrom(msg.sender, address(this), amount);
        emit StakedTokens(msg.sender, amount);
    }

    function unstakeTokens(uint256 amount) public nonReentrant update(msg.sender) {
        UserInfo storage u = _u[msg.sender];
        require(amount > 0 && u.amount >= amount, "bad amount");
        bool early = block.timestamp < u.stakedAt + lockPeriod;
        u.amount -= amount;
        _resync(msg.sender);

        uint256 penalty;
        if (early) {
            penalty = (amount * earlyPenaltyBps) / 10000;
            u.rewards = 0;                    // forfeit all unclaimed rewards
            if (penalty > 0) stag.safeTransfer(penaltyRecipient, penalty);
        }
        stag.safeTransfer(msg.sender, amount - penalty);
        emit UnstakedTokens(msg.sender, amount, penalty, early);
    }

    function stakeNFT(uint256 tokenId) external nonReentrant update(msg.sender) {
        require(address(hood) != address(0), "nft disabled");
        UserInfo storage u = _u[msg.sender];
        if (u.mult == 0) u.mult = BASE;
        uint256 boostBps = nftBoostBps[tokenId] == 0 ? defaultNftBoostBps : nftBoostBps[tokenId];
        u.mult += (boostBps * BASE) / 10000;
        u.nfts.push(tokenId);
        _resync(msg.sender);
        hood.safeTransferFrom(msg.sender, address(this), tokenId);
        emit StakedNFT(msg.sender, tokenId);
    }

    function unstakeNFT(uint256 tokenId) external nonReentrant update(msg.sender) {
        UserInfo storage u = _u[msg.sender];
        uint256 n = u.nfts.length;
        uint256 idx = type(uint256).max;
        for (uint256 i; i < n; i++) { if (u.nfts[i] == tokenId) { idx = i; break; } }
        require(idx != type(uint256).max, "not staked");
        u.nfts[idx] = u.nfts[n - 1];
        u.nfts.pop();
        uint256 boostBps = nftBoostBps[tokenId] == 0 ? defaultNftBoostBps : nftBoostBps[tokenId];
        uint256 dec = (boostBps * BASE) / 10000;
        u.mult = u.mult > dec ? u.mult - dec : BASE; // never below base
        _resync(msg.sender);
        hood.safeTransferFrom(address(this), msg.sender, tokenId);
        emit UnstakedNFT(msg.sender, tokenId);
    }

    function claim() public nonReentrant update(msg.sender) {
        uint256 r = _u[msg.sender].rewards;
        if (r > 0) {
            _u[msg.sender].rewards = 0;
            (bool ok, ) = payable(msg.sender).call{value: r}("");
            require(ok, "eth send failed");
            emit Claimed(msg.sender, r);
        }
    }

    /* ---------------- funding / owner ---------------- */
    // ETH arrives here from the NFT contract's 30% split and from owner top-ups.
    receive() external payable {}

    // start (or extend) distributing `amount` of the contract's ETH over `duration`
    function notifyRewardAmount(uint256 amount, uint256 duration) external onlyOwner update(address(0)) {
        require(duration > 0, "duration=0");
        if (block.timestamp >= periodFinish) {
            rewardRate = amount / duration;
        } else {
            uint256 remaining = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (amount + remaining) / duration;
        }
        require(rewardRate > 0, "rate=0");
        require(rewardRate * duration <= address(this).balance, "insufficient ETH funded");
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(amount, duration);
    }

    function setLockPeriod(uint256 s) external onlyOwner { require(s <= 90 days, "too long"); lockPeriod = s; }
    function setEarlyPenaltyBps(uint256 bps) external onlyOwner { require(bps <= 3000, "max 30%"); earlyPenaltyBps = bps; }
    function setDefaultNftBoostBps(uint256 bps) external onlyOwner { require(bps <= 5000, "max 50%"); defaultNftBoostBps = bps; }
    function setNftBoostBps(uint256 tokenId, uint256 bps) external onlyOwner { require(bps <= 5000, "max 50%"); nftBoostBps[tokenId] = bps; }
    function setPenaltyRecipient(address to) external onlyOwner { require(to != address(0), "zero"); penaltyRecipient = to; }

    /* ---------------- views ---------------- */
    function userInfo(address a) external view returns (
        uint256 amount, uint256 mult, uint256 weight, uint256 stakedAt, uint256 pendingEth, uint256[] memory nfts, bool locked
    ) {
        UserInfo storage u = _u[a];
        return (u.amount, u.mult == 0 ? BASE : u.mult, u.weight, u.stakedAt, earned(a), u.nfts, block.timestamp < u.stakedAt + lockPeriod);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
