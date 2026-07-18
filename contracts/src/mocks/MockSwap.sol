// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Test-only mocks standing in for WETH9 + Uniswap SwapRouter02 so we can unit-test
// SherwoodSwap's fee logic without a live chain. NEVER deployed to mainnet.
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IMintable { function mint(address, uint256) external; }

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped ETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amt) external { _burn(msg.sender, amt); (bool ok,) = payable(msg.sender).call{value: amt}(""); require(ok, "w"); }
    function testMint(address to, uint256 amt) external { _mint(to, amt); }  // unbacked WETH for the router's inventory
    receive() external payable {}                                            // fund with ETH to back withdrawals
}

// exactInputSingle at a fixed 1 ETH = `rate` tokens. BUY mints the out-token to recipient;
// SELL pulls the in-token and pays WETH from its own inventory. Enforces amountOutMinimum.
contract MockSwapRouter02 {
    address public immutable weth;
    uint256 public immutable rate;   // tokens per 1 ETH
    constructor(address weth_, uint256 rate_) { weth = weth_; rate = rate_; }

    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        if (p.tokenIn == weth) {
            // BUY: caller forwarded ETH as msg.value; mint tokenOut to recipient
            require(msg.value == p.amountIn, "bad value");
            amountOut = p.amountIn * rate;
            require(amountOut >= p.amountOutMinimum, "Too little received");
            IMintable(p.tokenOut).mint(p.recipient, amountOut);
        } else {
            // SELL: pull tokenIn, pay WETH from inventory
            ERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
            amountOut = p.amountIn / rate;
            require(amountOut >= p.amountOutMinimum, "Too little received");
            ERC20(weth).transfer(p.recipient, amountOut);
        }
    }
    receive() external payable {}
}
