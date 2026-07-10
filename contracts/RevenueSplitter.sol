// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD — Revenue Splitter (60 / 40)
 *  Mint proceeds (and, later, secondary royalties) flow through here and split:
 *    60% → reward pool  (funds staking)
 *    40% → owner wallet  (0xece5…63aa — owner + dev are the same wallet)
 *
 *  Handles BOTH native ETH (via receive) and any ERC-20 (via distribute), so it
 *  works whether the mint is priced in ETH or $STAG. Addresses + split fixed at
 *  construction (change = redeploy + repoint the NFT). Funds never pool here —
 *  each deposit splits and forwards on arrival.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract RevenueSplitter {
    using SafeERC20 for IERC20;

    address public immutable pool;    // reward pool (the staking contract or a wallet) — 60%
    address public immutable owner;   // owner wallet — 40%

    uint256 public constant POOL_BPS  = 6000;   // 60%
    uint256 public constant OWNER_BPS = 4000;   // 40%

    event SplitETH(uint256 pool, uint256 owner);
    event SplitToken(address indexed token, uint256 pool, uint256 owner);

    constructor(address _pool, address _owner) {
        require(_pool != address(0) && _owner != address(0), "zero addr");
        pool = _pool; owner = _owner;
    }

    // ETH (mint-in-ETH proceeds and/or marketplace royalties) splits on arrival
    receive() external payable { _splitETH(msg.value); }
    function splitETH() external payable { _splitETH(address(this).balance); }

    function _splitETH(uint256 amount) internal {
        if (amount == 0) return;
        uint256 p = (amount * POOL_BPS) / 10000;
        uint256 o = amount - p;                    // remainder to owner (no dust loss)
        _send(pool, p); _send(owner, o);
        emit SplitETH(p, o);
    }
    function _send(address to, uint256 v) internal {
        if (v == 0) return;
        (bool ok, ) = payable(to).call{value: v}("");
        require(ok, "eth send failed");
    }

    // ERC-20 (mint-in-$STAG proceeds): sends this contract's full token balance out 60/40.
    // Anyone may call; funds only ever go to the two fixed addresses.
    function distribute(address token) external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        uint256 p = (bal * POOL_BPS) / 10000;
        uint256 o = bal - p;
        IERC20(token).safeTransfer(pool, p);
        IERC20(token).safeTransfer(owner, o);
        emit SplitToken(token, p, o);
    }
}
