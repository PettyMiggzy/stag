// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Test-only: a contract maker that REVERTS on ETH receipt. Proves a hostile/broken maker can't
// brick the market — an ETH-paid fill to it reverts (escrow untouched, order still cancellable).
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMkt {
    function createOrder(address s, uint256 sa, address b, uint256 ba) external returns (uint256);
    function cancelOrder(uint256 id) external;
}

contract HostileMaker {
    function post(address mkt, address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount)
        external returns (uint256)
    {
        IERC20(sellToken).approve(mkt, sellAmount);
        return IMkt(mkt).createOrder(sellToken, sellAmount, buyToken, buyAmount);
    }
    function cancel(address mkt, uint256 id) external { IMkt(mkt).cancelOrder(id); }
    receive() external payable { revert("hostile maker: no eth"); }
}
