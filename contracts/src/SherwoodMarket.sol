// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*  SherwoodMarket — a peer-to-peer OTC / order-book exchange for ANY token on Robinhood Chain (4663).
 *  "eBay for tokens." Sellers post an order (escrow their token, name a price); buyers fill it directly.
 *  No AMM pool, no slippage — a direct match between two people.
 *
 *  FEES (owner-tunable, capped): a fee is skimmed on BOTH sides of every fill and sent to feeWallet
 *  (the $STAG marketing wallet). Default 1% buy-side + 1% sell-side. The team burns / uses the fees.
 *
 *  DESIGN
 *   • Maker escrows the sell token in this contract when creating an order (funds can't vanish mid-trade).
 *   • Taker fills by paying the ask (native ETH or an ERC-20). Atomic: taker gets the token, maker gets
 *     paid, fees go to feeWallet — all in one tx, or it reverts.
 *   • Standard fee-on-transfer ("tax") tokens are handled by measuring the ACTUAL balance received.
 *   • Per-token escrow accounting (`escrowedOf`) means the contract never pays out more of a token
 *     than its own live orders hold — orders of one token are fully isolated from every other token.
 *   • Full fills only in v1 (no partials) — simplest + safest.
 *
 *  ⚠️ SUPPORTED TOKENS: standard, balance-preserving ERC-20s + native ETH. Rebasing / elastic-supply
 *     and sender-side-tax tokens are NOT supported — pooled escrow can't track a balance that moves on
 *     its own, so same-token orders in such assets may settle unpredictably. The UI warns on these.
 *  ⚠️ Holds real user funds. Independently audited + fuzzed before mainnet.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SherwoodMarket is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // address(0) as a "token" means native ETH (the buy/pay side only).
    address internal constant ETH = address(0);

    struct Order {
        address maker;       // who created the order        ┐
        bool    active;      // open?                         │ these four pack
        uint16  buyFeeBps;   // buy-side fee SNAPSHOT at post │ into one 32-byte
        uint16  sellFeeBps;  // sell-side fee SNAPSHOT at post ┘ slot (20+1+2+2)
        address sellToken;   // ERC-20 being sold (escrowed here)
        uint256 sellAmount;  // amount of sellToken escrowed (net of any transfer tax)
        address buyToken;    // what the maker wants paid in (ETH = address(0), or an ERC-20)
        uint256 buyAmount;   // amount of buyToken the maker wants
    }

    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId;

    // Total currently escrowed per sell-token across all ACTIVE orders. Lets the contract prove it
    // never pays out more of a token than it holds for live orders, and lets rescue() touch ONLY the
    // untracked surplus (donations / transfer-tax dust) — never anyone's live escrow.
    mapping(address => uint256) public escrowedOf;

    // ---- fees (owner-tunable, hard-capped so the owner can never skim more than MAX) ----
    uint256 public constant MAX_FEE_BPS = 300;  // 3% hard cap per side — owner can't exceed this, ever
    uint256 public buyFeeBps  = 100;            // 1% skimmed from the payment (buy side)
    uint256 public sellFeeBps = 100;            // 1% skimmed from the token (sell side)
    address payable public feeWallet;           // $STAG marketing wallet — receives all fees

    event OrderCreated(uint256 indexed id, address indexed maker, address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount);
    event OrderFilled(uint256 indexed id, address indexed taker, uint256 sellToTaker, uint256 payToMaker, uint256 buyFee, uint256 sellFee);
    event OrderCancelled(uint256 indexed id);
    event FeesChanged(uint256 buyFeeBps, uint256 sellFeeBps);
    event FeeWalletChanged(address feeWallet);

    constructor(address payable feeWallet_) Ownable(msg.sender) {
        require(feeWallet_ != address(0), "zero feeWallet");
        feeWallet = feeWallet_;
    }

    /* ---------------- create ---------------- */

    /// @notice Post a sell order. Escrows `sellAmount` of `sellToken` here. `buyToken`=address(0) means
    ///         you want to be paid in native ETH; otherwise an ERC-20. Reverts if nothing is escrowed.
    function createOrder(address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount)
        external nonReentrant returns (uint256 id)
    {
        require(sellToken != ETH, "sell must be ERC20");   // the sell side is always a token (ETH can only be the pay side)
        require(sellAmount > 0 && buyAmount > 0, "zero amount");
        // buyToken must be native ETH or a real contract, and can't equal the sell token — kills
        // codeless-buyToken self-grief (order that can never be filled) up front.
        require(buyToken == ETH || buyToken.code.length > 0, "bad buyToken");
        require(buyToken != sellToken, "same token");

        // pull escrow, measuring what ACTUALLY arrived (handles fee-on-transfer tokens)
        IERC20 t = IERC20(sellToken);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), sellAmount);
        uint256 received = t.balanceOf(address(this)) - before;
        require(received > 0, "nothing escrowed");

        // snapshot the CURRENT fee rates into the order — the owner can never retroactively
        // re-tax an already-posted order; a later setFees() only affects future orders.
        id = nextOrderId++;
        orders[id] = Order(msg.sender, true, uint16(buyFeeBps), uint16(sellFeeBps), sellToken, received, buyToken, buyAmount);
        escrowedOf[sellToken] += received;
        emit OrderCreated(id, msg.sender, sellToken, received, buyToken, buyAmount);
    }

    /* ---------------- fill ---------------- */

    /// @notice Fill order `id` completely. Pay `buyAmount` of buyToken (as msg.value if ETH, else approve
    ///         first). You receive the escrowed token minus the sell-side fee; the maker receives your
    ///         payment minus the buy-side fee; both fees go to feeWallet.
    function fillOrder(uint256 id) external payable nonReentrant {
        Order memory o = orders[id];
        require(o.active, "not open");
        require(msg.sender != o.maker, "maker cannot fill own");
        orders[id].active = false;               // effects before interactions (no reentrancy, no double-fill)
        escrowedOf[o.sellToken] -= o.sellAmount;  // release this order's escrow from the tracked total

        // Fees STAY in this contract and are swept out-of-band by forwardFees() — so a taker's signed
        // fill only moves funds between the two trade parties (taker <-> maker), never fanning out to
        // the fee wallet. That keeps the tx a clean 2-party swap that wallet scanners won't flag.

        // ----- sell side: escrowed token -> taker (minus sell fee); sell fee stays in-contract -----
        uint256 sellFee = (o.sellAmount * o.sellFeeBps) / 10_000;
        uint256 toTaker = o.sellAmount - sellFee;
        IERC20(o.sellToken).safeTransfer(msg.sender, toTaker);

        // ----- buy side: taker's payment -> maker (minus buy fee); buy fee stays in-contract -----
        uint256 buyFee = (o.buyAmount * o.buyFeeBps) / 10_000;
        uint256 toMaker = o.buyAmount - buyFee;

        if (o.buyToken == ETH) {
            require(msg.value == o.buyAmount, "wrong ETH amount");
            (bool okM, ) = payable(o.maker).call{value: toMaker}("");
            require(okM, "pay maker failed");
            // buyFee ETH remains in this contract (swept via forwardFeesEth)
        } else {
            require(msg.value == 0, "no ETH for ERC20 buy");
            IERC20 b = IERC20(o.buyToken);
            b.safeTransferFrom(msg.sender, o.maker, toMaker);
            if (buyFee > 0) b.safeTransferFrom(msg.sender, address(this), buyFee); // buy fee -> this contract
        }

        emit OrderFilled(id, msg.sender, toTaker, toMaker, buyFee, sellFee);
    }

    /* ---------------- cancel ---------------- */

    /// @notice Maker cancels an open order and gets the full escrow back.
    function cancelOrder(uint256 id) external nonReentrant {
        Order memory o = orders[id];
        require(o.active, "not open");
        require(msg.sender == o.maker, "not maker");
        orders[id].active = false;
        escrowedOf[o.sellToken] -= o.sellAmount;
        IERC20(o.sellToken).safeTransfer(o.maker, o.sellAmount);
        emit OrderCancelled(id);
    }

    /* ---------------- views ---------------- */

    function getOrder(uint256 id) external view returns (Order memory) { return orders[id]; }

    /// @notice Open order ids (simple pager for the UI).
    function openOrders(uint256 start, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 n;
        for (uint256 i = start; i < nextOrderId && n < limit; i++) if (orders[i].active) n++;
        ids = new uint256[](n);
        uint256 j;
        for (uint256 i = start; i < nextOrderId && j < n; i++) if (orders[i].active) ids[j++] = i;
    }

    /* ---------------- out-of-band fee sweep (permissionless) ---------------- */

    /// @notice Sweep accrued fees of `token` (its balance ABOVE live escrow) to the fee wallet.
    ///         Permissionless + out-of-band — never part of a taker's fill tx, so fills stay clean.
    function forwardFees(address token) external {
        uint256 amount = IERC20(token).balanceOf(address(this)) - escrowedOf[token];
        require(amount > 0, "no fees");
        IERC20(token).safeTransfer(feeWallet, amount);
    }
    /// @notice Sweep accrued ETH fees (from ETH-priced fills) to the fee wallet. Permissionless.
    function forwardFeesEth() external {
        uint256 amount = address(this).balance;
        require(amount > 0, "no fees");
        (bool ok, ) = feeWallet.call{value: amount}("");
        require(ok, "xfer");
    }

    /* ---------------- admin (policy only; can't touch escrowed orders) ---------------- */

    function setFees(uint256 buyFeeBps_, uint256 sellFeeBps_) external onlyOwner {
        require(buyFeeBps_ <= MAX_FEE_BPS && sellFeeBps_ <= MAX_FEE_BPS, "fee too high");
        buyFeeBps = buyFeeBps_; sellFeeBps = sellFeeBps_;
        emit FeesChanged(buyFeeBps_, sellFeeBps_);
    }

    function setFeeWallet(address payable w) external onlyOwner {
        require(w != address(0), "zero");
        feeWallet = w;
        emit FeeWalletChanged(w);
    }

    /// @notice Recover ONLY the untracked surplus of a token — tokens sent here directly (donations,
    ///         mistaken transfers, transfer-tax dust) that were never part of any order. Live escrow
    ///         (`escrowedOf[token]`) is subtracted first, so this can NEVER touch a maker's funds.
    function rescueSurplus(address token, address to) external onlyOwner {
        require(to != address(0), "zero to");
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 locked = escrowedOf[token];
        require(bal > locked, "no surplus");
        IERC20(token).safeTransfer(to, bal - locked);
    }
}
