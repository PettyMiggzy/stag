// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

interface IPadHookView {
    function battle() external view returns (address);
    function factory() external view returns (address);
    function forced(PoolId id) external view returns (uint128);
    function poolState(PoolId id)
        external
        view
        returns (address creator, bool registered, bool war, bool locked, uint128 chest, uint256 volume);
}

interface IPadBattleView {
    function hook() external view returns (address);
}

/// @title PadRegistry: one read-only place that knows both pad systems
/// @notice NEW AND UNAUDITED. No owner, no state after construction, holds nothing, can change nothing: it only reads.
///         It names the two hooks (the launched-token hook, PadHook, and the brought-in-token hook, OpenHook) and
///         reads from each hook which battle contract it is wired to, so it cannot be told a wrong pairing.
///         What it answers: is this pool a pad pool, which system is it in, and which battle contract (if any) can
///         run a fight between two given pools.
///         THE LIMIT IT MAKES VISIBLE: a fight needs one battle contract that both pools' hook obeys, and a chest can
///         only move inside one hook. PadHook obeys only the battle contract it was wired to, once, for good. So two
///         pools on different hooks cannot fight; `battleFor` returns zero for them. A token launched on the old hook
///         can still fight brought-in tokens by being brought in itself (a second pool, on OpenHook).
contract PadRegistry {
    using PoolIdLibrary for PoolKey;

    uint8 public constant NONE = 0;
    uint8 public constant LAUNCHED = 1;   // made by PadFactory, on PadHook
    uint8 public constant BROUGHT = 2;    // brought in through OpenPad, on OpenHook

    address public immutable launchedHook;     // zero if that system is not part of this registry
    address public immutable launchedBattle;
    address public immutable openHook;
    address public immutable openBattle;

    error BadHook();

    /// @param _launchedHook the PadHook (or zero). @param _openHook the OpenHook. Each given hook must already be
    ///        wired, and its battle contract must point back at it.
    constructor(address _launchedHook, address _openHook) {
        if (_openHook == address(0) || _openHook == _launchedHook) revert BadHook();
        launchedHook = _launchedHook;
        launchedBattle = _launchedHook == address(0) ? address(0) : _wired(_launchedHook);
        openHook = _openHook;
        openBattle = _wired(_openHook);
    }

    function _wired(address h) private view returns (address b) {
        if (h.code.length == 0) revert BadHook();
        b = IPadHookView(h).battle();
        if (b == address(0) || b.code.length == 0 || IPadBattleView(b).hook() != h) revert BadHook();
    }

    /// @notice NONE, LAUNCHED or BROUGHT. A key whose hook is one of ours but that was never registered is NONE.
    function systemOf(PoolKey calldata key) public view returns (uint8) {
        address h = address(key.hooks);
        if (h == address(0) || (h != launchedHook && h != openHook)) return NONE;
        (, bool registered,,,,) = IPadHookView(h).poolState(key.toId());
        if (!registered) return NONE;
        return h == openHook ? BROUGHT : LAUNCHED;
    }

    function isPadPool(PoolKey calldata key) external view returns (bool) {
        return systemOf(key) != NONE;
    }

    /// @notice The battle contract that can run a fight between `a` and `b`, or zero if none can: both must be
    ///         registered pad pools, different, and on the SAME hook. This says nothing about mode, locks or bars;
    ///         the battle contract checks those when the offer is made and accepted.
    function battleFor(PoolKey calldata a, PoolKey calldata b) external view returns (address) {
        uint8 sa = systemOf(a);
        if (sa == NONE || sa != systemOf(b)) return address(0);
        if (PoolId.unwrap(a.toId()) == PoolId.unwrap(b.toId())) return address(0);
        return sa == BROUGHT ? openBattle : launchedBattle;
    }

    /// @notice one pool's state in the same shape whichever hook it lives on
    function state(PoolKey calldata key)
        external
        view
        returns (uint8 system, address creator, bool war, bool locked, uint128 chest, uint128 forced, uint256 volume)
    {
        system = systemOf(key);
        if (system == NONE) return (NONE, address(0), false, false, 0, 0, 0);
        IPadHookView h = IPadHookView(address(key.hooks));
        PoolId id = key.toId();
        (creator,, war, locked, chest, volume) = h.poolState(id);
        forced = h.forced(id);
    }
}
