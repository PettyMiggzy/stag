// SPDX-License-Identifier: MIT
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
import "@openzeppelin/contracts/access/Ownable2Step.sol";

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
