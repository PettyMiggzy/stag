// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  STAGWIFHOOD — Revenue Splitter (configurable, default 90 / 10)
 *  Mint proceeds (and, later, secondary royalties) flow through here and split:
 *    poolBps    → reward pool  (funds staking)          — default 9000 (90%)
 *    remainder  → owner/backend wallet                  — default 1000 (10%)
 *
 *  For The Hooded 20: deploy with pool = StagStaking, owner = 0xb6a5…12516 (owner == backend),
 *  poolBps = 9000. To send 100% of mint to the owner instead, just point the NFT's payout at
 *  the owner wallet directly and skip this splitter.
 *
 *  Handles BOTH native ETH (via receive) and any ERC-20 (via distribute). Addresses + split are
 *  IMMUTABLE (set at construction) so nobody — not even the owner — can later redirect the pool's
 *  cut; changing the split means redeploy + repoint the NFT. Funds never pool here; each deposit
 *  splits and forwards on arrival.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract RevenueSplitter {
    using SafeERC20 for IERC20;

    address public immutable pool;    // reward pool (the staking contract or a wallet)
    address public immutable owner;   // owner / backend wallet (remainder)
    uint256 public immutable poolBps; // pool share in bps (10000 = 100%)

    event SplitETH(uint256 pool, uint256 owner);
    event SplitToken(address indexed token, uint256 pool, uint256 owner);

    constructor(address _pool, address _owner, uint256 _poolBps) {
        require(_pool != address(0) && _owner != address(0), "zero addr");
        require(_poolBps <= 10000, "bps > 100%");
        pool = _pool; owner = _owner; poolBps = _poolBps;
    }

    // ETH (mint-in-ETH proceeds and/or marketplace royalties) splits on arrival
    receive() external payable { _splitETH(msg.value); }
    function splitETH() external payable { _splitETH(address(this).balance); }

    function _splitETH(uint256 amount) internal {
        if (amount == 0) return;
        uint256 p = (amount * poolBps) / 10000;
        uint256 o = amount - p;                    // remainder to owner (no dust loss)
        _send(pool, p); _send(owner, o);
        emit SplitETH(p, o);
    }
    function _send(address to, uint256 v) internal {
        if (v == 0) return;
        (bool ok, ) = payable(to).call{value: v}("");
        require(ok, "eth send failed");
    }

    // ERC-20 (e.g. mint-in-$STAG proceeds): sends this contract's full token balance out by poolBps.
    // Anyone may call; funds only ever go to the two fixed addresses.
    function distribute(address token) external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        uint256 p = (bal * poolBps) / 10000;
        IERC20(token).safeTransfer(pool, p);
        // second leg pays whatever remains — safe for fee-on-transfer tokens (no revert/stuck balance)
        uint256 o = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner, o);
        emit SplitToken(token, p, o);
    }
}
