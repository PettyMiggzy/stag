// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Hood Rich Album Pass
/// @notice One NFT = access to the whole Hood Rich album by Winslow Bankz (Stag House Records).
///         Paid in Robinhood Chain ETH, hard supply cap, and the ETH goes straight to the payout
///         wallet in the same transaction: this contract never holds funds.
contract HoodRichAlbum is ERC721, Ownable2Step, ReentrancyGuard {
    address public immutable payout;
    uint256 public immutable maxSupply;

    uint256 public price; // in wei (ETH has 18 decimals); the owner can update it as the ETH price moves
    uint256 public totalSupply;
    bool public paused = true; // minting opens when the owner calls setPaused(false)
    bool public metadataFrozen;
    string private _metadataURI;

    event Minted(address indexed buyer, uint256 indexed tokenId, uint256 price);
    event PriceSet(uint256 price);
    event PausedSet(bool paused);
    event MetadataSet(string uri);
    event MetadataFroze();

    error SoldOut();
    error MintPaused();
    error Frozen();
    error ZeroAddress();
    error WrongPayment();
    error RenounceDisabled();
    error PayoutFailed();

    constructor(address payout_, uint256 price_, uint256 maxSupply_, string memory metadataURI_, address owner_)
        ERC721("Hood Rich - Winslow Bankz", "HOODRICH")
        Ownable(owner_)
    {
        if (payout_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        payout = payout_;
        price = price_;
        maxSupply = maxSupply_;
        _metadataURI = metadataURI_;
    }

    /// @notice Buy one album pass by sending exactly `price` in ETH. The ETH goes straight to the payout wallet.
    ///         If the owner changes the price while a buyer's transaction is pending, it reverts and nothing is charged.
    function mint() external payable nonReentrant returns (uint256 tokenId) {
        if (paused) revert MintPaused();
        if (totalSupply >= maxSupply) revert SoldOut();
        if (msg.value != price) revert WrongPayment();
        tokenId = ++totalSupply;
        (bool ok,) = payout.call{value: msg.value}("");
        if (!ok) revert PayoutFailed();
        _safeMint(msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, msg.value);
    }

    /// @notice True if the wallet holds at least one album pass (used for gated access).
    function hasAccess(address who) external view returns (bool) {
        return balanceOf(who) > 0;
    }

    /// @dev Renouncing ownership would permanently lock the sale (no pause, no price change), so it is disabled.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
        emit PriceSet(price_);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function setMetadataURI(string calldata uri) external onlyOwner {
        if (metadataFrozen) revert Frozen();
        _metadataURI = uri;
        emit MetadataSet(uri);
    }

    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFroze();
    }

    /// @dev Every pass points at the same album metadata.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _metadataURI;
    }

    function contractURI() external view returns (string memory) {
        return _metadataURI;
    }
}
