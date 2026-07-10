// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD — Revenue Splitter (30 / 10 / 60)
 *  Mint proceeds (and, later, secondary royalties) flow through here and split:
 *    30% → reward pool  (funds staking)
 *    10% → owner wallet
 *    60% → dev wallet
 *
 *  Handles BOTH native ETH (via receive) and any ERC-20 (via distribute),
 *  so it works whether the mint is priced in ETH or in $STAG, and whether
 *  ERC-2981 royalties arrive in ETH.
 *
 *  Addresses + split are set at construction. Immutable once deployed for
 *  trust (change = redeploy + repoint the NFT). All splits are pull-free /
 *  push on arrival — no funds pool here.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract RevenueSplitter {
    using SafeERC20 for IERC20;

    address public immutable pool;    // reward pool (the staking contract or a wallet) — 30%
    address public immutable owner;   // owner wallet — 10%
    address public immutable dev;     // dev wallet — 60%

    uint256 public constant POOL_BPS  = 3000;
    uint256 public constant OWNER_BPS = 1000;
    uint256 public constant DEV_BPS   = 6000;

    event SplitETH(uint256 pool, uint256 owner, uint256 dev);
    event SplitToken(address indexed token, uint256 pool, uint256 owner, uint256 dev);

    constructor(address _pool, address _owner, address _dev) {
        require(_pool != address(0) && _owner != address(0) && _dev != address(0), "zero addr");
        pool = _pool; owner = _owner; dev = _dev;
    }

    // ETH (mint-in-ETH proceeds and/or marketplace royalties) splits on arrival
    receive() external payable { _splitETH(msg.value); }
    function splitETH() external payable { _splitETH(address(this).balance); }

    function _splitETH(uint256 amount) internal {
        if (amount == 0) return;
        uint256 p = (amount * POOL_BPS) / 10000;
        uint256 o = (amount * OWNER_BPS) / 10000;
        uint256 d = amount - p - o;               // remainder to dev (avoids dust loss)
        _send(pool, p); _send(owner, o); _send(dev, d);
        emit SplitETH(p, o, d);
    }
    function _send(address to, uint256 v) internal {
        if (v == 0) return;
        (bool ok, ) = payable(to).call{value: v}("");
        require(ok, "eth send failed");
    }

    // ERC-20 (mint-in-$STAG proceeds): sends this contract's full token balance out 30/10/60.
    // Anyone may call; funds only ever go to the three fixed addresses.
    function distribute(address token) external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        uint256 p = (bal * POOL_BPS) / 10000;
        uint256 o = (bal * OWNER_BPS) / 10000;
        uint256 d = bal - p - o;
        IERC20(token).safeTransfer(pool, p);
        IERC20(token).safeTransfer(owner, o);
        IERC20(token).safeTransfer(dev, d);
        emit SplitToken(token, p, o, d);
    }
}
