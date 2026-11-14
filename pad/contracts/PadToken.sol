// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title PadToken: the token every pad launch gets
/// @notice Fixed supply, no owner, no mint after launch. In peace mode the pad hook sends holders' share of the buy tax
///         here in the quote token ($STAG); holders earn it in proportion to the tokens they hold. Pool, hook, factory
///         and burn addresses are excluded so they never soak up payouts.
/// @dev    Payout share uses the standard "magnified per share" counter with MAG = 2^64. Bounds: while eligible supply is
///         at least MIN_ELIGIBLE (1 token) each deposit adds at most deposit * 2^64 / 1e18 to the counter, so
///         counter * balance cannot overflow int256 for any realistic cumulative payout (up to ~3e48 token-wei).
///         Below MIN_ELIGIBLE the funds are parked and paid out at the next sync that finds enough eligible supply.
contract PadToken is ERC20 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 private constant MAG = 2 ** 64;
    uint256 public constant MIN_ELIGIBLE = 1e18;

    IERC20 public immutable quote;
    uint256 public magnifiedPerShare;
    uint256 public eligibleSupply;      // tokens held by non-excluded wallets
    uint256 public pendingDividends;    // received while eligible supply was below MIN_ELIGIBLE
    uint256 public reserve;             // quote tokens this contract has accounted for and not yet paid out
    mapping(address => bool) public excluded;
    mapping(address => int256) private correction;
    mapping(address => uint256) public withdrawn;
    uint256 private lock = 1;

    event DividendsIn(uint256 amount);
    event DividendsOut(address indexed to, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint256 supply, address receiver, IERC20 quote_, address[] memory skip)
        ERC20(name_, symbol_)
    {
        quote = quote_;
        excluded[address(this)] = true;
        excluded[address(0)] = true;
        excluded[0x000000000000000000000000000000000000dEaD] = true;
        excluded[receiver] = true;
        for (uint256 i; i < skip.length; i++) excluded[skip[i]] = true;
        _mint(receiver, supply);
    }

    /// @notice Anyone can burn their own tokens.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Account for quote tokens that arrived (the hook sends them, then calls this). Anyone may call it.
    function sync() external returns (uint256 fresh) {
        uint256 bal = quote.balanceOf(address(this));
        fresh = bal > reserve ? bal - reserve : 0;
        if (fresh == 0) return 0;
        reserve = bal;
        uint256 total = fresh + pendingDividends;
        if (eligibleSupply < MIN_ELIGIBLE) {
            pendingDividends = total;
        } else {
            pendingDividends = 0;
            magnifiedPerShare += (total * MAG) / eligibleSupply;
        }
        emit DividendsIn(fresh);
    }

    function accumulativeOf(address a) public view returns (uint256) {
        if (excluded[a]) return 0;
        int256 v = (magnifiedPerShare * balanceOf(a)).toInt256() + correction[a];
        return v < 0 ? 0 : uint256(v) / MAG;
    }

    function claimable(address a) public view returns (uint256) {
        uint256 acc = accumulativeOf(a);
        return acc > withdrawn[a] ? acc - withdrawn[a] : 0;
    }

    function claim() external {
        require(lock == 1, "locked");
        lock = 2;
        uint256 amt = claimable(msg.sender);
        if (amt > 0) {
            withdrawn[msg.sender] += amt;
            reserve -= amt;
            quote.safeTransfer(msg.sender, amt);
            emit DividendsOut(msg.sender, amt);
        }
        lock = 1;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        bool fx = excluded[from];
        bool tx_ = excluded[to];
        int256 delta = (magnifiedPerShare * amount).toInt256();
        if (!fx) correction[from] += delta;
        if (!tx_) correction[to] -= delta;
        if (fx && !tx_) eligibleSupply += amount;
        else if (!fx && tx_) eligibleSupply -= amount;
    }
}
