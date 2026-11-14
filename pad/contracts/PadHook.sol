// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

interface IFactoryRef {
    function hook() external view returns (address);
    function quote() external view returns (address);
    function pm() external view returns (address);
}

interface IBattleRef {
    function hook() external view returns (address);
    function OFFER_WINDOW() external view returns (uint64);   // only the battle contract has this
}

interface IPadToken {
    function burn(uint256 amount) external;
    function sync() external returns (uint256);
}

/// @title PadHook: the 3% / 3% fee engine for pad launches (quote token = $STAG)
/// @notice Every pool is $STAG / launched token. On a BUY (quote in, token out) the hook takes 3% of the quote: in war mode
///         all of it goes to the project's war chest, in peace mode 1/3 goes to the creator and 2/3 is sent straight to
///         the token for holders. On a SELL (token in, quote out) the hook takes 3% of the quote for the platform.
///         The hook never holds $STAG itself: every cut is kept as an ERC-6909 claim at the PoolManager, which needs no
///         balance to mint (taking real tokens out mid-swap would fail while the buyer has not paid in yet). Real $STAG
///         leaves the PoolManager only when someone claims, and it is always backed by then.
///         A chest can only be spent buying the project's own token and burning it; nobody can withdraw it. The hook
///         counts gross quote volume per pool, which battles use to pick a winner.
///         Swaps that do not fill completely are rejected where the quote side is the specified side, so tax and volume
///         are always on what really traded.
contract PadHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint256 public constant TAX_BPS = 300;   // 3% each way
    uint256 public constant BPS = 10_000;
    int24 public constant MAX_BURN_IMPACT_TICKS = 150;   // a burn may move the price at most ~1.5% per call
    uint256 public constant BURN_GAP = 1 hours;          // minimum time between burns on one pool, creator included
    uint256 public constant FORCED_MIN_STEP = 50_000e18; // quote tokens

    struct Info {
        address creator;
        address token;
        bool registered;
        bool quoteIs0;        // is the quote token currency0 in this pool?
        bool war;             // true = buy tax fills the war chest; false = peace split
        bool locked;          // true while a battle holds the pool
        uint64 freezeAt;      // while locked, volume and fight earnings stop counting after this time
        bool endSnapped;      // chestAtEnd is valid
        uint128 chestAtEnd;   // chest as it stood when the fight ended (first booking after the end takes the snapshot)
        uint128 chest;        // quote tokens waiting to buy and burn
        uint128 creatorOwed;  // peace mode: creator's 1%
        uint128 holderOwed;   // peace mode: holders' 2%, flushed to the token at the next swap (or by pushHolders)
        uint256 volume;       // cumulative gross quote volume
    }

    address public immutable QUOTE;  // $STAG
    address public owner;            // platform
    address public pendingOwner;
    address public factory;
    address public battle;
    uint256 public platformOwed;     // sell-side tax collected, in quote tokens
    mapping(PoolId => Info) public info;
    /// @notice part of a chest that a battle win has marked for burning; anyone can burn it in steps
    mapping(PoolId => uint128) public forced;
    mapping(PoolId => uint64) public lastBurn;

    event PoolRegistered(PoolId indexed id, address indexed creator, address token, bool war, bool quoteIs0);
    event ModeSet(PoolId indexed id, bool war);
    event Taxed(PoolId indexed id, bool buy, uint256 volume, uint256 fee);
    event ChestBurned(PoolId indexed id, uint256 quoteSpent, uint256 tokensBurned);
    event CreatorClaimed(PoolId indexed id, address to, uint256 amount);
    event PlatformClaimed(address to, uint256 amount);
    event OwnerSet(address owner);

    error NotOwner();
    error NotFactory();
    error NotAllowed();
    error NotRegistered();
    error AlreadyRegistered();
    error BadPool();
    error Locked();
    error NothingToDo();
    error Slippage();
    error PartialFill();
    error ZeroAddress();
    error NoFill();
    error BurnTooSoon();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPoolManager _pm, address _owner, address _quote) BaseHook(_pm) {
        if (_owner == address(0) || _quote == address(0)) revert ZeroAddress();
        owner = _owner;
        QUOTE = _quote;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Start a hand-over. The new owner must call acceptOwner, so a typo cannot strand the platform's share.
    function setOwner(address o) external onlyOwner {
        if (o == address(0)) revert ZeroAddress();
        pendingOwner = o;
    }

    function acceptOwner() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerSet(msg.sender);
    }

    /// @dev one-time wiring of the factory and the battle contract
    function wire(address f, address b) external onlyOwner {
        if (factory != address(0) || battle != address(0)) revert NotAllowed();
        if (f == address(0) || b == address(0)) revert ZeroAddress();
        if (f == b) revert BadPool();
        if (IFactoryRef(f).hook() != address(this) || IFactoryRef(f).quote() != QUOTE || IFactoryRef(f).pm() != address(poolManager)) revert BadPool();
        if (IBattleRef(b).hook() != address(this) || IBattleRef(b).OFFER_WINDOW() == 0) revert BadPool();
        factory = f;
        battle = b;
    }

    function claimPlatform(address to) external onlyOwner {
        uint256 a = platformOwed;
        platformOwed = 0;
        _redeem(to, a);
        emit PlatformClaimed(to, a);
    }

    // ------------------------------------------------------------- registry

    function register(PoolKey calldata key, address creator, address token, bool war, bool quoteIs0) external {
        if (msg.sender != factory) revert NotFactory();
        PoolId id = key.toId();
        Info storage i = info[id];
        if (i.registered) revert AlreadyRegistered();
        i.creator = creator;
        i.token = token;
        i.registered = true;
        i.quoteIs0 = quoteIs0;
        i.war = war;
        emit PoolRegistered(id, creator, token, war, quoteIs0);
    }

    /// @notice Creator picks war or peace. Not allowed while a battle holds the pool. Only affects later buys.
    function setMode(PoolKey calldata key, bool war) external {
        PoolId id = key.toId();
        Info storage i = info[id];
        if (msg.sender != i.creator) revert NotAllowed();
        if (i.locked) revert Locked();
        i.war = war;
        emit ModeSet(id, war);
    }

    /// @dev battle contract only. `until` is when volume stops counting for this pool while it is locked.
    function setLocked(PoolKey calldata key, bool l, uint64 until) external {
        if (msg.sender != battle) revert NotAllowed();
        Info storage i = info[key.toId()];
        i.locked = l;
        i.freezeAt = l ? until : 0;
        i.endSnapped = false;
        i.chestAtEnd = 0;
    }

    /// @dev read helper for the battle contract
    function poolState(PoolId id) external view returns (address creator, bool registered, bool war, bool locked, uint128 chest, uint256 volume) {
        Info storage i = info[id];
        return (i.creator, i.registered, i.war, i.locked, i.chest, i.volume);
    }

    // ----------------------------------------------------------- hook setup

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    function _beforeInitialize(address, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        Info storage i = info[key.toId()];
        if (!i.registered) revert NotRegistered();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (i.quoteIs0 ? (c0 != QUOTE || c1 != i.token) : (c0 != i.token || c1 != QUOTE)) revert BadPool();
        return this.beforeInitialize.selector;
    }

    /// @dev Only the factory may add liquidity. A private or just-in-time LP next to the price could otherwise soak up
    ///      a chest burn and withdraw the chest as $STAG. (Zero-liquidity pokes, used to collect fees, are not adds.)
    function _beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (sender != factory) revert NotAllowed();
        return this.beforeAddLiquidity.selector;
    }

    // ----------------------------------------------------------------- swaps

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata p, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender == address(this)) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        PoolId id = key.toId();
        Info storage i = info[id];
        _flush(id, i);                                                 // pay holders what earlier swaps left for them
        bool buy = i.quoteIs0 ? p.zeroForOne : !p.zeroForOne;      // buyer pays quote
        bool exactIn = p.amountSpecified < 0;
        // the quote token is the specified side when (buy and exact-in) or (sell and exact-out)
        if (exactIn != buy) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        uint256 amt = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        uint256 fee = (amt * TAX_BPS) / BPS;
        // tax is booked in afterSwap, once we know the swap really filled
        if (fee > 0) poolManager.mint(address(this), _qid(), fee);
        return (this.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata p, BalanceDelta d, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        if (sender == address(this)) return (this.afterSwap.selector, 0);
        if (d.amount0() == 0 && d.amount1() == 0) revert NoFill();      // nothing traded: no free price pushes
        PoolId id = key.toId();
        Info storage i = info[id];
        bool buy = i.quoteIs0 ? p.zeroForOne : !p.zeroForOne;
        bool exactIn = p.amountSpecified < 0;
        int128 q = i.quoteIs0 ? d.amount0() : d.amount1();            // swapper's quote delta from the pool, before our cut
        uint256 filled = q < 0 ? uint256(uint128(-q)) : uint256(uint128(q));

        if (exactIn == buy) {
            // quote was the specified side: fee already taken. The pool must have used exactly what we left it.
            uint256 amt = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
            uint256 fee = (amt * TAX_BPS) / BPS;
            if (filled != (exactIn ? amt - fee : amt + fee)) revert PartialFill();
            _book(id, buy, filled, fee);
            return (this.afterSwap.selector, 0);
        }
        // quote is the unspecified side: tax what really moved
        uint256 fee2 = (filled * TAX_BPS) / BPS;
        if (fee2 > 0) poolManager.mint(address(this), _qid(), fee2);
        _book(id, buy, filled, fee2);
        return (this.afterSwap.selector, fee2.toInt128());
    }

    function _book(PoolId id, bool buy, uint256 vol, uint256 fee) internal {
        Info storage i = info[id];
        if (!i.locked || block.timestamp < i.freezeAt) i.volume += vol;
        if (!buy) {
            platformOwed += fee;
        } else if (i.war) {
            if (i.locked && !i.endSnapped && block.timestamp >= i.freezeAt) {
                i.chestAtEnd = i.chest;                 // fight earnings stop at the end time; later taxes are not loot
                i.endSnapped = true;
            }
            i.chest += fee.toUint128();
        } else {
            uint256 c = fee / 3;                  // creator's 1%
            i.creatorOwed += c.toUint128();
            i.holderOwed += (fee - c).toUint128();   // holders' 2%
            bytes32 slot = PoolId.unwrap(id);
            assembly { tstore(slot, 1) }             // booked in this transaction: its claims are not settled yet
        }
        emit Taxed(id, buy, vol, fee);
    }

    // ---------------------------------------------------------------- creator

    function claimCreator(PoolKey calldata key, address to) external {
        PoolId id = key.toId();
        Info storage i = info[id];
        if (msg.sender != i.creator) revert NotAllowed();
        uint256 a = i.creatorOwed;
        if (a == 0) revert NothingToDo();
        i.creatorOwed = 0;
        _redeem(to, a);
        emit CreatorClaimed(id, to, a);
    }

    /// @notice Anyone can push the holders' waiting share to the token (it is also pushed at every swap).
    function pushHolders(PoolKey calldata key) external {
        PoolId id = key.toId();
        Info storage i = info[id];
        uint256 a = i.holderOwed;
        if (a == 0) revert NothingToDo();
        i.holderOwed = 0;
        _redeem(i.token, a);
        try IPadToken(i.token).sync() {} catch {}
    }

    function _qid() internal view returns (uint256) {
        return uint256(uint160(QUOTE));
    }

    /// @dev inside a swap the pool manager is already unlocked: turn claims into real $STAG for the token. The
    ///      claims are backed by earlier, already-settled swaps, so the pool manager holds the tokens.
    function _flush(PoolId id, Info storage i) internal {
        uint256 a = i.holderOwed;
        if (a == 0) return;
        bytes32 slot = PoolId.unwrap(id);
        uint256 booked;
        assembly { booked := tload(slot) }
        if (booked != 0) return;                     // an earlier swap in this transaction booked claims the pool manager does not hold yet
        if (Currency.unwrap(poolManager.getSyncedCurrency()) == QUOTE) return;   // a router synced $STAG first: taking tokens now would break its settlement
        i.holderOwed = 0;
        poolManager.burn(address(this), _qid(), a);
        poolManager.take(Currency.wrap(QUOTE), i.token, a);
        try IPadToken(i.token).sync() {} catch {}
    }

    /// @dev outside a swap: unlock, turn claims into real $STAG and send it to `to`
    function _redeem(address to, uint256 amt) internal {
        if (amt == 0) return;
        poolManager.unlock(abi.encode(uint8(2), to, amt, uint256(0), PoolKey(Currency.wrap(address(0)), Currency.wrap(address(0)), 0, 0, IHooks(address(0)))));
    }

    // ----------------------------------------------------------- buy and burn

    /// @notice Spend the war chest buying the project's own token and burn what comes back. Creator only, never while a
    ///         battle holds the pool. Each call moves the price at most ~1.5% and at most one burn per pool per hour
    ///         (creator or stranger), so a price pump can never be bought into and sold out of in one transaction. What the
    ///         pool can't fill within the cap stays in the chest. The buy skips the tax.
    function burnChest(PoolKey calldata key, uint256 minOut) external returns (uint256 burned) {
        PoolId id = key.toId();
        Info storage i = info[id];
        if (msg.sender != i.creator) revert NotAllowed();
        if (i.locked) revert Locked();
        uint256 amt = i.chest;
        if (amt == 0) revert NothingToDo();
        _gap(id);
        burned = _spend(id, key, amt, minOut);
    }

    /// @notice After a battle win the winning chest is marked "forced". Anyone can burn it in steps so the burn happens
    ///         even if the creator never acts. Same one-per-hour limit as every burn; the creator's step is the whole
    ///         forced amount (still capped by the 1.5% price limit), a stranger's is max(1/10, 50,000 $STAG).
    function burnForced(PoolKey calldata key, uint256 minOut) external returns (uint256 burned) {
        PoolId id = key.toId();
        Info storage i = info[id];
        if (i.locked) revert Locked();
        uint256 f = forced[id];
        if (f == 0) revert NothingToDo();
        uint256 step = f;
        if (msg.sender != i.creator) {
            uint256 tenth = f / 10;
            step = f <= FORCED_MIN_STEP ? f : (tenth > FORCED_MIN_STEP ? tenth : FORCED_MIN_STEP);
        }
        if (step > i.chest) step = i.chest;
        if (step == 0) revert NothingToDo();
        _gap(id);
        burned = _spend(id, key, step, minOut);
    }

    /// @dev one burn per pool per hour; the timer only restarts if the burn really bought something (see _spend)
    function _gap(PoolId id) internal view {
        if (block.timestamp < uint256(lastBurn[id]) + BURN_GAP) revert BurnTooSoon();
    }

    function _spend(PoolId id, PoolKey calldata key, uint256 amt, uint256 minOut) internal returns (uint256 burned) {
        Info storage i = info[id];
        i.chest -= amt.toUint128();
        uint256 paid;
        (paid, burned) = abi.decode(poolManager.unlock(abi.encode(uint8(1), address(0), amt, minOut, key)), (uint256, uint256));
        if (paid < amt) i.chest += (amt - paid).toUint128();           // unfilled part stays in the chest
        if (paid > 0) lastBurn[id] = uint64(block.timestamp);
        uint128 f = forced[id];
        f = f > paid ? f - uint128(paid) : 0;
        forced[id] = f > i.chest ? i.chest : f;
        emit ChestBurned(id, paid, burned);
    }

    /// @dev Battle contract only. Only what each pool EARNED during the fight is at stake: the part of its chest, as it
    ///      stood when the fight ended, above the level it had when the battle started. The loser's fight earnings join the
    ///      winner's chest, and the winner's fight earnings plus that loot are marked for burning. Older chest money and
    ///      anything taxed after the end stays with its pool.
    function settleChests(PoolKey calldata loser, PoolKey calldata winner, uint128 loserStart, uint128 winnerStart) external {
        if (msg.sender != battle) revert NotAllowed();
        PoolId l = loser.toId();
        PoolId w = winner.toId();
        uint128 lAtEnd = info[l].endSnapped ? info[l].chestAtEnd : info[l].chest;
        uint128 wAtEnd = info[w].endSnapped ? info[w].chestAtEnd : info[w].chest;
        uint128 lootL = lAtEnd > loserStart ? lAtEnd - loserStart : 0;
        uint128 earnW = wAtEnd > winnerStart ? wAtEnd - winnerStart : 0;
        info[l].chest -= lootL;
        info[w].chest += lootL;
        forced[l] = 0;
        forced[w] = earnW + lootL;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotAllowed();
        (uint8 op, address to, uint256 amt, uint256 minOut, PoolKey memory key) =
            abi.decode(data, (uint8, address, uint256, uint256, PoolKey));
        if (op == 2) {                                               // redeem claims -> real $STAG to `to`
            poolManager.burn(address(this), _qid(), amt);
            poolManager.take(Currency.wrap(QUOTE), to, amt);
            return "";
        }
        // op == 1: the burn swap
        PoolId id = key.toId();
        bool q0 = info[id].quoteIs0;
        // buying the token with quote: quote is currency0 -> zeroForOne; price (token1/token0) falls. Otherwise it rises.
        (, int24 tick,,) = poolManager.getSlot0(id);
        int24 limitTick = q0 ? tick - MAX_BURN_IMPACT_TICKS : tick + MAX_BURN_IMPACT_TICKS;
        if (limitTick < TickMath.MIN_TICK + 1) limitTick = TickMath.MIN_TICK + 1;
        if (limitTick > TickMath.MAX_TICK - 1) limitTick = TickMath.MAX_TICK - 1;
        uint160 limit = TickMath.getSqrtPriceAtTick(limitTick);
        {
            (uint160 sqrtP,,,) = poolManager.getSlot0(id);
            if (q0 ? limit >= sqrtP : limit <= sqrtP) {                  // pool at its edge: nothing to buy now
                if (minOut > 0) revert Slippage();
                return abi.encode(uint256(0), uint256(0));
            }
        }
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({zeroForOne: q0, amountSpecified: -int256(amt), sqrtPriceLimitX96: limit}),
            ""
        );
        int128 qd = q0 ? d.amount0() : d.amount1();
        int128 td = q0 ? d.amount1() : d.amount0();
        uint256 paid = qd < 0 ? uint256(uint128(-qd)) : 0;
        uint256 got = td > 0 ? uint256(uint128(td)) : 0;
        if (got < minOut) revert Slippage();
        if (paid > 0) poolManager.burn(address(this), _qid(), paid);  // pay the swap with our claims: no token transfer
        if (got > 0) {
            address token = info[id].token;
            poolManager.take(Currency.wrap(token), address(this), got);
            IPadToken(token).burn(got);
        }
        return abi.encode(paid, got);
    }
}
