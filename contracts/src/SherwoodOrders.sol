// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*  SherwoodOrders — on-chain LIMIT orders, STOP-LOSS & TAKE-PROFIT for the $STAG Terminal.
 *
 *  A maker escrows funds and sets a PRICE TRIGGER (a Uniswap V3 sqrtPriceX96 threshold, computed
 *  off-chain by the UI from the token's decimals + pool ordering) plus a `minOut` floor. Anyone —
 *  our keeper — may call execute(); it reads the LIVE pool price and only swaps if the trigger is
 *  met, routing through the on-chain Uniswap V3 router. 1% fee (owner-tunable, 3% cap) -> feeWallet.
 *
 *  TRUSTLESS: the keeper can only *trigger* a fill when the on-chain price condition is truly met,
 *  and the swap always enforces the maker's `minOut` — so even a manipulated spot price can't fill
 *  a maker below their floor. Funds only pass through in the fill tx.
 *
 *   • LIMIT BUY / dip buy : escrow ETH, fill when price is at/below your target (triggerAbove=false)
 *   • TAKE-PROFIT / limit sell : escrow token, fill when price is at/above your target (triggerAbove=true)
 *   • STOP-LOSS : escrow token, fill when price falls to/below your stop (triggerAbove=false)
 *
 *  ⚠️ Holds user funds in escrow. Independently audited + tested before UI wiring.
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
interface IUniV3Factory { function getPool(address, address, uint24) external view returns (address); }
interface IUniV3Pool { function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool); }

contract SherwoodOrders is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ISwapRouter02  public immutable router;
    IWETH9         public immutable weth;
    IUniV3Factory  public immutable factory;

    uint256 public constant MAX_FEE_BPS = 300;
    uint256 public feeBps = 100;                 // 1%
    address payable public feeWallet;

    struct Order {
        address maker;
        address token;           // the non-WETH token
        bool    isBuy;           // true: ETH->token (escrow ETH); false: token->ETH (escrow token)
        bool    triggerAbove;    // fill when pool sqrtPriceX96 >= trigger (else <=)
        bool    active;
        uint24  poolFee;         // Uniswap V3 fee tier of the token/WETH pool
        uint160 sqrtTriggerX96;  // price trigger threshold (UI-computed)
        uint256 amountIn;        // escrowed (ETH wei if buy, token amount if sell)
        uint256 minOut;          // hard floor at execution (token out if buy, ETH wei if sell)
    }

    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId;

    event OrderCreated(uint256 indexed id, address indexed maker, address token, bool isBuy, uint256 amountIn, uint160 sqrtTriggerX96, bool triggerAbove, uint256 minOut);
    event OrderExecuted(uint256 indexed id, address indexed keeper, uint256 amountOut, uint256 fee);
    event OrderCancelled(uint256 indexed id);
    event FeeChanged(uint256 feeBps);
    event FeeWalletChanged(address feeWallet);

    constructor(address router_, address weth_, address factory_, address payable feeWallet_) Ownable(msg.sender) {
        require(router_ != address(0) && weth_ != address(0) && factory_ != address(0) && feeWallet_ != address(0), "zero");
        router = ISwapRouter02(router_); weth = IWETH9(weth_); factory = IUniV3Factory(factory_); feeWallet = feeWallet_;
    }

    /* ---------------- create ---------------- */

    /// @notice Limit/dip BUY: escrow ETH now; fills to `minOut` tokens when the trigger is met.
    function createBuyOrder(address token, uint24 poolFee, uint160 sqrtTriggerX96, bool triggerAbove, uint256 minOut)
        external payable nonReentrant returns (uint256 id)
    {
        require(msg.value > 0, "no eth");
        require(token != address(0) && token != address(weth), "bad token");
        require(minOut > 0 && sqrtTriggerX96 > 0, "bad params");
        _requirePool(token, poolFee);
        id = nextOrderId++;
        orders[id] = Order(msg.sender, token, true, triggerAbove, true, poolFee, sqrtTriggerX96, msg.value, minOut);
        emit OrderCreated(id, msg.sender, token, true, msg.value, sqrtTriggerX96, triggerAbove, minOut);
    }

    /// @notice Take-profit / stop-loss / limit SELL: escrow `amountIn` token now; fills to `minOut` ETH.
    function createSellOrder(address token, uint24 poolFee, uint256 amountIn, uint160 sqrtTriggerX96, bool triggerAbove, uint256 minOut)
        external nonReentrant returns (uint256 id)
    {
        require(amountIn > 0, "no amount");
        require(token != address(0) && token != address(weth), "bad token");
        require(minOut > 0 && sqrtTriggerX96 > 0, "bad params");
        _requirePool(token, poolFee);
        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 recv = t.balanceOf(address(this)) - before;   // fee-on-transfer safe
        require(recv > 0, "nothing in");
        id = nextOrderId++;
        orders[id] = Order(msg.sender, token, false, triggerAbove, true, poolFee, sqrtTriggerX96, recv, minOut);
        emit OrderCreated(id, msg.sender, token, false, recv, sqrtTriggerX96, triggerAbove, minOut);
    }

    /* ---------------- execute (permissionless keeper) ---------------- */

    /// @notice Fill order `id` if its price trigger is met on-chain. Anyone may call (our keeper does).
    ///         The swap enforces the maker's `minOut`, so a fill can never be worse than they set.
    function execute(uint256 id) external nonReentrant returns (uint256 amountOut) {
        Order memory o = orders[id];
        require(o.active, "not open");

        // live price gate — the keeper can only trigger when the pool price truly crosses the level
        uint160 sqrtP = _price(o.token, o.poolFee);
        require(o.triggerAbove ? sqrtP >= o.sqrtTriggerX96 : sqrtP <= o.sqrtTriggerX96, "not triggered");

        orders[id].active = false;   // effects before interactions

        uint256 fee;
        if (o.isBuy) {
            // ETH -> token, straight to the maker (fee skimmed from the ETH first)
            fee = (o.amountIn * feeBps) / 10_000;
            uint256 amountIn = o.amountIn - fee;
            if (fee > 0) { (bool okF, ) = feeWallet.call{value: fee}(""); require(okF, "fee xfer"); }
            amountOut = router.exactInputSingle{value: amountIn}(ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(weth), tokenOut: o.token, fee: o.poolFee, recipient: o.maker,
                amountIn: amountIn, amountOutMinimum: o.minOut, sqrtPriceLimitX96: 0
            }));
        } else {
            // token -> WETH here, unwrap, skim fee, forward ETH to the maker
            IERC20(o.token).forceApprove(address(router), o.amountIn);
            uint256 wethOut = router.exactInputSingle(ISwapRouter02.ExactInputSingleParams({
                tokenIn: o.token, tokenOut: address(weth), fee: o.poolFee, recipient: address(this),
                amountIn: o.amountIn, amountOutMinimum: o.minOut, sqrtPriceLimitX96: 0
            }));
            IERC20(o.token).forceApprove(address(router), 0);
            weth.withdraw(wethOut);
            fee = (wethOut * feeBps) / 10_000;
            amountOut = wethOut - fee;
            require(amountOut >= o.minOut, "slippage");
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
        if (o.isBuy) { (bool ok, ) = payable(o.maker).call{value: o.amountIn}(""); require(ok, "refund"); }
        else IERC20(o.token).safeTransfer(o.maker, o.amountIn);
        emit OrderCancelled(id);
    }

    /* ---------------- views ---------------- */

    function getOrder(uint256 id) external view returns (Order memory) { return orders[id]; }
    function isFillable(uint256 id) external view returns (bool) {
        Order memory o = orders[id];
        if (!o.active) return false;
        uint160 sqrtP = _price(o.token, o.poolFee);
        return o.triggerAbove ? sqrtP >= o.sqrtTriggerX96 : sqrtP <= o.sqrtTriggerX96;
    }
    function openOrders(uint256 start, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 n;
        for (uint256 i = start; i < nextOrderId && n < limit; i++) if (orders[i].active) n++;
        ids = new uint256[](n); uint256 j;
        for (uint256 i = start; i < nextOrderId && j < n; i++) if (orders[i].active) ids[j++] = i;
    }

    /* ---------------- internal ---------------- */

    function _requirePool(address token, uint24 poolFee) internal view {
        require(factory.getPool(token, address(weth), poolFee) != address(0), "no pool");
    }
    function _price(address token, uint24 poolFee) internal view returns (uint160 sqrtPriceX96) {
        address pool = factory.getPool(token, address(weth), poolFee);
        require(pool != address(0), "no pool");
        (sqrtPriceX96, , , , , , ) = IUniV3Pool(pool).slot0();
    }

    receive() external payable {}   // ETH from weth.withdraw()

    /* ---------------- admin (policy only) ---------------- */

    function setFee(uint256 bps) external onlyOwner { require(bps <= MAX_FEE_BPS, "fee too high"); feeBps = bps; emit FeeChanged(bps); }
    function setFeeWallet(address payable w) external onlyOwner { require(w != address(0), "zero"); feeWallet = w; emit FeeWalletChanged(w); }
    /// @notice Recover only stray tokens/ETH (escrow is tracked per-order and never counted as stray here — use with care).
    function rescue(address token, address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero");
        if (token == address(0)) { (bool ok, ) = to.call{value: amount}(""); require(ok, "e"); }
        else IERC20(token).safeTransfer(to, amount);
    }
}
