// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Hood Rich Album Pass
/// @notice One NFT = access to the whole Hood Rich album by Winslow Bankz (Stag House Records).
///         Fixed price in a USD stablecoin, hard supply cap, and the money goes straight to the
///         payout wallet in the same transaction: this contract never holds funds.
contract HoodRichAlbum is ERC721, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable payToken;
    address public immutable payout;
    uint256 public immutable price;
    uint256 public immutable maxSupply;

    uint256 public totalSupply;
    bool public paused = true; // minting opens when the owner calls setPaused(false)
    bool public metadataFrozen;
    string private _metadataURI;

    event Minted(address indexed buyer, uint256 indexed tokenId, uint256 price);
    event PausedSet(bool paused);
    event MetadataSet(string uri);
    event MetadataFroze();

    error SoldOut();
    error MintPaused();
    error Frozen();
    error ZeroAddress();

    constructor(
        address payToken_,
        address payout_,
        uint256 price_,
        uint256 maxSupply_,
        string memory metadataURI_,
        address owner_
    ) ERC721("Hood Rich - Winslow Bankz", "HOODRICH") Ownable(owner_) {
        if (payToken_ == address(0) || payout_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        payToken = IERC20(payToken_);
        payout = payout_;
        price = price_;
        maxSupply = maxSupply_;
        _metadataURI = metadataURI_;
    }

    /// @notice Buy one album pass. The buyer must first approve `price` of the pay token to this contract.
    function mint() external nonReentrant returns (uint256 tokenId) {
        if (paused) revert MintPaused();
        if (totalSupply >= maxSupply) revert SoldOut();
        tokenId = ++totalSupply;
        payToken.safeTransferFrom(msg.sender, payout, price);
        _safeMint(msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, price);
    }

    /// @notice True if the wallet holds at least one album pass (used for gated access).
    function hasAccess(address who) external view returns (bool) {
        return balanceOf(who) > 0;
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
