// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// the $STAG bonding curve (Pons): ETH in, $STAG out, and back
interface IStagCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut);
}

/// @title PadRouter: the one swap entry point for the pad's $STAG / token pools, plus ETH zaps through the $STAG curve
/// @notice Stateless and ownerless: no admin, no fee, no upgrade, and it never holds funds between calls. It only
///         ever spends what the caller sends it in the same call, and every call has a minimum output and a deadline.
///         Exact-in only, and a swap that cannot fill the whole input reverts instead of leaving a partial trade.
///         Works only on pools that use the pad hook and trade $STAG.
contract PadRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    address public immutable hook;      // the pad hook: only pools that use it are accepted
    address public immutable stag;      // $STAG
    IStagCurve public immutable curve;  // the $STAG curve (zaps only)

    error Expired();
    error BadPool();
    error ZeroAmount();
    error Slippage();
    error PartialFill();
    error NotPM();
    error Reentrancy();
    error BadValue();
    error NotCurve();
    error SendFailed();

    struct Ctx {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minOut;
        address payer;     // whose tokens pay for the input (this contract itself inside a zap)
        address to;        // who receives the output
    }

    /// transient reentrancy lock (cancun)
    bytes32 private constant LOCK = keccak256("PadRouter.lock");

    modifier nonReentrant() {
        bytes32 s = LOCK;
        uint256 v;
        assembly { v := tload(s) }
        if (v != 0) revert Reentrancy();
        assembly { tstore(s, 1) }
        _;
        assembly { tstore(s, 0) }
    }

    constructor(IPoolManager _pm, address _hook, address _stag, IStagCurve _curve) {
        pm = _pm;
        hook = _hook;
        stag = _stag;
        curve = _curve;
    }

    /// only the curve may send ETH here (a refund of unspent ETH during a zap); nobody can leave ETH stuck by accident
    receive() external payable {
        if (msg.sender != address(curve)) revert NotCurve();
    }

    // ------------------------------------------------------------------ swaps

    /// @notice Sell `amountIn` of one pool currency for the other, exact-in. The caller must have approved this contract
    ///         for the input token. `zeroForOne` selects the direction; the output goes to `to`.
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        _checkTo(to);
        out = _swap(key, zeroForOne, amountIn, minOut, msg.sender, to);
    }

    // ------------------------------------------------------------------ zaps

    /// @notice ETH in, pad token out, in one transaction: ETH -> $STAG on the curve -> token on the pad pool.
    ///         `minStag` protects the curve leg (it also catches the curve's launch-time sniper tax), `minOut` the whole trade.
    ///         Any ETH the curve does not spend is returned to the caller.
    function zapBuy(PoolKey calldata key, uint256 minStag, uint256 minOut, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 stagIn, uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        _checkTo(to);
        if (msg.value == 0) revert ZeroAmount();
        bool zfo = _direction(key, true);                          // input must be $STAG
        uint256 ethBefore = address(this).balance - msg.value;
        uint256 stagBefore = IERC20(stag).balanceOf(address(this));
        curve.buy{value: msg.value}(msg.value, minStag, address(this));
        stagIn = IERC20(stag).balanceOf(address(this)) - stagBefore;          // measure, do not trust the return value
        if (stagIn == 0 || stagIn < minStag) revert Slippage();
        out = _swap(key, zfo, stagIn, minOut, address(this), to);
        uint256 bal = address(this).balance;
        if (bal > ethBefore) {                                      // unspent ETH goes back to the caller
            (bool ok,) = msg.sender.call{value: bal - ethBefore}("");
            if (!ok) revert SendFailed();
        }
    }

    /// @notice Pad token in, ETH out: token -> $STAG on the pad pool -> ETH on the curve, ETH sent to `to`.
    ///         The caller must have approved this contract for the token. `minEth` protects the whole trade.
    function zapSell(PoolKey calldata key, uint256 tokensIn, uint256 minEth, address to, uint256 deadline)
        external
        nonReentrant
        returns (uint256 stagMid, uint256 ethOut)
    {
        if (block.timestamp > deadline) revert Expired();
        _checkTo(to);
        bool zfo = _direction(key, false);                         // input must be the pad token
        uint256 stagBefore = IERC20(stag).balanceOf(address(this));
        _swap(key, zfo, tokensIn, 0, msg.sender, address(this));    // the final minimum is on the ETH, below
        stagMid = IERC20(stag).balanceOf(address(this)) - stagBefore;
        IERC20(stag).forceApprove(address(curve), stagMid);
        uint256 ethBefore = address(this).balance;
        curve.sell(stagMid, minEth, address(this));                 // ETH comes back here so what arrives can be measured, not trusted
        IERC20(stag).forceApprove(address(curve), 0);
        ethOut = address(this).balance - ethBefore;
        if (ethOut == 0 || ethOut < minEth) revert Slippage();
        (bool ok,) = to.call{value: ethOut}("");
        if (!ok) revert SendFailed();
    }

    // -------------------------------------------------------------- internals

    /// the recipient must be a real address and never this contract itself (that would strand the output here)
    function _checkTo(address to) internal view {
        if (to == address(0) || to == address(this)) revert BadValue();
    }

    /// validates the pool and returns the swap direction. `stagIn`: the input currency must be $STAG, else it must be the other one.
    function _direction(PoolKey calldata key, bool stagIn) internal view returns (bool zeroForOne) {
        if (address(key.hooks) != hook) revert BadPool();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (c0 != stag && c1 != stag) revert BadPool();
        bool stagIs0 = c0 == stag;
        zeroForOne = stagIn ? stagIs0 : !stagIs0;
    }

    function _swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minOut, address payer, address to)
        internal
        returns (uint256 out)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > uint256(uint128(type(int128).max)) || minOut > type(uint128).max) revert BadValue();   // amountIn must fit an int128 (the swap amount is negated)
        if (address(key.hooks) != hook) revert BadPool();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (c0 != stag && c1 != stag) revert BadPool();
        out = abi.decode(
            pm.unlock(abi.encode(Ctx(key, zeroForOne, uint128(amountIn), uint128(minOut), payer, to))), (uint256)
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert NotPM();
        Ctx memory c = abi.decode(data, (Ctx));
        Currency inC = c.zeroForOne ? c.key.currency0 : c.key.currency1;
        Currency outC = c.zeroForOne ? c.key.currency1 : c.key.currency0;

        BalanceDelta d = pm.swap(
            c.key,
            SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: -int256(uint256(c.amountIn)),
                sqrtPriceLimitX96: c.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 dIn = c.zeroForOne ? d.amount0() : d.amount1();
        int128 dOut = c.zeroForOne ? d.amount1() : d.amount0();
        if (dIn != -int128(c.amountIn)) revert PartialFill();       // the whole input must have been used
        if (dOut <= 0 || uint128(dOut) < c.minOut) revert Slippage();

        // pay the input, then take the output
        address tin = Currency.unwrap(inC);
        pm.sync(inC);
        if (c.payer == address(this)) IERC20(tin).safeTransfer(address(pm), c.amountIn);
        else IERC20(tin).safeTransferFrom(c.payer, address(pm), c.amountIn);
        pm.settle();
        pm.take(outC, c.to, uint128(dOut));
        return abi.encode(uint256(uint128(dOut)));
    }
}
