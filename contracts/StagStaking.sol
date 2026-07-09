// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD staking (Robinhood Chain)
 *  - Flexible: stake / unstake anytime, claim rewards
 *  - Synthetix StakingRewards accounting (battle-tested pattern)
 *  - stake $STAG, earn $STAG (reward token is configurable)
 *
 *  Reward pool is funded separately by the owner via fund(). Because the
 *  staking token and reward token can be the same ($STAG), the contract must
 *  always hold at least (totalStaked + unclaimed rewards) — only ever call
 *  setRewardRate to a level your funded pool can sustain.
 *
 *  ⚠️ Test on the Robinhood Chain TESTNET (chainId 46630) before mainnet.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract StagStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakingToken;   // $STAG
    IERC20 public immutable rewardToken;     // $STAG (or another reward)

    uint256 public rewardRate;               // reward tokens/second across the whole pool
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public totalStaked;

    mapping(address => uint256) public staked;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);
    event Funded(address indexed from, uint256 amount);

    constructor(address _stakingToken, address _rewardToken)
        Ownable(msg.sender)
    {
        stakingToken = IERC20(_stakingToken);
        rewardToken  = IERC20(_rewardToken);
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = block.timestamp;
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((block.timestamp - lastUpdateTime) * rewardRate * 1e18) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return (staked[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account];
    }

    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "amount = 0");
        totalStaked += amount;
        staked[msg.sender] += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0 && staked[msg.sender] >= amount, "bad amount");
        totalStaked -= amount;
        staked[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, reward);
            emit Claimed(msg.sender, reward);
        }
    }

    function exit() external {
        claim();
        unstake(staked[msg.sender]);
    }

    /* ---- owner ---- */
    // top up the reward pool (pull tokens from owner)
    function fund(uint256 amount) external {
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function setRewardRate(uint256 rate) external onlyOwner updateReward(address(0)) {
        rewardRate = rate;
    }

    // rescue non-staking tokens sent by mistake (never touches staked principal)
    function rescue(address token, uint256 amount, address to) external onlyOwner {
        require(token != address(stakingToken), "no principal");
        IERC20(token).safeTransfer(to, amount);
    }
}
