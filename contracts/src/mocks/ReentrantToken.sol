// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Test-only: an ERC-20 "buy" token that tries to re-enter the market during transferFrom.
// Proves ReentrancyGuard + CEI ordering block any cross-function reentrancy during a fill.
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IMarket {
    function fillOrder(uint256 id) external payable;
    function cancelOrder(uint256 id) external;
    function createOrder(address s, uint256 sa, address b, uint256 ba) external returns (uint256);
}

contract ReentrantToken is ERC20 {
    IMarket public market;
    uint256 public targetId;
    bool public armed;
    constructor() ERC20("Reenter", "REE") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function arm(address market_, uint256 id) external { market = IMarket(market_); targetId = id; armed = true; }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (armed) {
            armed = false; // one-shot
            market.fillOrder(targetId); // should revert the whole tx via the guard
        }
        return super.transferFrom(from, to, value);
    }
}
