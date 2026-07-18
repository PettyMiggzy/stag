// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Test-only Uniswap V3 factory + pool stand-ins with a settable spot price. NOT deployed to mainnet.

contract MockV3Pool {
    uint160 public sqrtPriceX96;
    function setSqrt(uint160 s) external { sqrtPriceX96 = s; }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, int24(0), uint16(0), uint16(0), uint16(0), uint8(0), false);
    }
}

contract MockV3Factory {
    address public pool;
    function setPool(address p) external { pool = p; }
    function getPool(address, address, uint24) external view returns (address) { return pool; }
}
