// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title RecordStake: stake $STAG on a Stag House record
/// @notice A holder puts $STAG behind a record and can take all of it back at any time. The contract pays nothing:
///         no yield, no rewards, no fees, no penalties. What staking earns is "antler points" (tokens x time), which
///         the label uses off-chain for perks such as early access and collector editions. Taking tokens out of a
///         record resets the points on that record.
/// @dev    Built for a plain fixed-supply ERC-20. Tokens that rebase, or that take a fee on transfer, are not supported.
///         The owner can add records and stop NEW stakes. The owner can never touch staked tokens and can never
///         stop anyone from unstaking.
contract RecordStake is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable stag;
    /// @notice The least a wallet can hold on a record after staking: one whole token. Keeps dust wallets out of the staker count.
    uint256 public constant MIN_POSITION = 1e18;

    struct Position {
        uint128 amount; // tokens this wallet has on this record
        uint64 since;   // weighted start time of the stake; moves forward when more is added, resets on unstake
    }

    mapping(uint256 => bool) public recordOpen;                       // record id => taking new stakes
    mapping(uint256 => uint256) public recordTotal;                   // record id => tokens staked on it
    mapping(uint256 => uint256) public recordStakers;                 // record id => wallets with a stake on it
    mapping(address => mapping(uint256 => Position)) public positions; // wallet => record id => position
    uint256 public totalStaked;                                       // every staked token; the contract always holds at least this

    event RecordSet(uint256 indexed recordId, bool open);
    event Staked(address indexed user, uint256 indexed recordId, uint256 amount, uint256 newAmount, uint64 since);
    event Unstaked(address indexed user, uint256 indexed recordId, uint256 amount, uint256 newAmount);

    error RecordClosed();
    error ZeroAmount();
    error TooMuch();
    error NotSpare();
    error TooLittle();

    constructor(address _stag, address _owner) Ownable(_owner) {
        require(_stag != address(0), "stag=0");
        stag = IERC20(_stag);
    }

    /// @notice Open or close a record for new stakes. Closing never affects unstaking.
    function setRecord(uint256 recordId, bool open) external onlyOwner {
        recordOpen[recordId] = open;
        emit RecordSet(recordId, open);
    }

    /// @notice Stake $STAG on a record. Approve this contract for `amount` first.
    function stake(uint256 recordId, uint256 amount) external nonReentrant {
        if (!recordOpen[recordId]) revert RecordClosed();
        if (amount == 0) revert ZeroAmount();
        // count what actually arrived, so a token that takes a cut on transfer cannot leave the contract short
        uint256 before = stag.balanceOf(address(this));
        stag.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = stag.balanceOf(address(this)) - before;
        if (got == 0) revert ZeroAmount();

        Position storage p = positions[msg.sender][recordId];
        uint256 old = p.amount;
        uint256 next = old + got;
        if (next > type(uint128).max) revert TooMuch();
        if (next < MIN_POSITION) revert TooLittle();
        if (old == 0) {
            p.since = uint64(block.timestamp);
            recordStakers[recordId] += 1;
        } else {
            // adding more keeps the points already earned: the start time becomes the amount-weighted average
            // rounded UP, so rounding can never hand the staker time they did not earn
            p.since = uint64((uint256(p.since) * old + block.timestamp * got + next - 1) / next);
        }
        p.amount = uint128(next);
        recordTotal[recordId] += got;
        totalStaked += got;
        emit Staked(msg.sender, recordId, got, next, p.since);
    }

    /// @notice Take tokens back from a record. Always allowed, always the full amount asked for.
    ///         The points on this record start again from now.
    function unstake(uint256 recordId, uint256 amount) external nonReentrant {
        Position storage p = positions[msg.sender][recordId];
        if (amount == 0) revert ZeroAmount();
        if (amount > p.amount) revert TooMuch();
        uint256 next = uint256(p.amount) - amount;
        p.amount = uint128(next);
        p.since = uint64(block.timestamp);
        if (next == 0) recordStakers[recordId] -= 1;
        recordTotal[recordId] -= amount;
        totalStaked -= amount;
        stag.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, recordId, amount, next);
    }

    /// @notice Antler points for a wallet on a record: whole tokens staked x days held. Informational only.
    function points(address user, uint256 recordId) external view returns (uint256) {
        Position memory p = positions[user][recordId];
        if (p.amount == 0) return 0;
        return (uint256(p.amount) * (block.timestamp - p.since)) / 1 days / 1e18;
    }

    /// @notice Return tokens sent here by mistake. Staked $STAG can never be taken: only the spare above `totalStaked`.
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(stag)) {
            uint256 bal = stag.balanceOf(address(this));
            if (bal < totalStaked || amount > bal - totalStaked) revert NotSpare();
        }
        IERC20(token).safeTransfer(to, amount);
    }
}
