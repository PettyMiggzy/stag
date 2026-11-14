// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PadToken} from "./PadToken.sol";
import {PadHook} from "./PadHook.sol";

/// @title PadFactory: launches a token straight into a Uniswap v4 pool paired with $STAG, hook attached
/// @notice One call: makes the token, opens a $STAG / token pool, and puts the whole supply in as one-sided liquidity.
///         No bonding curve and no launch minimum. The liquidity position is owned by this contract and has no code path
///         that removes it, so it is locked for good. The creator collects the pool's LP fees.
contract PadFactory {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    PadHook public immutable hook;
    address public immutable quote;                 // $STAG
    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint24 public constant LP_FEE = 3000;           // 0.30% to the creator
    int24 public constant SPACING = 60;
    int24 public constant RANGE_TICKS = 69_060;     // price can climb ~1000x from the start (multiple of SPACING)
    uint256 public constant MIN_FDV = 1e18;         // starting fully-diluted value, in quote tokens
    uint256 public constant MAX_FDV = 1e30;

    struct Launch {
        address creator;
        address token;
        int24 tickLower;
        int24 tickUpper;
    }

    mapping(PoolId => Launch) public launches;
    PoolKey[] private _keys;

    event Launched(PoolId indexed id, address indexed creator, address token, uint256 startFdv, bool war, string name, string symbol);
    event FeesCollected(PoolId indexed id, address indexed to, uint256 amount0, uint256 amount1);

    error BadFdv();
    error BadString();
    error NotCreator();
    error NotPM();

    constructor(IPoolManager _pm, PadHook _hook, address _quote) {
        pm = _pm;
        hook = _hook;
        quote = _quote;
    }

    function launchCount() external view returns (uint256) { return _keys.length; }
    function keyAt(uint256 i) external view returns (PoolKey memory) { return _keys[i]; }

    /// @param startFdv starting fully-diluted value of the token, in quote tokens (wei). Price can rise ~1000x from here.
    ///        The start is rounded down to the pool's 60-tick grid, so the real start can differ by up to ~0.6%.
    function launch(string calldata name, string calldata symbol, uint256 startFdv, bool war)
        external
        returns (PoolKey memory key, address token)
    {
        if (startFdv < MIN_FDV || startFdv > MAX_FDV) revert BadFdv();
        _checkString(bytes(name), 32);
        _checkString(bytes(symbol), 12);

        address[] memory skip = new address[](3);
        skip[0] = address(pm);
        skip[1] = address(hook);
        skip[2] = address(this);
        token = address(new PadToken(name, symbol, SUPPLY, address(this), IERC20(quote), skip));

        bool quoteIs0 = quote < token;
        key = PoolKey({
            currency0: Currency.wrap(quoteIs0 ? quote : token),
            currency1: Currency.wrap(quoteIs0 ? token : quote),
            fee: LP_FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        hook.register(key, msg.sender, token, war, quoteIs0);

        (int24 lo, int24 hi, int24 start, uint128 liq) = _range(startFdv, quoteIs0);
        pm.initialize(key, TickMath.getSqrtPriceAtTick(start));
        pm.unlock(abi.encode(uint8(0), key, lo, hi, liq, address(0), quoteIs0));

        PoolId id = key.toId();
        launches[id] = Launch(msg.sender, token, lo, hi);
        _keys.push(key);
        emit Launched(id, msg.sender, token, startFdv, war, name, symbol);
    }

    /// @dev Token is the only asset in the range at the start. If quote is currency0 the token is currency1: the pool
    ///      starts at the TOP of the range and buyers (paying quote) push the tick down. Otherwise the pool starts at the
    ///      BOTTOM and buyers push the tick up.
    function _range(uint256 fdv, bool quoteIs0) internal pure returns (int24 lo, int24 hi, int24 start, uint128 liq) {
        // price (token1 / token0) as sqrtPriceX96
        uint256 ratioX192 = quoteIs0 ? FullMath.mulDiv(SUPPLY, 1 << 192, fdv) : FullMath.mulDiv(fdv, 1 << 192, SUPPLY);
        uint256 sq = Math.sqrt(ratioX192);
        if (sq <= TickMath.MIN_SQRT_PRICE || sq >= TickMath.MAX_SQRT_PRICE) revert BadFdv();
        int24 tick = TickMath.getTickAtSqrtPrice(uint160(sq));
        start = _floor(tick);
        if (quoteIs0) {
            hi = start;
            lo = start - RANGE_TICKS;
            liq = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), SUPPLY);
        } else {
            lo = start;
            hi = start + RANGE_TICKS;
            liq = LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), SUPPLY);
        }
        if (lo < TickMath.minUsableTick(SPACING) || hi > TickMath.maxUsableTick(SPACING)) revert BadFdv();
    }

    function _floor(int24 t) internal pure returns (int24) {
        int24 r = t % SPACING;
        if (r < 0) r += SPACING;
        return t - r;
    }

    /// @dev letters, digits, space and . _ - + ! ? : # only
    function _checkString(bytes memory s, uint256 maxLen) internal pure {
        if (s.length == 0 || s.length > maxLen) revert BadString();
        for (uint256 i; i < s.length; i++) {
            uint8 c = uint8(s[i]);
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x20 || c == 0x2E
                || c == 0x5F || c == 0x2D || c == 0x2B || c == 0x21 || c == 0x3F || c == 0x3A || c == 0x23;
            if (!ok) revert BadString();
        }
    }

    /// @notice The creator collects the LP fees the pool has earned. Liquidity itself never moves.
    function collectFees(PoolKey calldata key, address to) external returns (uint256 a0, uint256 a1) {
        PoolId id = key.toId();
        Launch memory l = launches[id];
        if (msg.sender != l.creator) revert NotCreator();
        (a0, a1) = abi.decode(pm.unlock(abi.encode(uint8(1), key, l.tickLower, l.tickUpper, uint128(0), to, false)), (uint256, uint256));
        emit FeesCollected(id, to, a0, a1);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert NotPM();
        (uint8 op, PoolKey memory key, int24 lo, int24 hi, uint128 liq, address to, bool quoteIs0) =
            abi.decode(data, (uint8, PoolKey, int24, int24, uint128, address, bool));
        if (op == 0) {
            (BalanceDelta d,) = pm.modifyLiquidity(
                key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(liq)), salt: 0}), ""
            );
            // one-sided: only the token side is owed; pay it in. The token is currency1 when quote is currency0.
            Currency tokenCur = quoteIs0 ? key.currency1 : key.currency0;
            int128 owed = quoteIs0 ? d.amount1() : d.amount0();
            int128 other = quoteIs0 ? d.amount0() : d.amount1();
            require(owed < 0 && other == 0, "not one-sided");
            pm.sync(tokenCur);
            IERC20(Currency.unwrap(tokenCur)).safeTransfer(address(pm), uint256(uint128(-owed)));
            pm.settle();
            return "";
        }
        // op == 1: poke the position with zero liquidity to pull out accrued fees
        (, BalanceDelta fees) = pm.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 0, salt: 0}), ""
        );
        uint256 a0 = fees.amount0() > 0 ? uint256(uint128(fees.amount0())) : 0;
        uint256 a1 = fees.amount1() > 0 ? uint256(uint128(fees.amount1())) : 0;
        if (a0 > 0) pm.take(key.currency0, to, a0);
        if (a1 > 0) pm.take(key.currency1, to, a1);
        return abi.encode(a0, a1);
    }
}
