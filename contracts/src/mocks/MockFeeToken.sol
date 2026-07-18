// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Test-only fee-on-transfer ("tax") token. Burns `feeBps` of every non-mint/non-burn transfer.
// Used to prove the market never over-transfers escrow and measures actual received amounts.
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockFeeToken is ERC20 {
    uint256 public feeBps;
    constructor(uint256 feeBps_) ERC20("Tax Token", "TAX") { feeBps = feeBps_; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    // OZ v5 routes every balance change through _update; skim on real transfers only.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0xdead), fee); // burn the tax
            value -= fee;
        }
        super._update(from, to, value);
    }
}
