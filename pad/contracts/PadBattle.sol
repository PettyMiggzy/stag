// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PadHook} from "./PadHook.sol";

/// @title PadBattle: two projects, a clock, and one winner
/// @notice A creator challenges another project and sets the terms (how long it runs). Making an offer locks the
///         challenger's pool (no mode change, no burning) so the opponent knows what they are accepting. The other creator
///         accepts on chain or the offer lapses; once accepted both pools stay locked and the hook stops counting volume
///         for each pool after the end time. When the clock runs out anyone can settle. The pool with more gross volume
///         since the start wins; the loser's war chest joins the winner's and the combined chest is marked for burning.
///         A tie moves nothing. Nobody, platform included, can pick or change a result.
contract PadBattle {
    using PoolIdLibrary for PoolKey;

    PadHook public immutable hook;
    uint64 public constant MIN_DURATION = 1 hours;
    uint64 public constant MAX_DURATION = 14 days;
    uint64 public constant OFFER_WINDOW = 3 days;

    enum State { None, Offered, Live, Settled, Cancelled }

    struct Battle {
        PoolKey a;            // challenger
        PoolKey b;            // opponent
        uint64 duration;
        uint64 offerExpiry;
        uint64 start;
        uint64 end;
        uint256 volA0;
        uint256 volB0;
        State state;
    }

    uint256 public count;
    mapping(uint256 => Battle) private battles;

    event Challenged(uint256 indexed id, PoolId indexed a, PoolId indexed b, uint64 duration, uint64 offerExpiry);
    event Accepted(uint256 indexed id, uint64 start, uint64 end);
    event Cancelled(uint256 indexed id);
    event Settled(uint256 indexed id, PoolId winner, PoolId loser, uint256 volWinner, uint256 volLoser, uint256 chestWon);
    event Tied(uint256 indexed id, uint256 volA, uint256 volB);

    error NotAllowed();
    error BadState();
    error BadTerms();
    error NotReady();

    constructor(PadHook _hook) {
        hook = _hook;
    }

    function get(uint256 id) external view returns (Battle memory) {
        return battles[id];
    }

    /// @notice Offer a battle. You must be the creator of `a`, in war mode and unlocked. This locks your pool until the
    ///         offer is accepted, withdrawn or lapses. Terms: `duration` in seconds.
    function challenge(PoolKey calldata a, PoolKey calldata b, uint64 duration) external returns (uint256 id) {
        PoolId ia = a.toId();
        PoolId ib = b.toId();
        (address ca, bool ra, bool wa, bool la,,) = hook.poolState(ia);
        (, bool rb,,,,) = hook.poolState(ib);
        if (msg.sender != ca || !ra || !rb || PoolId.unwrap(ia) == PoolId.unwrap(ib)) revert NotAllowed();
        if (!wa || la) revert BadTerms();                             // must be in war mode and not already in a fight
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadTerms();
        id = count++;
        Battle storage x = battles[id];
        x.a = a;
        x.b = b;
        x.duration = duration;
        x.offerExpiry = uint64(block.timestamp) + OFFER_WINDOW;
        x.state = State.Offered;
        hook.setLocked(a, true, type(uint64).max);                    // volume keeps counting; snapshot is taken at accept
        emit Challenged(id, ia, ib, duration, x.offerExpiry);
    }

    /// @notice The opponent's creator accepts the terms. Their pool locks too and the clock starts now.
    function accept(uint256 id) external {
        Battle storage x = battles[id];
        if (x.state != State.Offered || block.timestamp > x.offerExpiry) revert BadState();
        (, , bool wa,, , uint256 va) = hook.poolState(x.a.toId());      // locked since challenge
        (address cb,, bool wb, bool lb,, uint256 vb) = hook.poolState(x.b.toId());
        if (msg.sender != cb) revert NotAllowed();
        if (!wa || !wb || lb) revert BadTerms();                      // both at war, opponent free
        x.volA0 = va;
        x.volB0 = vb;
        x.start = uint64(block.timestamp);
        x.end = uint64(block.timestamp) + x.duration;
        x.state = State.Live;
        hook.setLocked(x.a, true, x.end);
        hook.setLocked(x.b, true, x.end);
        emit Accepted(id, x.start, x.end);
    }

    /// @notice The challenger can withdraw an unaccepted offer; anyone can clear one that has lapsed. Frees the pool.
    function cancel(uint256 id) external {
        Battle storage x = battles[id];
        if (x.state != State.Offered) revert BadState();
        (address ca,,,,,) = hook.poolState(x.a.toId());
        if (msg.sender != ca && block.timestamp <= x.offerExpiry) revert NotAllowed();
        x.state = State.Cancelled;
        hook.setLocked(x.a, false, 0);
        emit Cancelled(id);
    }

    /// @notice After the clock runs out, anyone settles. Volume stopped counting at the end time, so the order of
    ///         transactions after it cannot change the result.
    function settle(uint256 id) external {
        Battle storage x = battles[id];
        if (x.state != State.Live) revert BadState();
        if (block.timestamp < x.end) revert NotReady();
        (,,,,, uint256 va) = hook.poolState(x.a.toId());
        (,,,,, uint256 vb) = hook.poolState(x.b.toId());
        va -= x.volA0;
        vb -= x.volB0;
        x.state = State.Settled;
        hook.setLocked(x.a, false, 0);
        hook.setLocked(x.b, false, 0);
        if (va == vb) {
            emit Tied(id, va, vb);
            return;
        }
        bool aWins = va > vb;
        PoolKey memory w = aWins ? x.a : x.b;
        PoolKey memory l = aWins ? x.b : x.a;
        (,,,, uint128 lostChest,) = hook.poolState(l.toId());
        hook.settleChests(l, w);
        emit Settled(id, w.toId(), l.toId(), aWins ? va : vb, aWins ? vb : va, lostChest);
    }
}
