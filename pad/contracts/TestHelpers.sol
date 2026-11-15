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

/// TEST ONLY: a router in the sync-first style (syncs the quote token BEFORE the swap), to prove the hook does not break it.
contract TestSyncRouter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    IPoolManager public immutable pm;
    constructor(IPoolManager _pm) { pm = _pm; }

    function buy(PoolKey calldata key, uint256 amtIn, address quoteTok, address tokenTok, bool zeroForOne, uint160 limit) external {
        pm.unlock(abi.encode(msg.sender, key, amtIn, quoteTok, tokenTok, zeroForOne, limit));
    }

    function unlockCallback(bytes calldata d) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address user, PoolKey memory key, uint256 amt, address q, address t, bool zfo, uint160 limit) =
            abi.decode(d, (address, PoolKey, uint256, address, address, bool, uint160));
        pm.sync(Currency.wrap(q));                                                   // sync FIRST
        pm.swap(key, SwapParams({zeroForOne: zfo, amountSpecified: -int256(amt), sqrtPriceLimitX96: limit}), "");
        IERC20(q).transferFrom(user, address(pm), amt);
        pm.settle();
        int256 dt = pm.currencyDelta(address(this), Currency.wrap(t));
        if (dt > 0) pm.take(Currency.wrap(t), user, uint256(dt));
        return "";
    }
}

/// TEST ONLY: a stand-in for the $STAG curve with knobs to prove the router never trusts it
contract MockCurve {
    address public immutable stag;
    uint256 public rate;          // STAG out per wei in on buy; wei out = stag / rate on sell
    uint256 public refundBps;     // fraction of the ETH sent back unspent on buy
    bool public lie;              // return a falsely large number
    bool public stingy;           // send less STAG than minTokensOut implies is fine (tests the router's own measurement)
    constructor(address s, uint256 r) { stag = s; rate = r; }
    function set(uint256 _refundBps, bool _lie, bool _stingy) external { refundBps = _refundBps; lie = _lie; stingy = _stingy; }
    function buy(uint256 q, uint256 minOut, address r) external payable returns (uint256) {
        require(msg.value == q, "val");
        uint256 spend = q - (q * refundBps) / 10000;
        uint256 out = spend * rate;
        if (stingy) out = out / 2;
        if (!stingy) require(out >= minOut, "slip");
        IERC20(stag).transfer(r, out);
        if (spend < q) { (bool ok,) = msg.sender.call{value: q - spend}(""); require(ok, "refund"); }
        return lie ? out * 2 : out;
    }
    function sell(uint256 tin, uint256 minQ, address r) external returns (uint256) {
        IERC20(stag).transferFrom(msg.sender, address(this), tin);
        uint256 q = tin / rate;
        require(q >= minQ, "slip");
        (bool ok,) = r.call{value: q}("");
        require(ok, "send");
        return lie ? q * 2 : q;
    }
    receive() external payable {}
}
