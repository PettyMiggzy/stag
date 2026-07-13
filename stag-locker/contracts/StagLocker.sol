// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Minimal Uniswap V3 NonfungiblePositionManager interface — ONLY `collect`.
///         Deliberately does NOT expose decreaseLiquidity/burn/transfer, so the locker
///         can sweep accrued swap fees to the lock owner without any path to unlock,
///         reduce, or move the underlying position.
interface INonfungiblePositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function collect(CollectParams calldata params) external returns (uint256 amount0, uint256 amount1);
}

/**
 * @title StagLocker
 * @notice Permissionless token + LP locker for any project on Robinhood Chain.
 *         Anyone can lock ERC-20 tokens or a Uniswap V3 LP position (NFT) until a
 *         chosen unlock time to prove they can't rug. Locks are immutable in the
 *         owner's favour: they can only be EXTENDED or TOPPED UP, never shortened or
 *         pulled early. The contract admin can only set the (optional) creation fee and
 *         fee recipient - the admin can NEVER touch or move locked assets.
 *
 * @dev    Solidity 0.8.24, OpenZeppelin 5.x. Deploy with the chain's Uniswap V3
 *         NonfungiblePositionManager so LP-NFT locks can be identified/validated.
 *         Robinhood Chain V3 NPM: 0x73991a25c818bf1f1128deaab1492d45638de0d3
 *
 * @dev    SECURITY / SUPPORT NOTES (read before locking or verifying a lock):
 *         - REBASING / ELASTIC-SUPPLY tokens are UNSUPPORTED. Locked amounts are
 *           recorded once at lock/top-up time from the delta actually received.
 *           Multiple locks of the same rebasing token all draw from one shared
 *           contract balance, so a NEGATIVE rebase can shrink that balance below the
 *           sum of recorded amounts and leave the LAST withdrawer short. Do not lock
 *           rebasing/elastic tokens here.
 *         - The flat creation fee is INTENTIONALLY NOT charged on the
 *           onERC721Received (safeTransferFrom) V3 path: a safeTransferFrom carries no
 *           ETH, so there is no way to collect a fee there. Only lockV3Position charges
 *           the fee. This is by design, not an oversight.
 *         - VERIFIERS: a locked V3 position NFT can hold ANY (or zero) liquidity.
 *           Confirming that a tokenId is locked here is NOT proof of locked value;
 *           always query the position's ACTUAL liquidity/amounts on the position
 *           manager before trusting a "LP is locked" claim.
 *         - PAUSABLE / BLOCKLIST tokens can FREEZE locked funds at withdraw time: if a
 *           token pauses transfers or blocklists this contract or the owner, withdraw()
 *           will revert until (and unless) the token allows the transfer again. This
 *           locker cannot override that; such risk is inherent to the token itself.
 */
contract StagLocker is Ownable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    enum Kind { ERC20, V3_LP }

    struct Lock {
        Kind kind;          // token lock or Uniswap V3 LP-NFT lock
        address asset;      // ERC20 token, or the V3 position manager (NFT contract)
        uint256 amountOrId; // ERC20: locked amount (actual received) · V3: the tokenId
        address owner;      // the only account that can withdraw / manage the lock
        uint64 unlockTime;  // unix seconds; for vesting this is the vesting END
        bool withdrawn;     // true once fully claimed
        uint64 start;       // vesting start; for a pure cliff (and V3) start == unlockTime
        uint256 released;   // ERC20 vesting: cumulative amount already withdrawn
    }

    /// @notice Uniswap V3 NonfungiblePositionManager for this chain (LP-NFT locks).
    address public immutable positionManager;

    /// @notice Flat creation fee in wei (native ETH). 0 = free. Only affects NEW locks.
    uint256 public flatFeeWei;
    /// @notice Where creation fees are sent.
    address public feeRecipient;
    /// @notice Fees accrued inside the contract, awaiting withdrawFees() (pull-payment).
    ///         Accruing rather than pushing means a reverting/hostile feeRecipient can
    ///         NEVER brick lock creation; fees stay safely claimable later.
    uint256 public accruedFees;

    /// @notice Fee/burn waiver + burn token. Wallets holding >= `feeExemptMinBalance` of
    ///         `feeExemptToken` (e.g. 10,000,000 $STAG) create locks for FREE — no ETH fee and
    ///         no burn. Everyone else pays `flatFeeWei` (ETH, default 0) AND burns
    ///         `burnPerPeriod` of `feeExemptToken` per `burnPeriod` of lock duration.
    ///         token = address(0) (or min = 0) disables the waiver.
    IERC20 public feeExemptToken;
    uint256 public feeExemptMinBalance;

    /// @notice $STAG burn cost, pro-rated by lock duration: `burnPerPeriod` tokens per `burnPeriod`
    ///         seconds locked (e.g. 2,000,000e18 per 30 days). Burned = sent to BURN_ADDRESS.
    ///         Charged on lockTokens / lockV3Position (full term) and extendLock (added term),
    ///         waived for holders >= feeExemptMinBalance. burnPerPeriod = 0 disables burning.
    uint256 public burnPerPeriod;
    uint256 public burnPeriod;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Optional hard cap on the $STAG burned per lock/extend action. 0 = no cap.
    ///         Applied AFTER the duration-scaling in burnFor, so very long terms can't burn
    ///         an unbounded amount. Does not affect the ETH fee or the exemption logic.
    uint256 public burnCap;

    uint256 public nextLockId;
    mapping(uint256 => Lock) private _locks;
    mapping(address => uint256[]) private _ownerLocks; // owner => lockIds
    mapping(address => uint256[]) private _assetLocks; // asset => lockIds

    event TokenLocked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint64 unlockTime);
    event V3Locked(uint256 indexed id, address indexed owner, uint256 indexed tokenId, uint64 unlockTime);
    event Withdrawn(uint256 indexed id, address indexed owner);
    event LockExtended(uint256 indexed id, uint64 newUnlockTime);
    event LockToppedUp(uint256 indexed id, uint256 addedAmount, uint256 newAmount);
    event LockOwnerChanged(uint256 indexed id, address indexed from, address indexed to);
    event FeeChanged(uint256 flatFeeWei, address feeRecipient);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event FeeExemptionChanged(address token, uint256 minBalance);
    event BurnConfigChanged(uint256 burnPerPeriod, uint256 burnPeriod);
    event BurnCapChanged(uint256 burnCap);
    event LockBurned(address indexed who, uint256 amount, uint256 durationSecs);
    event VestingLocked(uint256 indexed id, uint64 start, uint64 end);
    event V3FeesCollected(uint256 indexed id, address indexed owner);
    event LockLabeled(uint256 indexed id, string name, string uri);

    error BadUnlockTime();
    error NotLockOwner();
    error StillLocked();
    error AlreadyWithdrawn();
    error WrongKind();
    error FeeTooLow();
    error ZeroAmount();
    error ZeroAddress();
    error SameOwner();
    error NothingToWithdraw();
    error FeeWithdrawFailed();

    constructor(address _positionManager, uint256 _flatFeeWei, address _feeRecipient, address _admin)
        Ownable(_admin)
    {
        if (_feeRecipient == address(0) || _admin == address(0)) revert ZeroAddress();
        positionManager = _positionManager; // may be address(0) if V3 locks unused on this chain
        flatFeeWei = _flatFeeWei;
        feeRecipient = _feeRecipient;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Locking
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Lock ERC-20 `token` until `unlockTime`. Handles fee-on-transfer tokens
    ///         by recording the amount actually received. Send >= flatFeeWei as msg.value.
    function lockTokens(address token, uint256 amount, uint64 unlockTime)
        external payable nonReentrant returns (uint256 id)
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (unlockTime <= block.timestamp) revert BadUnlockTime();
        _takeFee();
        _burnFee(msg.sender, unlockTime - block.timestamp); // duration-scaled $STAG burn

        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before; // fee-on-transfer safe
        if (received == 0) revert ZeroAmount();

        id = nextLockId++;
        // Pure cliff: start == unlockTime => nothing vested until unlockTime, then all
        // (identical behaviour to the original all-or-nothing lock).
        _locks[id] = Lock(Kind.ERC20, token, received, msg.sender, unlockTime, false, unlockTime, 0);
        _ownerLocks[msg.sender].push(id);
        _assetLocks[token].push(id);
        emit TokenLocked(id, msg.sender, token, received, unlockTime);
    }

    /// @notice Lock ERC-20 `token` with cliff+linear vesting: nothing before `start`, then a
    ///         straight-line release from `start` to `end`. Partial withdrawals release only
    ///         the newly-vested portion (see withdraw/vestedOf). Fee + duration-scaled $STAG
    ///         burn are charged on the FULL remaining term (`end - now`), like lockTokens.
    ///         Handles fee-on-transfer tokens (vesting is computed over the amount RECEIVED).
    function lockTokensVesting(address token, uint256 amount, uint64 start, uint64 end)
        external payable nonReentrant returns (uint256 id)
    {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (end <= block.timestamp) revert BadUnlockTime(); // must end in the future
        // "start now" is the common case, but the tx mines a few seconds after the UI computed
        // `now`, so a literal now-value would be slightly in the past. Clamp any past start up to
        // the current block instead of reverting — vesting simply begins at creation.
        if (start < block.timestamp) start = uint64(block.timestamp);
        if (end <= start) revert BadUnlockTime();            // real (positive-length) schedule
        _takeFee();
        _burnFee(msg.sender, uint256(end) - block.timestamp); // burn on the full term

        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before; // fee-on-transfer safe
        if (received == 0) revert ZeroAmount();

        id = nextLockId++;
        _locks[id] = Lock(Kind.ERC20, token, received, msg.sender, end, false, start, 0);
        _ownerLocks[msg.sender].push(id);
        _assetLocks[token].push(id);
        emit TokenLocked(id, msg.sender, token, received, end);
        emit VestingLocked(id, start, end);
    }

    /// @notice Lock a Uniswap V3 LP position NFT (`tokenId`) until `unlockTime`.
    ///         Approve this contract for the NFT first, or use safeTransferFrom with data.
    function lockV3Position(uint256 tokenId, uint64 unlockTime)
        external payable nonReentrant returns (uint256 id)
    {
        if (positionManager == address(0)) revert WrongKind();
        if (unlockTime <= block.timestamp) revert BadUnlockTime();
        _takeFee();
        _burnFee(msg.sender, unlockTime - block.timestamp); // duration-scaled $STAG burn
        IERC721(positionManager).transferFrom(msg.sender, address(this), tokenId);
        id = _recordV3(msg.sender, tokenId, unlockTime);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Managing a lock (owner-only, never weakens the lock)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Extend a lock. `newUnlockTime` must be LATER than the current one. Burns the
    ///         duration-scaled $STAG for the ADDED time (waived for exempt holders).
    function extendLock(uint256 id, uint64 newUnlockTime) external nonReentrant {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (newUnlockTime <= l.unlockTime) revert BadUnlockTime();
        uint256 added = uint256(newUnlockTime) - l.unlockTime; // burn only for the extra term
        // Keep a pure-cliff lock a cliff: cliff is marked by start == unlockTime, so move start
        // in lock-step. Otherwise extending would silently turn it into a linear-vesting lock over
        // [oldUnlock, newUnlock] and leak funds out before the advertised new unlock. Genuine
        // vesting locks (start < unlockTime) keep their fixed start — the tail just lengthens.
        if (l.start == l.unlockTime) l.start = newUnlockTime;
        l.unlockTime = newUnlockTime;                          // effects before the external burn
        _burnFee(msg.sender, added);
        emit LockExtended(id, newUnlockTime);
    }

    /// @notice Add more of the SAME token to an existing ERC-20 lock (no fee).
    /// @dev NOTE for VESTING locks: the top-up joins the existing schedule, so the already-elapsed
    ///      fraction of the added amount is immediately withdrawable (it's the owner's own funds,
    ///      fully accounted — released can never exceed amountOrId). To lock fresh funds on a fresh
    ///      schedule, create a new lock instead of topping up a mid-vest one.
    function topUp(uint256 id, uint256 amount) external nonReentrant {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (l.kind != Kind.ERC20) revert WrongKind();
        if (amount == 0) revert ZeroAmount();
        IERC20 t = IERC20(l.asset);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount(); // consistency with lockTokens (no 0-value top-up)
        l.amountOrId += received;
        emit LockToppedUp(id, received, l.amountOrId);
    }

    /// @notice Hand a lock to a new owner (e.g. to a multisig). Irreversible for old owner.
    function transferLockOwnership(uint256 id, address newOwner) external nonReentrant {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();
        if (newOwner == address(0)) revert ZeroAddress();
        if (newOwner == msg.sender) revert SameOwner(); // reject no-op self-transfer
        l.owner = newOwner;
        // Remove `id` from the OLD owner's index via swap-and-pop so the enumeration
        // stays accurate (no stale/duplicate entries, no unbounded A->B->A growth).
        // Linear scan is fine: transfers are rare.
        uint256[] storage from = _ownerLocks[msg.sender];
        uint256 len = from.length;
        for (uint256 i = 0; i < len; i++) {
            if (from[i] == id) {
                from[i] = from[len - 1];
                from.pop();
                break;
            }
        }
        _ownerLocks[newOwner].push(id);
        emit LockOwnerChanged(id, msg.sender, newOwner);
    }

    /// @notice Withdraw a lock. Owner only.
    ///         - Vesting ERC-20 lock (start != unlockTime): releases ONLY the newly-vested
    ///           portion (vestedAmount(now) - released). CEI: released/withdrawn updated
    ///           BEFORE the transfer. Cumulative released can never exceed the deposit.
    ///         - Pure-cliff ERC-20 (start == unlockTime) and V3 locks: unchanged
    ///           all-or-nothing behaviour, only at/after unlockTime.
    function withdraw(uint256 id) external nonReentrant {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.withdrawn) revert AlreadyWithdrawn();

        // Vesting ERC-20: partial, time-based release.
        if (l.kind == Kind.ERC20 && l.start != l.unlockTime) {
            uint256 vested = _vestedAmount(l, block.timestamp);
            // Saturating: an extend can lower the vested rate below what was already
            // released; treat that as "nothing new to withdraw" rather than underflowing.
            uint256 amt = vested > l.released ? vested - l.released : 0;
            if (amt == 0) revert NothingToWithdraw();
            l.released += amt;                       // effects before interaction (CEI)
            if (l.released == l.amountOrId) l.withdrawn = true;
            IERC20(l.asset).safeTransfer(msg.sender, amt);
            emit Withdrawn(id, msg.sender);
            return;
        }

        // Pure-cliff ERC-20 or V3: all-or-nothing at unlockTime.
        if (block.timestamp < l.unlockTime) revert StillLocked();
        l.withdrawn = true;
        if (l.kind == Kind.ERC20) {
            l.released = l.amountOrId; // keep the released accounting consistent
            IERC20(l.asset).safeTransfer(msg.sender, l.amountOrId);
        } else {
            IERC721(l.asset).safeTransferFrom(address(this), msg.sender, l.amountOrId);
        }
        emit Withdrawn(id, msg.sender);
    }

    /// @notice Sweep accrued Uniswap V3 swap fees for a locked position WITHOUT unlocking it.
    ///         Owner-only. Fees are sent to the lock OWNER (never an arbitrary recipient).
    ///         Routes exclusively through `collect`; there is no path here to
    ///         decreaseLiquidity/burn/transfer the position, so the lock is never weakened.
    function collectV3Fees(uint256 id) external nonReentrant {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        if (l.kind != Kind.V3_LP) revert WrongKind();
        if (l.withdrawn) revert AlreadyWithdrawn();
        INonfungiblePositionManager(positionManager).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: l.amountOrId,
                recipient: l.owner,                  // hard-wired to the owner
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit V3FeesCollected(id, l.owner);
    }

    /// @notice Attach display-only trust metadata (name + uri) to a lock for the verify UI.
    ///         Owner-only. EVENT-ONLY: stores nothing and affects NO fund logic whatsoever.
    function labelLock(uint256 id, string calldata name, string calldata uri) external nonReentrant {
        Lock storage l = _locks[id];
        if (l.owner != msg.sender) revert NotLockOwner();
        emit LockLabeled(id, name, uri);
    }

    /// @dev Amount vested by timestamp `ts` for an ERC-20 lock (see contract docs):
    ///      now < start            -> 0
    ///      start == unlockTime    -> pure cliff: all at/after unlockTime, else 0
    ///      else                   -> linear over [start, unlockTime]
    ///      Always <= amountOrId and monotonic non-decreasing in `ts`.
    function _vestedAmount(Lock storage l, uint256 ts) private view returns (uint256) {
        if (ts < l.start) return 0;
        if (l.start == l.unlockTime) {
            return ts >= l.unlockTime ? l.amountOrId : 0;
        }
        uint256 endTs = ts < l.unlockTime ? ts : l.unlockTime; // min(now, end)
        // mulDiv is overflow-proof (full 512-bit intermediate), so even an astronomically large
        // amountOrId can never revert the vesting math. Result is still floor(amount * frac) <= amount.
        return Math.mulDiv(l.amountOrId, endTs - l.start, uint256(l.unlockTime) - l.start);
    }

    /// @notice For an ERC-20 lock: the amount vested by now and how much is withdrawable
    ///         (vested minus already-released). Returns (0,0) for V3 locks.
    function vestedOf(uint256 id) external view returns (uint256 vested, uint256 withdrawable) {
        Lock storage l = _locks[id];
        if (l.kind != Kind.ERC20) return (0, 0);
        vested = _vestedAmount(l, block.timestamp);
        withdrawable = vested > l.released ? vested - l.released : 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views (public verification)
    // ─────────────────────────────────────────────────────────────────────────

    function getLock(uint256 id) external view returns (Lock memory) { return _locks[id]; }

    /// @notice Full id list for `owner`. Kept for back-compat; UNBOUNDED - may exceed the
    ///         eth_call gas cap for large sets. Prefer ownerLockCount + ownerLockIdsPaged.
    function ownerLockIds(address owner) external view returns (uint256[] memory) { return _ownerLocks[owner]; }

    /// @notice Full id list for `asset`. Kept for back-compat; UNBOUNDED - may exceed the
    ///         eth_call gas cap for large sets. Prefer assetLockCount + assetLockIdsPaged.
    function assetLockIds(address asset) external view returns (uint256[] memory) { return _assetLocks[asset]; }

    function totalLocks() external view returns (uint256) { return nextLockId; }

    /// @notice Number of lock ids indexed for `owner`.
    function ownerLockCount(address owner) external view returns (uint256) { return _ownerLocks[owner].length; }

    /// @notice Number of lock ids indexed for `asset`.
    function assetLockCount(address asset) external view returns (uint256) { return _assetLocks[asset].length; }

    /// @notice Paginated slice of `owner`'s lock ids. `start`/`count` are clamped to the
    ///         array length, so out-of-range requests return an empty/short array instead
    ///         of reverting. Lets a verify UI page through large sets under the gas cap.
    function ownerLockIdsPaged(address owner, uint256 start, uint256 count)
        external view returns (uint256[] memory)
    { return _paged(_ownerLocks[owner], start, count); }

    /// @notice Paginated slice of `asset`'s lock ids (clamped, same semantics as above).
    function assetLockIdsPaged(address asset, uint256 start, uint256 count)
        external view returns (uint256[] memory)
    { return _paged(_assetLocks[asset], start, count); }

    /// @notice True once a lock is at/after its unlock time. Guards nonexistent ids: an id
    ///         that was never created (no owner) is NOT "unlocked" (returns false), so the
    ///         default-zero unlockTime of an unused slot can't read as unlocked.
    function isUnlocked(uint256 id) external view returns (bool) {
        Lock storage l = _locks[id];
        if (l.owner == address(0)) return false; // nonexistent lock
        return block.timestamp >= l.unlockTime;
    }

    /// @notice Sum of the still-locked ERC-20 amount (amountOrId - released, for non-withdrawn
    ///         ERC-20 locks) of `token` over a paginated slice of its lock index. Powers a
    ///         "% of supply locked" readout without unbounded gas — page with start/count and
    ///         add the results. `count` is clamped to MAX_PAGE; out-of-range `start` returns 0.
    function totalLockedOf(address token, uint256 start, uint256 count)
        external view returns (uint256 total)
    {
        uint256[] storage arr = _assetLocks[token];
        if (count > MAX_PAGE) count = MAX_PAGE;
        uint256 len = arr.length;
        if (start >= len) return 0;
        uint256 end = start + count;
        if (end > len) end = len;
        for (uint256 i = start; i < end; i++) {
            Lock storage l = _locks[arr[i]];
            if (l.kind == Kind.ERC20 && !l.withdrawn) {
                total += l.amountOrId - l.released; // released <= amountOrId invariant
            }
        }
    }

    /// @dev Return arr[start .. start+count), clamped to arr.length.
    /// @dev Page size is capped at 1000 so a caller passing a huge `count` can never force an
    ///      unbounded return that exceeds the eth_call gas limit (spam-index DoS hardening).
    uint256 private constant MAX_PAGE = 1000;

    function _paged(uint256[] storage arr, uint256 start, uint256 count)
        private view returns (uint256[] memory out)
    {
        if (count > MAX_PAGE) count = MAX_PAGE;
        uint256 len = arr.length;
        if (start >= len) return new uint256[](0);
        uint256 end = start + count;
        if (end > len) end = len;
        out = new uint256[](end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = arr[i];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: fee only. NO access to locked assets, ever.
    // ─────────────────────────────────────────────────────────────────────────

    function setFee(uint256 _flatFeeWei, address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        flatFeeWei = _flatFeeWei;
        feeRecipient = _feeRecipient;
        emit FeeChanged(_flatFeeWei, _feeRecipient);
    }

    /// @notice Enable/disable the hold-to-lock-free waiver. Either token=address(0) OR
    ///         minBalance=0 DISABLES it (everyone pays flatFeeWei) — minBalance=0 does NOT make
    ///         all holders exempt. The waiver is a spot balance check (a flash-borrowed balance
    ///         qualifies), which is fine for a ~$20 anti-spam fee. Note: V3-LP creation fees are
    ///         effectively voluntary regardless (the onERC721Received safeTransferFrom path takes
    ///         no ETH), so meaningful fee revenue comes from non-exempt ERC-20 lockers.
    function setFeeExemption(address token, uint256 minBalance) external onlyOwner {
        feeExemptToken = IERC20(token);
        feeExemptMinBalance = minBalance;
        emit FeeExemptionChanged(token, minBalance);
    }

    /// @notice Set the duration-scaled $STAG burn: `perPeriod` tokens per `period` seconds locked
    ///         (e.g. 2,000,000e18 per 30 days). perPeriod = 0 disables burning. The burn token is
    ///         `feeExemptToken`, so set the exemption first. Waived for exempt holders.
    function setBurnConfig(uint256 perPeriod, uint256 period) external onlyOwner {
        if (perPeriod > 0 && period == 0) revert ZeroAmount(); // avoid div-by-zero when enabled
        // Enabling the burn requires a burn token to exist, else _burnFee would call
        // safeTransferFrom on address(0) and revert EVERY new lock. Set the exemption first.
        if (perPeriod > 0 && address(feeExemptToken) == address(0)) revert ZeroAddress();
        burnPerPeriod = perPeriod;
        burnPeriod = period;
        emit BurnConfigChanged(perPeriod, period);
    }

    /// @notice Cap the $STAG burned per lock/extend action. 0 = uncapped (default). Clamps the
    ///         duration-scaled amount in burnFor so very long terms can't burn without bound.
    function setBurnCap(uint256 _burnCap) external onlyOwner {
        burnCap = _burnCap;
        emit BurnCapChanged(_burnCap);
    }

    /// @dev True if `who` holds >= the waiver threshold of the exempt token. The balanceOf is
    ///      isolated in a gas-capped try/catch and FAILS CLOSED (a hostile/paused/broken token
    ///      forfeits the waiver — everyone pays — and can NEVER brick lock creation).
    function _isExempt(address who) internal view returns (bool) {
        IERC20 tk = feeExemptToken;
        if (address(tk) != address(0) && feeExemptMinBalance > 0) {
            try tk.balanceOf{gas: 100_000}(who) returns (uint256 bal) {
                if (bal >= feeExemptMinBalance) return true;
            } catch {}
        }
        return false;
    }

    /// @notice The ETH creation fee `who` will pay: 0 if exempt, else `flatFeeWei`.
    function feeFor(address who) public view returns (uint256) {
        return _isExempt(who) ? 0 : flatFeeWei;
    }

    /// @notice The $STAG amount `who` must burn to lock for `durationSecs`: 0 if exempt or burning
    ///         disabled, else `burnPerPeriod * durationSecs / burnPeriod`. The UI reads this and
    ///         prompts a $STAG approval for that amount.
    function burnFor(address who, uint256 durationSecs) public view returns (uint256) {
        // Fail-safe: with no burn token configured, burning is a no-op (locks stay creatable)
        // rather than reverting on a safeTransferFrom to address(0). Never fails custody-open.
        if (burnPerPeriod == 0 || burnPeriod == 0 || address(feeExemptToken) == address(0) || _isExempt(who)) return 0;
        uint256 amt = (burnPerPeriod * durationSecs) / burnPeriod;
        if (burnCap > 0 && amt > burnCap) amt = burnCap; // clamp to the per-action cap
        return amt;
    }

    /// @notice Send all accrued creation fees to the CURRENT feeRecipient. Callable by
    ///         anyone: funds go only to feeRecipient regardless of who calls, so this is
    ///         a harmless, non-bricking way to sweep fees. Follows checks-effects-
    ///         interactions - accruedFees is zeroed before the transfer; if the transfer
    ///         reverts the whole call reverts and fees remain accrued (never lost).
    function withdrawFees() external nonReentrant {
        uint256 amount = accruedFees;
        if (amount == 0) revert NothingToWithdraw();
        address to = feeRecipient;
        accruedFees = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert FeeWithdrawFailed();
        emit FeesWithdrawn(to, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Collects the flat fee as a PULL payment: the fee is accrued inside the
    ///      contract (claimable later via withdrawFees) rather than pushed to
    ///      feeRecipient here. This means a reverting/hostile feeRecipient can never
    ///      brick lock creation - even permanently after renounceOwnership. Overpayment
    ///      is still refunded to msg.sender; a failing refund only self-griefs the
    ///      caller, so it is left as a require.
    function _takeFee() private {
        uint256 fee = feeFor(msg.sender); // 0 for exempt (e.g. >= 10M $STAG) holders
        if (msg.value < fee) revert FeeTooLow();
        if (fee > 0) {
            accruedFees += fee;
        }
        // refund any overpayment (self-griefing only if it reverts)
        uint256 extra = msg.value - fee;
        if (extra > 0) {
            (bool ok2, ) = msg.sender.call{value: extra}("");
            require(ok2, "refund failed");
        }
    }

    /// @dev Burn the duration-scaled $STAG cost by pulling it from `who` to BURN_ADDRESS.
    ///      No-op when the caller is exempt or burning is disabled. Requires a $STAG allowance.
    function _burnFee(address who, uint256 durationSecs) private {
        uint256 amt = burnFor(who, durationSecs);
        if (amt > 0) {
            feeExemptToken.safeTransferFrom(who, BURN_ADDRESS, amt);
            emit LockBurned(who, amt, durationSecs);
        }
    }

    function _recordV3(address owner, uint256 tokenId, uint64 unlockTime) private returns (uint256 id) {
        id = nextLockId++;
        // V3 locks are all-or-nothing; start == unlockTime so they never enter the
        // vesting branch and no partial release is ever possible.
        _locks[id] = Lock(Kind.V3_LP, positionManager, tokenId, owner, unlockTime, false, unlockTime, 0);
        _ownerLocks[owner].push(id);
        _assetLocks[positionManager].push(id);
        emit V3Locked(id, owner, tokenId, unlockTime);
    }

    /// @dev Accept V3 position NFTs ONLY as a lock creation: must come from the
    ///      configured positionManager and carry abi.encode(uint64 unlockTime) as data,
    ///      which auto-creates the lock owned by `from`. Anything else reverts, so a
    ///      stray/mis-encoded safeTransferFrom can never strand an NFT in this contract
    ///      with no lock recorded. The duration-scaled $STAG burn IS charged here (it needs no
    ///      ETH), so this path can't dodge the burn — `from` must have approved $STAG first.
    ///      The optional ETH `flatFeeWei` still cannot apply here (safeTransferFrom carries no
    ///      value); use lockV3Position if an ETH fee must be collected.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata data)
        external override nonReentrant returns (bytes4)
    {
        if (msg.sender != positionManager) revert WrongKind();
        if (data.length != 32) revert BadUnlockTime();
        uint64 unlockTime = abi.decode(data, (uint64));
        if (unlockTime <= block.timestamp) revert BadUnlockTime();
        _burnFee(from, unlockTime - block.timestamp); // charge the $STAG burn on this path too
        _recordV3(from, tokenId, unlockTime);
        return this.onERC721Received.selector;
    }
}
