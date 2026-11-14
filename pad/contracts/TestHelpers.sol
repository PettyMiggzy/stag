// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
/// test only
contract HookDeployer {
    function deploy(bytes32 salt, bytes memory initcode) external returns (address a) {
        assembly { a := create2(0, add(initcode, 0x20), mload(initcode), salt) }
        require(a != address(0), "create2");
    }
}

/// TEST ONLY: runs several operations inside ONE unlock (flash takes, several swaps, token.claim) and settles net deltas
/// against `user`, who must approve this contract. Used to prove flash-loan and same-unlock behaviour.
contract TestMulti is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    IPoolManager public immutable pm;
    struct Op { uint8 kind; PoolKey key; SwapParams sp; address cur; uint256 amt; }
    constructor(IPoolManager _pm) { pm = _pm; }

    function run(Op[] calldata ops, address[] calldata curs) external {
        pm.unlock(abi.encode(msg.sender, ops, curs));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address user, Op[] memory ops, address[] memory curs) = abi.decode(data, (address, Op[], address[]));
        for (uint256 i; i < ops.length; i++) {
            Op memory o = ops[i];
            if (o.kind == 0) pm.swap(o.key, o.sp, "");
            else if (o.kind == 1) pm.take(Currency.wrap(o.cur), address(this), o.amt);   // flash take
            else if (o.kind == 5) { (bool ok,) = o.cur.call(abi.encodeWithSignature("claim()")); ok; }
        }
        for (uint256 i; i < curs.length; i++) {
            int256 d = pm.currencyDelta(address(this), Currency.wrap(curs[i]));
            if (d < 0) {
                pm.sync(Currency.wrap(curs[i]));
                uint256 need = uint256(-d);
                if (IERC20(curs[i]).balanceOf(address(this)) >= need) IERC20(curs[i]).transfer(address(pm), need);
                else IERC20(curs[i]).transferFrom(user, address(pm), need);
                pm.settle();
            } else if (d > 0) pm.take(Currency.wrap(curs[i]), user, uint256(d));
        }
        return "";
    }
}
