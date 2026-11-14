// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PadHook} from "./PadHook.sol";
import {PadFactory} from "./PadFactory.sol";
import {PadBattle} from "./PadBattle.sol";

/// @title PadDeployer: one-transaction deployment of the whole pad system
/// @notice Everything happens in the CONSTRUCTOR, in one transaction, so there is no window in which the hook exists
///         but is not wired, and no other account is ever the hook owner:
///           1. PadHook is CREATE2-deployed with a mined salt (its address must carry the flag bits 0x28CC, otherwise
///              BaseHook's constructor reverts and the whole deployment reverts, nothing is left half-done),
///           2. PadFactory and PadBattle are deployed,
///           3. hook.wire(factory, battle),
///           4. hook.setOwner(multisig): the first half of the two-step hand-over. The multisig must call
///              hook.acceptOwner() itself; until it does, this contract is the hook owner and owns nothing else.
///         This contract has NO functions after construction: no admin, no retarget, nothing. If the hand-over target
///         was wrong, nothing has been launched yet, so redeploy with a new salt (the readback and the acceptOwner
///         simulation catch this before any launch).
/// @dev    This must be a constructor-only deployer: the three creation codes together are ~36 KB, which fits the 48 KB
///         initcode limit but would not fit as RUNTIME code of a deployed deployer (24 KB limit).
contract PadDeployer {
    PadHook public immutable hook;
    PadFactory public immutable factory;
    PadBattle public immutable battle;
    address public immutable multisig;    // first target of the hand-over

    event Deployed(address hook, address factory, address battle, address multisig);

    error BadArg();

    constructor(IPoolManager pm, address quote, address _multisig, bool multisigMustBeContract, bytes32 salt) {
        if (address(pm).code.length == 0 || quote.code.length == 0) revert BadArg();
        if (_multisig == address(0) || _multisig == msg.sender || _multisig == address(this)) revert BadArg();
        if (multisigMustBeContract && _multisig.code.length == 0) revert BadArg();
        multisig = _multisig;

        PadHook h = new PadHook{salt: salt}(pm, address(this), quote);   // reverts unless the address carries 0x28CC
        PadFactory f = new PadFactory(pm, h, quote);
        PadBattle b = new PadBattle(h);
        h.wire(address(f), address(b));
        h.setOwner(_multisig);
        hook = h;
        factory = f;
        battle = b;
        emit Deployed(address(h), address(f), address(b), _multisig);
    }
}
