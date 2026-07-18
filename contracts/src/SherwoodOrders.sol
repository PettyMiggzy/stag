// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*  SherwoodOrders — on-chain LIMIT BUY & LIMIT SELL / TAKE-PROFIT for the $STAG Terminal.
 *
 *  A maker escrows funds and sets a `minOut` — the exact price they want. Anyone (our keeper) may
 *  call execute(); it swaps through the on-chain Uniswap V3 router with `amountOutMinimum = minOut`,
 *  so the fill happens if and only if the market price is good enough. There is NO price oracle and
 *  NO trust in the keeper: Uniswap itself enforces the limit, and a fill can never deliver the maker
 *  less than `minOut`. The keeper just retries; it can neither fill early nor short the maker.
 *
 *   • LIMIT BUY  : escrow ETH, get >= minOut tokens (fills once the price drops enough)
 *   • LIMIT SELL / TAKE-PROFIT : escrow token, get >= minOut ETH (fills once the price rises enough)
 *
 *  Escrow is fully accounted (escrowedEth + escrowedToken) so the owner's rescue() can only ever
 *  touch untracked surplus — never a maker's funds. 1% fee -> marketing wallet (owner-tunable, 3% cap).
 *
 *  NOTE: stop-loss (sell when price FALLS to a level) needs a manipulation-resistant price oracle
 *  (TWAP) and is intentionally NOT in this version — a naive spot-price stop-loss is an MEV
 *  liquidation vector on thin pools. It ships separately once TWAP support is in place.
 *
 *  ⚠️ Holds user funds in escrow. Independently audited + tested.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut);
}
interface IWETH9 is IERC20 { function withdraw(uint256) external; }

contract SherwoodOrders is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable router;
    IWETH9        public immutable weth;

    uint256 public constant MAX_FEE_BPS = 300;
    uint256 public feeBps = 100;                 // 1%
    address payable public feeWallet;

    struct Order {
        address maker;
        address token;      // the non-WETH token
        bool    isBuy;      // true: ETH->token (escrow ETH); false: token->ETH (escrow token)
        bool    active;
        uint24  poolFee;    // Uniswap V3 fee tier to route through
        uint256 amountIn;   // escrowed (ETH wei if buy, token amount if sell)
        uint256 minOut;     // the maker's limit price, as a hard minimum output
    }

    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId;

    // full escrow accounting — rescue() can only touch balances ABOVE these
    uint256 public escrowedEth;
    mapping(address => uint256) public escrowedToken;

    event OrderCreated(uint256 indexed id, address indexed maker, address token, bool isBuy, uint256 amountIn, uint256 minOut);
    event OrderExecuted(uint256 indexed id, address indexed keeper, uint256 amountOut, uint256 fee);
    event OrderCancelled(uint256 indexed id);
    event FeeChanged(uint256 feeBps);
    event FeeWalletChanged(address feeWallet);

    constructor(address router_, address weth_, address payable feeWallet_) Ownable(msg.sender) {
        require(router_ != address(0) && weth_ != address(0) && feeWallet_ != address(0), "zero");
        router = ISwapRouter02(router_); weth = IWETH9(weth_); feeWallet = feeWallet_;
    }

    /* ---------------- create ---------------- */

    /// @notice LIMIT/dip BUY: escrow ETH now; fills to >= `minOut` tokens once the price drops enough.
    function createBuyOrder(address token, uint24 poolFee, uint256 minOut)
        external payable nonReentrant returns (uint256 id)
    {
        require(msg.value > 0, "no eth");
        require(token != address(0) && token != address(weth), "bad token");
        require(minOut > 0, "bad minOut");
        id = nextOrderId++;
        orders[id] = Order(msg.sender, token, true, true, poolFee, msg.value, minOut);
        escrowedEth += msg.value;
        emit OrderCreated(id, msg.sender, token, true, msg.value, minOut);
    }

    /// @notice LIMIT SELL / TAKE-PROFIT: escrow `amountIn` token now; fills to >= `minOut` ETH once the price rises enough.
    function createSellOrder(address token, uint24 poolFee, uint256 amountIn, uint256 minOut)
        external nonReentrant returns (uint256 id)
    {
        require(amountIn > 0, "no amount");
        require(token != address(0) && token != address(weth), "bad token");
        require(minOut > 0, "bad minOut");
        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 recv = t.balanceOf(address(this)) - before;   // fee-on-transfer safe
        require(recv > 0, "nothing in");
        id = nextOrderId++;
        orders[id] = Order(msg.sender, token, false, true, poolFee, recv, minOut);
        escrowedToken[token] += recv;
        emit OrderCreated(id, msg.sender, token, false, recv, minOut);
    }

    /* ---------------- execute (permissionless keeper) ---------------- */

    /// @notice Fill order `id`. The swap enforces `minOut`, so it succeeds only at the maker's price
    ///         or better — anyone may call, and no caller can fill early or below the maker's floor.
    function execute(uint256 id) external nonReentrant returns (uint256 amountOut) {
        Order memory o = orders[id];
        require(o.active, "not open");
        orders[id].active = false;   // effects before interactions

        uint256 fee;
        if (o.isBuy) {
            escrowedEth -= o.amountIn;
            fee = (o.amountIn * feeBps) / 10_000;
            uint256 amountIn = o.amountIn - fee;
            if (fee > 0) { (bool okF, ) = feeWallet.call{value: fee}(""); require(okF, "fee xfer"); }
            amountOut = router.exactInputSingle{value: amountIn}(ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(weth), tokenOut: o.token, fee: o.poolFee, recipient: o.maker,
                amountIn: amountIn, amountOutMinimum: o.minOut, sqrtPriceLimitX96: 0
            }));
        } else {
            escrowedToken[o.token] -= o.amountIn;
            IERC20(o.token).forceApprove(address(router), o.amountIn);
            uint256 wethOut = router.exactInputSingle(ISwapRouter02.ExactInputSingleParams({
                tokenIn: o.token, tokenOut: address(weth), fee: o.poolFee, recipient: address(this),
                amountIn: o.amountIn, amountOutMinimum: o.minOut, sqrtPriceLimitX96: 0
            }));
            IERC20(o.token).forceApprove(address(router), 0);
            weth.withdraw(wethOut);
            fee = (wethOut * feeBps) / 10_000;
            amountOut = wethOut - fee;
            require(amountOut >= o.minOut, "slippage");   // maker's floor is net-of-fee
            if (fee > 0) { (bool okF, ) = feeWallet.call{value: fee}(""); require(okF, "fee xfer"); }
            (bool ok, ) = payable(o.maker).call{value: amountOut}("");
            require(ok, "eth xfer");
        }
        emit OrderExecuted(id, msg.sender, amountOut, fee);
    }

    /* ---------------- cancel ---------------- */

    /// @notice Maker cancels an open order and gets the full escrow back.
    function cancelOrder(uint256 id) external nonReentrant {
        Order memory o = orders[id];
        require(o.active, "not open");
        require(msg.sender == o.maker, "not maker");
        orders[id].active = false;
        if (o.isBuy) { escrowedEth -= o.amountIn; (bool ok, ) = payable(o.maker).call{value: o.amountIn}(""); require(ok, "refund"); }
        else { escrowedToken[o.token] -= o.amountIn; IERC20(o.token).safeTransfer(o.maker, o.amountIn); }
        emit OrderCancelled(id);
    }

    /* ---------------- views ---------------- */

    function getOrder(uint256 id) external view returns (Order memory) { return orders[id]; }
    function openOrders(uint256 start, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 n;
        for (uint256 i = start; i < nextOrderId && n < limit; i++) if (orders[i].active) n++;
        ids = new uint256[](n); uint256 j;
        for (uint256 i = start; i < nextOrderId && j < n; i++) if (orders[i].active) ids[j++] = i;
    }

    receive() external payable {}   // ETH from weth.withdraw()

    /* ---------------- admin (policy only) ---------------- */

    function setFee(uint256 bps) external onlyOwner { require(bps <= MAX_FEE_BPS, "fee too high"); feeBps = bps; emit FeeChanged(bps); }
    function setFeeWallet(address payable w) external onlyOwner { require(w != address(0), "zero"); feeWallet = w; emit FeeWalletChanged(w); }

    /// @notice Recover ONLY untracked surplus (donations / dust). Live escrow (escrowedEth /
    ///         escrowedToken) is subtracted first, so this can never touch a maker's funds.
    function rescueSurplus(address token, address payable to) external onlyOwner {
        require(to != address(0), "zero");
        if (token == address(0)) {
            uint256 surplus = address(this).balance - escrowedEth;
            require(surplus > 0, "no surplus");
            (bool ok, ) = to.call{value: surplus}(""); require(ok, "e");
        } else {
            uint256 surplus = IERC20(token).balanceOf(address(this)) - escrowedToken[token];
            require(surplus > 0, "no surplus");
            IERC20(token).safeTransfer(to, surplus);
        }
    }
}
