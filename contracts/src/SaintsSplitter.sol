// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*  Sherwood Saints — Revenue Splitter (immutable 3-way)
 *  Mint proceeds (and, later, secondary royalties) flow through here and split three ways on arrival:
 *    burnBps → buy-and-burn wallet (buys $STAG on the market and burns it → deflationary)
 *    poolBps → staking reward pool (feeds holder ETH yield)
 *    remainder → team wallet
 *
 *  Default for Sherwood Saints: 60% burn / 30% pool / 10% team (burnBps=6000, poolBps=3000).
 *  A dedicated buy-burn wallet is used instead of an on-chain per-mint swap because the whole drop
 *  is only 5 × 0.03 = 0.15 ETH — one consolidated market buy beats tiny MEV-exposed micro-swaps,
 *  and every buy+burn is publicly verifiable on-chain.
 *
 *  Addresses + split are IMMUTABLE (set at construction) so nobody — not even the deployer — can
 *  later redirect a cut; changing the split means redeploy + repoint the NFT. Funds never pool here;
 *  each deposit splits and forwards on arrival. Handles native ETH (receive) and any ERC-20.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract SaintsSplitter {
    using SafeERC20 for IERC20;

    address public immutable burnSink; // buy-and-burn wallet
    address public immutable pool;     // staking reward pool
    address public immutable team;     // team wallet (remainder)
    uint256 public immutable burnBps;  // burn share in bps (10000 = 100%)
    uint256 public immutable poolBps;  // pool share in bps

    event SplitETH(uint256 burn, uint256 pool, uint256 team);
    event SplitToken(address indexed token, uint256 burn, uint256 pool, uint256 team);

    constructor(address _burnSink, address _pool, address _team, uint256 _burnBps, uint256 _poolBps) {
        require(_burnSink != address(0) && _pool != address(0) && _team != address(0), "zero addr");
        require(_burnBps + _poolBps <= 10000, "bps > 100%");
        burnSink = _burnSink; pool = _pool; team = _team;
        burnBps = _burnBps; poolBps = _poolBps;
    }

    // ETH (mint proceeds and/or marketplace royalties) splits on arrival.
    receive() external payable { _splitETH(msg.value); }
    function splitETH() external payable { _splitETH(address(this).balance); }

    function _splitETH(uint256 amount) internal {
        if (amount == 0) return;
        uint256 b = (amount * burnBps) / 10000;
        uint256 p = (amount * poolBps) / 10000;
        uint256 t = amount - b - p;           // remainder to team (no dust loss)
        _send(burnSink, b); _send(pool, p); _send(team, t);
        emit SplitETH(b, p, t);
    }

    function _send(address to, uint256 v) internal {
        if (v == 0) return;
        (bool ok, ) = payable(to).call{value: v}("");
        require(ok, "eth send failed");
    }

    // ERC-20 (e.g. royalties paid in a token): sends this contract's full token balance out by bps.
    // Anyone may call; funds only ever go to the three fixed addresses.
    function distribute(address token) external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        uint256 b = (bal * burnBps) / 10000;
        uint256 p = (bal * poolBps) / 10000;
        IERC20(token).safeTransfer(burnSink, b);
        IERC20(token).safeTransfer(pool, p);
        // last leg pays whatever remains — safe for fee-on-transfer tokens (no revert/stuck balance)
        uint256 t = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(team, t);
        emit SplitToken(token, b, p, t);
    }
}
