// Sources flattened with hardhat v2.28.6 https://hardhat.org

// SPDX-License-Identifier: MIT

// File @openzeppelin/contracts/utils/Context.sol@v5.0.2

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.1) (utils/Context.sol)

pragma solidity ^0.8.20;

/**
 * @dev Provides information about the current execution context, including the
 * sender of the transaction and its data. While these are generally available
 * via msg.sender and msg.data, they should not be accessed in such a direct
 * manner, since when dealing with meta-transactions the account sending and
 * paying for execution may not be the actual sender (as far as an application
 * is concerned).
 *
 * This contract is only required for intermediate, library-like contracts.
 */
abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {
        return 0;
    }
}


// File @openzeppelin/contracts/access/Ownable.sol@v5.0.2

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable.sol)

pragma solidity ^0.8.20;

/**
 * @dev Contract module which provides a basic access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * The initial owner is set to the address provided by the deployer. This can
 * later be changed with {transferOwnership}.
 *
 * This module is used through inheritance. It will make available the modifier
 * `onlyOwner`, which can be applied to your functions to restrict their use to
 * the owner.
 */
abstract contract Ownable is Context {
    address private _owner;

    /**
     * @dev The caller account is not authorized to perform an operation.
     */
    error OwnableUnauthorizedAccount(address account);

    /**
     * @dev The owner is not a valid owner account. (eg. `address(0)`)
     */
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /**
     * @dev Initializes the contract setting the address provided by the deployer as the initial owner.
     */
    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(initialOwner);
    }

    /**
     * @dev Throws if called by any account other than the owner.
     */
    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /**
     * @dev Returns the address of the current owner.
     */
    function owner() public view virtual returns (address) {
        return _owner;
    }

    /**
     * @dev Throws if the sender is not the owner.
     */
    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    /**
     * @dev Leaves the contract without owner. It will not be possible to call
     * `onlyOwner` functions. Can only be called by the current owner.
     *
     * NOTE: Renouncing ownership will leave the contract without an owner,
     * thereby disabling any functionality that is only available to the owner.
     */
    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}


// File @openzeppelin/contracts/access/Ownable2Step.sol@v5.0.2

// Original license: SPDX_License_Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable2Step.sol)

pragma solidity ^0.8.20;

/**
 * @dev Contract module which provides access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * The initial owner is specified at deployment time in the constructor for `Ownable`. This
 * can later be changed with {transferOwnership} and {acceptOwnership}.
 *
 * This module is used through inheritance. It will make available all functions
 * from parent (Ownable).
 */
abstract contract Ownable2Step is Ownable {
    address private _pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    /**
     * @dev Returns the address of the pending owner.
     */
    function pendingOwner() public view virtual returns (address) {
        return _pendingOwner;
    }

    /**
     * @dev Starts the ownership transfer of the contract to a new account. Replaces the pending transfer if there is one.
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner(), newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`) and deletes any pending owner.
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual override {
        delete _pendingOwner;
        super._transferOwnership(newOwner);
    }

    /**
     * @dev The new owner accepts the ownership transfer.
     */
    function acceptOwnership() public virtual {
        address sender = _msgSender();
        if (pendingOwner() != sender) {
            revert OwnableUnauthorizedAccount(sender);
        }
        _transferOwnership(sender);
    }
}


// File src/WantedBounty.sol

// Original license: SPDX_License_Identifier: MIT
pragma solidity 0.8.24;

/// @title WANTED: Outlaws of Sherwood — bounty claim
/// @notice Each NFT tokenId (1..21) has a fixed $STAG bounty. The current holder of the NFT
///         claims it ONCE. The owner funds this contract by depositing $STAG, sets the bounties,
///         then lock()s. lock() now REQUIRES the contract to already hold >= the full bounty total,
///         so a locked bounty is a real, funded guarantee (not just a flag). After an expiry the
///         owner may reclaim leftover (unclaimed) $STAG.
///
/// @dev SECONDARY-SALE SEMANTICS: the bounty is claimed ONCE per tokenId by whoever claims first.
///      A buyer of a WANTED on secondary MUST check `claimed(id)` — if true, the bounty is gone.
///      Surface `claimed[id]` in any marketplace/listing UI. WANTED is lock-in-place stakeable, so
///      the holder keeps ownership while staked and the bounty stays claimable during staking.

interface IERC20  { function transfer(address,uint256) external returns (bool);
                    function balanceOf(address) external view returns (uint256); }
interface IERC721 { function ownerOf(uint256) external view returns (address); }

contract WantedBounty is Ownable2Step {
    uint256 public constant MAX_ID = 21;             // WANTED token ids are 1..21
    uint256 public constant MIN_CLAIM_WINDOW = 30 days; // holders always get >= 30 days before sweep

    IERC20  public immutable STAG;   // 0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49
    IERC721 public immutable WANTED; // the WANTED collection NFT
    bool    public locked;           // once locked, bounties can't change
    uint256 public expiry;           // after this, owner may reclaim unclaimed $STAG
    uint256 public totalBounty;      // running sum of all set bounties (funding target)

    mapping(uint256 => uint256) public bounty;   // tokenId => $STAG amount (18 decimals)
    mapping(uint256 => bool)    public claimed;  // tokenId => claimed?

    event BountySet(uint256 indexed id, uint256 amount);
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);
    event Locked(uint256 totalBounty);
    event Swept(address indexed to, uint256 amount);

    constructor(address stag, address wanted, uint256 expiry_) Ownable(msg.sender) {
        require(stag != address(0) && wanted != address(0), "zero addr");
        require(expiry_ >= block.timestamp + MIN_CLAIM_WINDOW, "expiry too soon");
        STAG = IERC20(stag); WANTED = IERC721(wanted); expiry = expiry_;
    }

    /// @notice Owner sets each token's bounty (before locking). Batched. Maintains totalBounty so
    ///         lock() can verify full funding. ids must be 1..21; amounts must be > 0.
    function setBounties(uint256[] calldata ids, uint256[] calldata amounts) external onlyOwner {
        require(!locked, "locked");
        require(ids.length == amounts.length, "len");
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            require(id >= 1 && id <= MAX_ID, "bad id");
            require(amounts[i] > 0, "zero amount");
            totalBounty = totalBounty - bounty[id] + amounts[i]; // correct on overwrite
            bounty[id] = amounts[i];
            emit BountySet(id, amounts[i]);
        }
    }

    /// @notice Freeze bounties so holders can trust them. REQUIRES the contract to already hold the
    ///         full bounty total — a locked bounty is therefore a funded promise. Irreversible.
    function lock() external onlyOwner {
        require(totalBounty > 0, "no bounties");
        require(STAG.balanceOf(address(this)) >= totalBounty, "underfunded");
        locked = true;
        emit Locked(totalBounty);
    }

    /// @notice Current holder of tokenId claims its bounty, once. CEI: flag set before transfer.
    function claim(uint256 id) external {
        require(locked, "not live");
        require(!claimed[id], "already claimed");
        require(WANTED.ownerOf(id) == msg.sender, "not holder");
        uint256 amt = bounty[id]; require(amt > 0, "no bounty");
        claimed[id] = true;
        require(STAG.transfer(msg.sender, amt), "transfer failed");
        emit Claimed(id, msg.sender, amt);
    }

    /// @notice Batch claim for a holder owning several. Skips unowned/already-claimed ids.
    function claimMany(uint256[] calldata ids) external {
        require(locked, "not live");
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (claimed[id]) continue;
            if (WANTED.ownerOf(id) != msg.sender) continue;
            uint256 amt = bounty[id]; if (amt == 0) continue;
            claimed[id] = true;
            require(STAG.transfer(msg.sender, amt), "transfer failed");
            emit Claimed(id, msg.sender, amt);
        }
    }

    /// @notice After expiry, owner reclaims whatever $STAG is left (unclaimed bounties).
    function sweep() external onlyOwner {
        require(block.timestamp >= expiry, "not expired");
        uint256 bal = STAG.balanceOf(address(this));
        require(STAG.transfer(owner(), bal), "sweep failed");
        emit Swept(owner(), bal);
    }
}
