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
import {OpenHook} from "./OpenHook.sol";

/// @title OpenPad: bring a token that already exists into a $STAG pool with the pad hook attached
/// @notice NEW AND UNAUDITED.
///         One call (`bring`): the caller hands over some of an existing ERC-20, this contract opens the one
///         $STAG / token pool for it on OpenHook and puts those tokens in as one-sided liquidity, exactly the shape
///         PadFactory uses. The position belongs to this contract and there is no code path that removes it, for
///         anyone, the platform owner included. The caller becomes the pool's "creator": they may switch war / peace,
///         burn the chest, claim the creator share, collect the pool's LP fee and accept or offer battles.
///         BEING THE CREATOR PROVES NOTHING ABOUT WHO OWNS THE TOKEN'S PROJECT: it only means "this wallet seeded
///         the pool". There is one pool per token, first come first served.
///         The token must behave like a plain ERC-20. What can be checked on chain is checked here at registration
///         (see `bring`); what cannot be checked (blacklists, pausing, upgrades, minting, a fee or rebase that is
///         switched on later) is listed in OPEN_HOOK.md and is the buyer's risk.
///         Platform owner (the OpenHook owner) powers here: choose whether anyone may bring a token or only listed
///         ones, list a token (optionally for one named wallet), and deny a token. All three only decide who may
///         REGISTER. None of them reaches a pool that already exists, its liquidity or anyone's funds.
contract OpenPad {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    OpenHook public immutable hook;
    address public immutable quote;                       // $STAG
    uint24 public constant LP_FEE = 3000;                 // 0.30% to the creator (same as PadFactory)
    int24 public constant SPACING = 60;
    int24 public constant RANGE_TICKS = 69_060;           // price can climb ~1000x from the start (same as PadFactory)
    uint256 public constant MIN_SEED_VALUE = 1_000_000e18; // the seeded tokens, valued at the start price, in $STAG (thin pools are easy to push around)
    uint256 public constant MIN_SUPPLY_BPS = 100;         // and at least 1% of the token's total supply
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_PRICE = 1e6;              // start price bounds, in $STAG-wei per whole token (1e18 = 1 $STAG)
    uint256 public constant MAX_PRICE = 1e30;
    uint256 public constant MAX_SUPPLY = 1e33;            // keeps every product below far inside uint256 / uint128
    uint256 public constant PROBE = 1e6;                  // token-wei per test transfer (a millionth of a millionth of a token): big enough that a percentage fee cannot round to nothing
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public constant ANYONE = address(type(uint160).max);   // allow-list entry meaning "any wallet may bring this token"

    struct Pool {
        address creator;
        address token;
        int24 tickLower;
        int24 tickUpper;
    }

    /// @notice true: only tokens the owner has listed may be brought. false: any token that is not denied.
    bool public curated;
    /// @notice token => the wallet allowed to bring it while `curated` (ANYONE = any wallet, zero = not listed)
    mapping(address => address) public allowedSeeder;
    /// @notice tokens the owner has refused; checked in both modes
    mapping(address => bool) public denied;

    mapping(PoolId => Pool) public pools;
    mapping(address => uint256) private _index;           // token => position in _keys, plus one
    PoolKey[] private _keys;

    event Brought(PoolId indexed id, address indexed creator, address indexed token, uint256 seeded, uint256 stagPerToken, bool war);
    event FeesCollected(PoolId indexed id, address indexed to, uint256 amount0, uint256 amount1);
    event CuratedSet(bool curated);
    event Allowed(address indexed token, address seeder);
    event DeniedSet(address indexed token, bool denied);

    error NotOwner();
    error NotCreator();
    error NotPM();
    error NotListed();
    error Denied();
    error AlreadyBrought();
    error BadToken();
    error BadDecimals();
    error BadPrice();
    error SeedTooSmall();
    error TokenMisbehaved();
    error Reentrancy();

    /// transient reentrancy lock (cancun)
    bytes32 private constant LOCK = keccak256("OpenPad.lock");

    modifier nonReentrant() {
        bytes32 s = LOCK;
        uint256 v;
        assembly { v := tload(s) }
        if (v != 0) revert Reentrancy();
        assembly { tstore(s, 1) }
        _;
        assembly { tstore(s, 0) }
    }

    /// the platform owner is whoever owns the hook right now (two-step hand-over lives there)
    modifier onlyOwner() {
        if (msg.sender != hook.owner()) revert NotOwner();
        _;
    }

    constructor(IPoolManager _pm, OpenHook _hook, address _quote, bool _curated) {
        pm = _pm;
        hook = _hook;
        quote = _quote;
        curated = _curated;
        emit CuratedSet(_curated);
    }

    // ---------------------------------------------------------------- views

    function count() external view returns (uint256) { return _keys.length; }
    function keyAt(uint256 i) external view returns (PoolKey memory) { return _keys[i]; }
    function isBrought(address token) external view returns (bool) { return _index[token] != 0; }
    /// @notice the pool of a brought-in token (reverts if there is none)
    function keyOf(address token) external view returns (PoolKey memory) {
        uint256 n = _index[token];
        if (n == 0) revert BadToken();
        return _keys[n - 1];
    }

    // ---------------------------------------------------------------- owner: who may register (nothing else)

    function setCurated(bool c) external onlyOwner {
        curated = c;
        emit CuratedSet(c);
    }

    /// @param seeder the one wallet allowed to bring `token` while curated, ANYONE for any wallet, zero to unlist
    function allow(address token, address seeder) external onlyOwner {
        allowedSeeder[token] = seeder;
        emit Allowed(token, seeder);
    }

    function deny(address token, bool d) external onlyOwner {
        denied[token] = d;
        emit DeniedSet(token, d);
    }

    // ---------------------------------------------------------------- bring

    /// @notice Open the $STAG pool for an existing token and lock `amount` of it in as liquidity. The caller must
    ///         have approved this contract for `amount + 2 * PROBE` tokens (PROBE is lost to the dead address, PROBE comes back). Reverts unless every check passes:
    ///           - the token is a contract, is not $STAG / the pool manager / the hook / this contract, has no pool yet;
    ///           - decimals() is exactly 18 and total supply is between 1 wei and 1e33;
    ///           - the seed is at least 1% of total supply and worth at least 1,000,000 $STAG at the start price;
    ///           - pulling the tokens moves EXACTLY the amount on both sides (no fee on transferFrom);
    ///           - a PROBE-sized transfer to the dead address and one back to the caller move EXACTLY that much on
    ///             both sides (no fee on transfer of one part in a million or more; the dead address, where chest
    ///             burns go, can receive);
    ///           - the transfer into the pool manager moves EXACTLY what is owed (and the pool manager can receive);
    ///           - total supply and this contract's own balance are unchanged from start to end (no rebase, mint or
    ///             burn was triggered by any of the transfers).
    ///         These checks see only how the token behaves in this one transaction. See OPEN_HOOK.md for the rest.
    /// @param stagPerToken start price: $STAG-wei per whole token (1e18 = 1 $STAG per token). The pool starts at the
    ///        nearest 60-tick step at or above it and the range runs ~1000x upward, tokens only, as in PadFactory.
    ///        If this is below the token's market price elsewhere, the first buyers get the difference.
    function bring(address token, uint256 amount, uint256 stagPerToken, bool war)
        external
        nonReentrant
        returns (PoolKey memory key)
    {
        // who may register
        if (denied[token]) revert Denied();
        if (curated) {
            address s = allowedSeeder[token];
            if (s != ANYONE && s != msg.sender) revert NotListed();
        }
        if (_index[token] != 0) revert AlreadyBrought();

        // the token's shape
        if (token == quote || token == address(pm) || token == address(hook) || token == address(this)) revert BadToken();
        if (token.code.length == 0) revert BadToken();
        if (_decimals(token) != 18) revert BadDecimals();
        if (stagPerToken < MIN_PRICE || stagPerToken > MAX_PRICE) revert BadPrice();
        IERC20 t = IERC20(token);
        uint256 supply = t.totalSupply();
        if (supply == 0 || supply > MAX_SUPPLY) revert BadToken();
        if (amount > supply || amount * BPS < supply * MIN_SUPPLY_BPS) revert SeedTooSmall();
        if (FullMath.mulDiv(amount, stagPerToken, 1e18) < MIN_SEED_VALUE) revert SeedTooSmall();

        // pull the seed plus two probes, then prove plain transfers move exactly what they say
        uint256 own = t.balanceOf(address(this));
        _pullExact(t, msg.sender, amount + 2 * PROBE);
        _sendExact(t, DEAD, PROBE);
        _sendExact(t, msg.sender, PROBE);

        // the pool: one per token, key fully determined by the token
        bool quoteIs0 = quote < token;
        key = PoolKey({
            currency0: Currency.wrap(quoteIs0 ? quote : token),
            currency1: Currency.wrap(quoteIs0 ? token : quote),
            fee: LP_FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        hook.register(key, msg.sender, token, war, quoteIs0);
        (int24 lo, int24 hi, int24 start, uint128 liq) = _range(amount, stagPerToken, quoteIs0);
        pm.initialize(key, TickMath.getSqrtPriceAtTick(start));
        uint256 used = abi.decode(pm.unlock(abi.encode(uint8(0), key, lo, hi, liq, address(0), quoteIs0)), (uint256));

        // rounding leaves a few wei unused: hand them back, then nothing of this token may be left here
        if (used > amount) revert TokenMisbehaved();
        if (amount > used) _sendExact(t, msg.sender, amount - used);
        if (t.balanceOf(address(this)) != own || t.totalSupply() != supply) revert TokenMisbehaved();

        PoolId id = key.toId();
        pools[id] = Pool(msg.sender, token, lo, hi);
        _keys.push(key);
        _index[token] = _keys.length;
        emit Brought(id, msg.sender, token, used, stagPerToken, war);
    }

    /// @dev decimals() must exist and return one word; anything else counts as "not 18"
    function _decimals(address token) internal view returns (uint256) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || r.length != 32) return type(uint256).max;
        return abi.decode(r, (uint256));
    }

    /// @dev transferFrom that must move exactly `amt`: the payer loses it and this contract gains it
    function _pullExact(IERC20 t, address from, uint256 amt) internal {
        uint256 f0 = t.balanceOf(from);
        uint256 m0 = t.balanceOf(address(this));
        t.safeTransferFrom(from, address(this), amt);
        if (f0 < amt || t.balanceOf(from) != f0 - amt || t.balanceOf(address(this)) != m0 + amt) revert TokenMisbehaved();
    }

    /// @dev transfer that must move exactly `amt`: this contract loses it and the receiver gains it
    function _sendExact(IERC20 t, address to, uint256 amt) internal {
        uint256 r0 = t.balanceOf(to);
        uint256 m0 = t.balanceOf(address(this));
        t.safeTransfer(to, amt);
        if (m0 < amt || t.balanceOf(address(this)) != m0 - amt || t.balanceOf(to) != r0 + amt) revert TokenMisbehaved();
    }

    /// @dev Same shape as PadFactory._range, with the price given per token instead of as a fully-diluted value.
    ///      The token is the only asset in the range at the start. If quote is currency0 the token is currency1: the
    ///      pool starts at the TOP of the range and buyers (paying quote) push the tick down. Otherwise the pool starts
    ///      at the BOTTOM and buyers push the tick up. Either way the start is never below the requested price.
    function _range(uint256 amount, uint256 stagPerToken, bool quoteIs0)
        internal
        pure
        returns (int24 lo, int24 hi, int24 start, uint128 liq)
    {
        // price (token1 / token0) as sqrtPriceX96
        uint256 ratioX192 = quoteIs0 ? FullMath.mulDiv(1e18, 1 << 192, stagPerToken) : FullMath.mulDiv(stagPerToken, 1 << 192, 1e18);
        uint256 sq = Math.sqrt(ratioX192);
        if (sq <= TickMath.MIN_SQRT_PRICE || sq >= TickMath.MAX_SQRT_PRICE) revert BadPrice();
        int24 tick = TickMath.getTickAtSqrtPrice(uint160(sq));
        start = _floor(tick);
        if (!quoteIs0 && TickMath.getSqrtPriceAtTick(start) < sq) start += SPACING;   // token is currency0: price is quote-per-token, round UP
        if (quoteIs0) {
            hi = start;
            lo = start - RANGE_TICKS;
            liq = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), amount);
        } else {
            lo = start;
            hi = start + RANGE_TICKS;
            liq = LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), amount);
        }
        if (lo < TickMath.minUsableTick(SPACING) || hi > TickMath.maxUsableTick(SPACING)) revert BadPrice();
        if (liq == 0) revert SeedTooSmall();
    }

    function _floor(int24 t) internal pure returns (int24) {
        int24 r = t % SPACING;
        if (r < 0) r += SPACING;
        return t - r;
    }

    // ---------------------------------------------------------------- creator

    /// @notice The creator collects the LP fees the pool has earned. Liquidity itself never moves.
    function collectFees(PoolKey calldata key, address to) external nonReentrant returns (uint256 a0, uint256 a1) {
        PoolId id = key.toId();
        Pool memory p = pools[id];
        if (p.creator == address(0) || msg.sender != p.creator) revert NotCreator();
        (a0, a1) = abi.decode(pm.unlock(abi.encode(uint8(1), key, p.tickLower, p.tickUpper, uint128(0), to, false)), (uint256, uint256));
        emit FeesCollected(id, to, a0, a1);
    }

    /// @dev The only two things this contract ever does inside the pool manager: add the seed (op 0, from `bring`
    ///      only) and poke its own position with ZERO liquidity to pull out fees (op 1). No call here passes a
    ///      negative liquidityDelta, so the position can only ever grow by the one seed.
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
            uint256 pay = uint256(uint128(-owed));
            IERC20 t = IERC20(Currency.unwrap(tokenCur));
            uint256 m0 = t.balanceOf(address(this));
            uint256 p0 = t.balanceOf(address(pm));
            pm.sync(tokenCur);
            t.safeTransfer(address(pm), pay);
            if (m0 < pay || t.balanceOf(address(this)) != m0 - pay || t.balanceOf(address(pm)) != p0 + pay) revert TokenMisbehaved();
            pm.settle();
            return abi.encode(pay);
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
