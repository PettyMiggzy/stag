// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";

interface IPadToken {
    function burn(uint256 amount) external;
    function depositDividends() external payable;
}

/// @title PadHook: the 3% / 3% fee engine for pad launches
/// @notice Every pool is ETH / token. On a BUY the hook takes 3% of the ETH: in war mode all of it goes to the project's
///         war chest, in peace mode 1/3 goes to the creator and 2/3 to holders. On a SELL the hook takes 3% of the ETH
///         for the platform. A war chest can only be spent buying the project's own token and burning it; nobody can
///         withdraw it as ETH. The hook also counts gross ETH volume per pool, which battles use to pick a winner.
contract PadHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;

    uint256 public constant TAX_BPS = 300;   // 3% each way
    uint256 public constant BPS = 10_000;

    struct Info {
        address creator;
        address token;
        bool registered;
        bool war;             // true = buy tax fills the war chest; false = peace split
        bool locked;          // true while a battle holds the mode
        uint128 chest;        // ETH waiting to buy and burn
        uint128 creatorOwed;  // peace mode: creator's 1%
        uint128 holderOwed;   // peace mode: holders' 2%, waiting to be pushed to the token
        uint256 volume;       // cumulative gross ETH volume
    }

    address public owner;            // platform
    address public factory;          // the only contract that can register pools
    address public battle;           // the battle contract (locks modes, can trigger the burn)
    uint256 public platformOwed;     // sell-side tax collected
    mapping(PoolId => Info) public info;
    /// @notice part of a chest that a battle win has marked for burning; anyone can burn it in small steps
    mapping(PoolId => uint128) public forced;
    mapping(PoolId => uint64) public lastForced;
    uint256 public constant FORCED_GAP = 1 hours;
    uint256 public constant FORCED_MIN_STEP = 0.05 ether;

    event PoolRegistered(PoolId indexed id, address indexed creator, address token, bool war);
    event ModeSet(PoolId indexed id, bool war);
    event Taxed(PoolId indexed id, bool buy, uint256 volume, uint256 fee);
    event ChestBurned(PoolId indexed id, uint256 ethSpent, uint256 tokensBurned);
    event CreatorClaimed(PoolId indexed id, address to, uint256 amount);
    event HoldersPushed(PoolId indexed id, uint256 amount);
    event PlatformClaimed(address to, uint256 amount);

    error NotOwner();
    error NotFactory();
    error NotAllowed();
    error NotRegistered();
    error BadPool();
    error Locked();
    error NothingToDo();
    error Slippage();
    error SendFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IPoolManager _pm, address _owner) BaseHook(_pm) {
        owner = _owner;
    }

    receive() external payable {}

    // ---------------------------------------------------------------- admin

    function setOwner(address o) external onlyOwner { owner = o; }

    /// @dev one-time wiring; each can be set once so the platform cannot swap them out under live projects
    function setFactory(address f) external onlyOwner {
        if (factory != address(0)) revert NotAllowed();
        factory = f;
    }

    function setBattle(address b) external onlyOwner {
        if (battle != address(0)) revert NotAllowed();
        battle = b;
    }

    function claimPlatform(address to) external onlyOwner {
        uint256 a = platformOwed;
        platformOwed = 0;
        _send(to, a);
        emit PlatformClaimed(to, a);
    }

    // ------------------------------------------------------------- registry

    function register(PoolKey calldata key, address creator, address token, bool war) external {
        if (msg.sender != factory) revert NotFactory();
        PoolId id = key.toId();
        info[id] = Info(creator, token, true, war, false, 0, 0, 0, 0);
        emit PoolRegistered(id, creator, token, war);
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

    function setLocked(PoolKey calldata key, bool l) external {
        if (msg.sender != battle) revert NotAllowed();
        info[key.toId()].locked = l;
    }

    // ----------------------------------------------------------- hook setup

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    function _beforeInitialize(address, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        Info storage i = info[key.toId()];
        if (!i.registered) revert NotRegistered();
        if (!key.currency0.isAddressZero() || Currency.unwrap(key.currency1) != i.token) revert BadPool();
        return this.beforeInitialize.selector;
    }

    // ----------------------------------------------------------------- swaps

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata p, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender == address(this)) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        bool exactIn = p.amountSpecified < 0;
        // ETH is currency0. It is the specified side when (buy and exact-in) or (sell and exact-out).
        if (p.zeroForOne != exactIn) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        uint256 amt = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        uint256 fee = (amt * TAX_BPS) / BPS;
        _book(key.toId(), p.zeroForOne, amt, fee);
        if (fee > 0) poolManager.take(key.currency0, address(this), fee);
        return (this.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata p, BalanceDelta d, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        if (sender == address(this)) return (this.afterSwap.selector, 0);
        bool exactIn = p.amountSpecified < 0;
        // ETH is the unspecified side when (buy and exact-out) or (sell and exact-in)
        if (p.zeroForOne == exactIn) return (this.afterSwap.selector, 0);
        int128 a0 = d.amount0();
        uint256 amt = a0 < 0 ? uint256(uint128(-a0)) : uint256(uint128(a0));
        uint256 fee = (amt * TAX_BPS) / BPS;
        _book(key.toId(), p.zeroForOne, amt, fee);
        if (fee > 0) poolManager.take(key.currency0, address(this), fee);
        return (this.afterSwap.selector, fee.toInt128());
    }

    function _book(PoolId id, bool buy, uint256 vol, uint256 fee) internal {
        Info storage i = info[id];
        i.volume += vol;
        if (!buy) {
            platformOwed += fee;
        } else if (i.war) {
            i.chest += uint128(fee);
        } else {
            uint256 c = fee / 3;                  // creator's 1%
            i.creatorOwed += uint128(c);
            i.holderOwed += uint128(fee - c);     // holders' 2%
        }
        emit Taxed(id, buy, vol, fee);
    }

    // --------------------------------------------------- creator and holders

    function claimCreator(PoolKey calldata key, address to) external {
        PoolId id = key.toId();
        Info storage i = info[id];
        if (msg.sender != i.creator) revert NotAllowed();
        uint256 a = i.creatorOwed;
        if (a == 0) revert NothingToDo();
        i.creatorOwed = 0;
        _send(to, a);
        emit CreatorClaimed(id, to, a);
    }

    /// @notice Anyone can push the holders' share to the token. Costs the caller only gas.
    function pushHolders(PoolKey calldata key) external {
        PoolId id = key.toId();
        Info storage i = info[id];
        uint256 a = i.holderOwed;
        if (a == 0) revert NothingToDo();
        i.holderOwed = 0;
        IPadToken(i.token).depositDividends{value: a}();
        emit HoldersPushed(id, a);
    }

    // ----------------------------------------------------------- buy and burn

    /// @notice Spend the war chest buying the project's own token and burn what comes back.
    ///         The creator may do this any time EXCEPT while a battle holds the pool (otherwise a loser could empty
    ///         the chest before the result). The buy skips the tax (it would only feed the chest again).
    function burnChest(PoolKey calldata key, uint256 minOut) external returns (uint256 burned) {
        PoolId id = key.toId();
        Info storage i = info[id];
        if (msg.sender != i.creator) revert NotAllowed();
        if (i.locked) revert Locked();
        uint256 amt = i.chest;
        if (amt == 0) revert NothingToDo();
        burned = _spend(id, key, amt, minOut);
    }

    /// @notice After a battle win, the winning chest is marked "forced". Anyone can burn it in steps (at least an hour
    ///         apart, a tenth of it or 0.05 ETH at a time) so the burn happens even if the creator never does it.
    function burnForced(PoolKey calldata key, uint256 minOut) external returns (uint256 burned) {
        PoolId id = key.toId();
        uint256 f = forced[id];
        if (f == 0) revert NothingToDo();
        if (msg.sender != info[id].creator) {
            if (block.timestamp < uint256(lastForced[id]) + FORCED_GAP) revert NotAllowed();
            lastForced[id] = uint64(block.timestamp);
        }
        uint256 step = f <= FORCED_MIN_STEP ? f : (f / 10 > FORCED_MIN_STEP ? f / 10 : FORCED_MIN_STEP);
        if (msg.sender == info[id].creator) step = f;
        if (step > info[id].chest) step = info[id].chest;
        if (step == 0) revert NothingToDo();
        burned = _spend(id, key, step, minOut);
    }

    function _spend(PoolId id, PoolKey calldata key, uint256 amt, uint256 minOut) internal returns (uint256 burned) {
        Info storage i = info[id];
        i.chest -= uint128(amt);
        if (forced[id] > i.chest) forced[id] = i.chest;
        burned = abi.decode(poolManager.unlock(abi.encode(key, amt, minOut)), (uint256));
        emit ChestBurned(id, amt, burned);
    }

    /// @dev Battle contract only: move the loser's chest into the winner's and mark the combined chest for burning.
    function settleChests(PoolKey calldata loser, PoolKey calldata winner) external {
        if (msg.sender != battle) revert NotAllowed();
        PoolId l = loser.toId();
        PoolId w = winner.toId();
        uint128 a = info[l].chest;
        info[l].chest = 0;
        forced[l] = 0;
        info[w].chest += a;
        forced[w] = info[w].chest;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotAllowed();
        (PoolKey memory key, uint256 amt, uint256 minOut) = abi.decode(data, (PoolKey, uint256, uint256));
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(amt), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            ""
        );
        uint256 paid = uint256(uint128(-d.amount0()));
        uint256 got = uint256(uint128(d.amount1()));
        if (got < minOut) revert Slippage();
        poolManager.settle{value: paid}();
        poolManager.take(key.currency1, address(this), got);
        IPadToken(Currency.unwrap(key.currency1)).burn(got);
        if (paid < amt) info[key.toId()].chest += uint128(amt - paid); // pool could not fill it all: keep the rest
        return abi.encode(got);
    }

    function _send(address to, uint256 a) internal {
        (bool ok,) = to.call{value: a}("");
        if (!ok) revert SendFailed();
    }
}
