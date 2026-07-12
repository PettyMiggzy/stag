// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Test-only ERC-20 (never deployed to mainnet). Used to stand in for $STAG in tests.
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock STAG", "mSTAG") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
