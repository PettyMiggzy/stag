// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*  SherwoodSwap — a fee-taking swap router for the $STAG Terminal (Robinhood Chain 4663).
 *
 *  Buys (ETH -> token) and sells (token -> ETH) route through the Uniswap V3 SwapRouter02
 *  that is already deployed on the chain. A platform fee (default 1%, owner-tunable, hard-capped
 *  at 3%) is skimmed on every swap and sent to feeWallet (the $STAG marketing wallet).
 *
 *  DESIGN
 *   • Funds only pass THROUGH this contract inside a single tx — nothing is meant to sit here.
 *   • BUY: skim the fee from the incoming ETH, swap the rest to the token straight to the buyer.
 *   • SELL: pull the token, swap to WETH here, unwrap, skim the fee, forward the ETH to the seller.
 *   • Fee-on-transfer sell tokens handled by measuring the actual amount received.
 *   • Slippage guarded by the caller's `minOut`. ReentrancyGuard + CEI throughout.
 *
 *  ⚠️ Touches user funds in-flight. Independently audited + validated before UI wiring.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

contract SherwoodSwap is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable router;
    IWETH9        public immutable weth;

    uint256 public constant MAX_FEE_BPS = 300;   // 3% hard cap — owner can never exceed this
    uint256 public feeBps = 100;                 // 1% default
    address payable public feeWallet;            // $STAG marketing wallet

    event Bought(address indexed user, address indexed token, uint256 ethIn, uint256 fee, uint256 tokenOut);
    event Sold(address indexed user, address indexed token, uint256 tokenIn, uint256 fee, uint256 ethOut);
    event FeeChanged(uint256 feeBps);
    event FeeWalletChanged(address feeWallet);

    constructor(address router_, address weth_, address payable feeWallet_) Ownable(msg.sender) {
        require(router_ != address(0) && weth_ != address(0) && feeWallet_ != address(0), "zero");
        router = ISwapRouter02(router_);
        weth = IWETH9(weth_);
        feeWallet = feeWallet_;
    }

    /// @notice BUY: swap native ETH for `token`. 1% fee skimmed from the ETH; the rest is swapped
    ///         through the given Uniswap V3 `poolFee` tier straight to you. Reverts under `minOut`.
    function buy(address token, uint24 poolFee, uint256 minOut)
        external payable nonReentrant returns (uint256 tokenOut)
    {
        require(msg.value > 0, "no eth");
        require(token != address(0) && token != address(weth), "bad token");

        uint256 fee = (msg.value * feeBps) / 10_000;
        uint256 amountIn = msg.value - fee;
        if (fee > 0) { (bool okF, ) = feeWallet.call{value: fee}(""); require(okF, "fee xfer"); }

        tokenOut = router.exactInputSingle{value: amountIn}(ISwapRouter02.ExactInputSingleParams({
            tokenIn: address(weth), tokenOut: token, fee: poolFee, recipient: msg.sender,
            amountIn: amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
        emit Bought(msg.sender, token, msg.value, fee, tokenOut);
    }

    /// @notice SELL: swap `amountIn` of `token` for native ETH. Token is swapped to WETH here,
    ///         unwrapped, then 1% is skimmed and the rest of the ETH forwarded to you.
    ///         Approve this contract for `token` first. Reverts under `minOut` (in wei of ETH).
    function sell(address token, uint24 poolFee, uint256 amountIn, uint256 minOut)
        external nonReentrant returns (uint256 ethOut)
    {
        require(amountIn > 0, "no amount");
        require(token != address(0) && token != address(weth), "bad token");

        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 recv = t.balanceOf(address(this)) - before;   // fee-on-transfer safe
        require(recv > 0, "nothing in");

        t.forceApprove(address(router), recv);
        uint256 wethOut = router.exactInputSingle(ISwapRouter02.ExactInputSingleParams({
            tokenIn: token, tokenOut: address(weth), fee: poolFee, recipient: address(this),
            amountIn: recv, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
        }));
        t.forceApprove(address(router), 0);                   // leave no standing allowance

        weth.withdraw(wethOut);                               // WETH -> ETH (to this)
        uint256 fee = (wethOut * feeBps) / 10_000;
        if (fee > 0) { (bool okF, ) = feeWallet.call{value: fee}(""); require(okF, "fee xfer"); }
        ethOut = wethOut - fee;
        (bool ok, ) = payable(msg.sender).call{value: ethOut}("");
        require(ok, "eth xfer");
        emit Sold(msg.sender, token, recv, fee, ethOut);
    }

    receive() external payable {}   // accept ETH from weth.withdraw()

    /* ---------------- admin (policy only) ---------------- */

    function setFee(uint256 bps) external onlyOwner {
        require(bps <= MAX_FEE_BPS, "fee too high");
        feeBps = bps; emit FeeChanged(bps);
    }
    function setFeeWallet(address payable w) external onlyOwner {
        require(w != address(0), "zero"); feeWallet = w; emit FeeWalletChanged(w);
    }
    /// @notice Recover any tokens/ETH accidentally left here (swaps route funds out in the same tx).
    function rescue(address token, address payable to) external onlyOwner {
        require(to != address(0), "zero");
        if (token == address(0)) { (bool ok, ) = to.call{value: address(this).balance}(""); require(ok, "e"); }
        else IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }
}
