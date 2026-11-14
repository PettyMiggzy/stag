// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
/// test only
contract HookDeployer {
    function deploy(bytes32 salt, bytes memory initcode) external returns (address a) {
        assembly { a := create2(0, add(initcode, 0x20), mload(initcode), salt) }
        require(a != address(0), "create2");
    }
}
