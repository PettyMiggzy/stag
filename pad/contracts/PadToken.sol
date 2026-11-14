// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title PadToken: the token every pad launch gets
/// @notice Fixed supply, no owner, no mint after launch. Holders earn a share of the ETH the pad hook routes to holders
///         (peace mode), in proportion to the tokens they hold. Pool, hook and burn addresses are excluded so they never
///         soak up payouts.
contract PadToken is ERC20 {
    uint256 private constant MAG = 2 ** 128;

    uint256 public magnifiedPerShare;       // ETH per eligible token, scaled by MAG
    uint256 public eligibleSupply;          // tokens held by non-excluded wallets
    uint256 public pendingDividends;        // ETH that arrived while nobody was eligible
    mapping(address => bool) public excluded;
    mapping(address => int256) private correction;
    mapping(address => uint256) public withdrawn;
    uint256 private lock = 1;

    event DividendsIn(uint256 amount);
    event DividendsOut(address indexed to, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint256 supply, address receiver, address[] memory skip)
        ERC20(name_, symbol_)
    {
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

    /// @notice Called by the pad hook to hand a batch of ETH to holders.
    function depositDividends() external payable {
        uint256 amt = msg.value + pendingDividends;
        if (msg.value == 0) return;
        if (eligibleSupply == 0) {
            pendingDividends = amt;
        } else {
            pendingDividends = 0;
            magnifiedPerShare += (amt * MAG) / eligibleSupply;
        }
        emit DividendsIn(msg.value);
    }

    function accumulativeOf(address a) public view returns (uint256) {
        if (excluded[a]) return 0;
        int256 v = int256(magnifiedPerShare * balanceOf(a)) + correction[a];
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
            (bool ok,) = msg.sender.call{value: amt}("");
            require(ok, "send");
            emit DividendsOut(msg.sender, amt);
        }
        lock = 1;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        bool fx = excluded[from];
        bool tx_ = excluded[to];
        if (!fx) correction[from] += int256(magnifiedPerShare * amount);
        if (!tx_) correction[to] -= int256(magnifiedPerShare * amount);
        if (fx && !tx_) eligibleSupply += amount;
        else if (!fx && tx_) eligibleSupply -= amount;
    }
}
