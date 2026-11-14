// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PadToken} from "./PadToken.sol";
import {PadHook} from "./PadHook.sol";

/// @title PadFactory: launches a token straight into a Uniswap v4 pool with the pad hook attached
/// @notice One call: makes the token, opens an ETH / token pool, and puts the whole supply in as one-sided liquidity.
///         There is no bonding curve and no launch minimum. The liquidity position is owned by this contract and has no
///         code path that removes it, so it is locked for good. The creator collects the pool's LP fees.
contract PadFactory {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    IPoolManager public immutable pm;
    PadHook public immutable hook;
    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint24 public constant LP_FEE = 3000;      // 0.30% to the creator
    int24 public constant SPACING = 60;
    int24 public constant RANGE_TICKS = 69_060; // price can climb ~1000x from the start (multiple of SPACING)

    struct Launch {
        address creator;
        address token;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    mapping(PoolId => Launch) public launches;
    PoolKey[] private _keys;

    event Launched(PoolId indexed id, address indexed creator, address token, int24 startTick, bool war, string name, string symbol);
    event FeesCollected(PoolId indexed id, address indexed to, uint256 eth, uint256 tokens);

    error BadTick();
    error NotCreator();
    error NotPM();

    constructor(IPoolManager _pm, PadHook _hook) {
        pm = _pm;
        hook = _hook;
    }

    function launchCount() external view returns (uint256) { return _keys.length; }
    function keyAt(uint256 i) external view returns (PoolKey memory) { return _keys[i]; }

    /// @param startTick pool price at launch, tick of (tokens per ETH). Must be a multiple of 60. A lower tick means a
    ///        higher starting market cap. The price can rise ~1000x from here and the position covers it all.
    function launch(string calldata name, string calldata symbol, int24 startTick, bool war)
        external
        returns (PoolKey memory key, address token)
    {
        if (startTick % SPACING != 0) revert BadTick();
        int24 lo = startTick - RANGE_TICKS;
        if (lo < TickMath.minUsableTick(SPACING) || startTick > TickMath.maxUsableTick(SPACING)) revert BadTick();

        address[] memory skip = new address[](3);
        skip[0] = address(pm);
        skip[1] = address(hook);
        skip[2] = address(this);
        token = address(new PadToken(name, symbol, SUPPLY, address(this), skip));

        key = PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        hook.register(key, msg.sender, token, war);
        pm.initialize(key, TickMath.getSqrtPriceAtTick(startTick));

        uint128 liq = LiquidityAmounts.getLiquidityForAmount1(
            TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(startTick), SUPPLY
        );
        pm.unlock(abi.encode(uint8(0), key, lo, startTick, liq, address(0)));

        PoolId id = key.toId();
        launches[id] = Launch(msg.sender, token, lo, startTick, liq);
        _keys.push(key);
        emit Launched(id, msg.sender, token, startTick, war, name, symbol);
    }

    /// @notice The creator collects the LP fees the pool has earned. Liquidity itself never moves.
    function collectFees(PoolKey calldata key, address to) external returns (uint256 eth, uint256 tokens) {
        PoolId id = key.toId();
        Launch memory l = launches[id];
        if (msg.sender != l.creator) revert NotCreator();
        (eth, tokens) = abi.decode(pm.unlock(abi.encode(uint8(1), key, l.tickLower, l.tickUpper, uint128(0), to)), (uint256, uint256));
        emit FeesCollected(id, to, eth, tokens);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert NotPM();
        (uint8 op, PoolKey memory key, int24 lo, int24 hi, uint128 liq, address to) =
            abi.decode(data, (uint8, PoolKey, int24, int24, uint128, address));
        if (op == 0) {
            (BalanceDelta d,) = pm.modifyLiquidity(
                key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(liq)), salt: 0}), ""
            );
            // one-sided: only the token side is owed; pay it in
            uint256 owe = uint256(uint128(-d.amount1()));
            pm.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).transfer(address(pm), owe);
            pm.settle();
            return "";
        }
        // op == 1: poke the position with zero liquidity to pull out accrued fees
        (, BalanceDelta fees) = pm.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 0, salt: 0}), ""
        );
        uint256 eth = fees.amount0() > 0 ? uint256(uint128(fees.amount0())) : 0;
        uint256 tok = fees.amount1() > 0 ? uint256(uint128(fees.amount1())) : 0;
        if (eth > 0) pm.take(key.currency0, to, eth);
        if (tok > 0) pm.take(key.currency1, to, tok);
        return abi.encode(eth, tok);
    }
}
