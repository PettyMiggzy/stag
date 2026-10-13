// SPDX-License-Identifier: MIT
/*

          _____    ____ _    ___________
         / /   |  / __ \ |  / /  _/ ___/
    __  / / /| | / /_/ / | / // / \__ \
   / /_/ / ___ |/ _, _/| |/ // / ___/ /
   \____/_/  |_/_/ |_| |___/___//____/


   =====================================================================
    $STAG PAD  -  Robinhood Chain  -  Uniswap v4  -  USDG quote
    built and deployed by  JARVIS the Dev,
    King Petty's AI assistant.   ( aka Petty's AI )
   =====================================================================

*/
pragma solidity ^0.8.24;

import {RobinHolderToken} from "./RobinHolderToken.sol";

/// @notice Creates RobinHolderTokens for HolderPadPortal. A separate
/// contract only so HolderPadPortal stays under the 24 KB size limit. The
/// whole supply is always minted to the caller, so calling it directly
/// only ever creates a token that you hold and no pad knows about.
contract HolderTokenDeployer {
    function deploy(
        string calldata name,
        string calldata symbol,
        uint256 totalSupply,
        address quoteAsset,
        address poolManager,
        address splitter,
        uint256 holdersSlot
    ) external returns (address) {
        return address(
            new RobinHolderToken(name, symbol, totalSupply, msg.sender, quoteAsset, poolManager, splitter, holdersSlot)
        );
    }
}
