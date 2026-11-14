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
///         Below MIN_ELIGIBLE the funds stay parked until eligible supply recovers. Deposits are credited one block
///         later (see sync) so flash-borrowed tokens never earn.
contract PadToken is ERC20 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 private constant MAG = 2 ** 64;
    uint256 public constant MIN_ELIGIBLE = 1e18;

    IERC20 public immutable quote;
    uint256 public magnifiedPerShare;
    uint256 public eligibleSupply;      // tokens held by non-excluded wallets
    uint256 public pendingDividends;    // parked: waiting for eligible supply of at least MIN_ELIGIBLE
    uint256 public staged;              // received this block; credited at the first token interaction of a LATER block
    uint256 public stagedBlock;
    uint256 public lastCreditBlock;
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
    ///         The funds are only credited to holders at the first token interaction of a LATER block, using the
    ///         holders as they stood at that moment, so tokens borrowed for a single transaction (a flash take from the
    ///         pool manager) can never earn a payout.
    function sync() external returns (uint256 fresh) {
        _credit();
        uint256 bal = quote.balanceOf(address(this));
        fresh = bal > reserve ? bal - reserve : 0;
        if (fresh == 0) return 0;
        reserve = bal;
        staged += fresh;
        stagedBlock = block.number;
        emit DividendsIn(fresh);
    }

    /// @dev Runs at the start of every transfer, claim and sync, before the transfer changes anyone's balance, and at
    ///      most once per block. Moves staged funds (from earlier blocks) into the pot, then pays the pot out to the
    ///      current eligible holders, or keeps it parked while eligible supply is under MIN_ELIGIBLE.
    function _credit() internal {
        if (lastCreditBlock == block.number) return;
        lastCreditBlock = block.number;
        uint256 st = staged;
        if (st != 0 && block.number > stagedBlock) {
            pendingDividends += st;
            staged = 0;
        }
        uint256 pend = pendingDividends;
        if (pend != 0 && eligibleSupply >= MIN_ELIGIBLE) {
            pendingDividends = 0;
            magnifiedPerShare += (pend * MAG) / eligibleSupply;
        }
    }

    /// @dev the per-share counter as it will stand once the next interaction runs `_credit`
    function _mpsNow() internal view returns (uint256) {
        if (lastCreditBlock == block.number) return magnifiedPerShare;
        uint256 pend = pendingDividends + ((staged != 0 && block.number > stagedBlock) ? staged : 0);
        if (pend != 0 && eligibleSupply >= MIN_ELIGIBLE) return magnifiedPerShare + (pend * MAG) / eligibleSupply;
        return magnifiedPerShare;
    }

    function accumulativeOf(address a) public view returns (uint256) {
        if (excluded[a]) return 0;
        int256 v = (_mpsNow() * balanceOf(a)).toInt256() + correction[a];
        return v < 0 ? 0 : uint256(v) / MAG;
    }

    function claimable(address a) public view returns (uint256) {
        uint256 acc = accumulativeOf(a);
        return acc > withdrawn[a] ? acc - withdrawn[a] : 0;
    }

    function claim() external {
        require(lock == 1, "locked");
        lock = 2;
        _credit();
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
        _credit();
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
