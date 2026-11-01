// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Stag House Records song passes
/// @notice One token id per song. Each song has its own fixed price and hard cap, set when the owner adds it
///         and never changed afterwards. Buyers pay in a USD stablecoin and the money goes straight to the
///         payout wallet in the same transaction: this contract never holds funds. New songs start closed.
contract HoodRichSongs is ERC1155, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Song {
        uint128 price; // in payToken units (USDG has 6 decimals)
        uint32 cap;
        uint32 minted;
        bool open;
        bool frozen;
        string metadataURI;
    }

    IERC20 public immutable payToken;
    address public immutable payout;
    uint256 public songCount;
    mapping(uint256 => Song) private _songs;

    event SongAdded(uint256 indexed id, uint256 price, uint256 cap, string metadataURI);
    event SongOpen(uint256 indexed id, bool open);
    event SongMetadata(uint256 indexed id, string metadataURI);
    event SongFrozen(uint256 indexed id);
    event Bought(address indexed buyer, uint256 indexed id, uint256 price);

    error ZeroAddress();
    error NoSuchSong();
    error SongClosed();
    error SoldOut();
    error Frozen();
    error BadCap();

    constructor(address payToken_, address payout_, address owner_) ERC1155("") Ownable(owner_) {
        if (payToken_ == address(0) || payout_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        payToken = IERC20(payToken_);
        payout = payout_;
    }

    function addSong(uint128 price, uint32 cap, string calldata metadataURI) external onlyOwner returns (uint256 id) {
        if (cap == 0) revert BadCap();
        id = ++songCount;
        _songs[id] = Song(price, cap, 0, false, false, metadataURI);
        emit SongAdded(id, price, cap, metadataURI);
    }

    function setOpen(uint256 id, bool open_) external onlyOwner {
        _exists(id);
        _songs[id].open = open_;
        emit SongOpen(id, open_);
    }

    /// @notice Open or close several songs in one transaction.
    function setOpenMany(uint256[] calldata ids, bool open_) external onlyOwner {
        for (uint256 i; i < ids.length; ++i) {
            _exists(ids[i]);
            _songs[ids[i]].open = open_;
            emit SongOpen(ids[i], open_);
        }
    }

    function setSongURI(uint256 id, string calldata metadataURI) external onlyOwner {
        _exists(id);
        if (_songs[id].frozen) revert Frozen();
        _songs[id].metadataURI = metadataURI;
        emit SongMetadata(id, metadataURI);
    }

    function freezeSong(uint256 id) external onlyOwner {
        _exists(id);
        _songs[id].frozen = true;
        emit SongFrozen(id);
    }

    /// @notice Buy one copy of a song. The buyer must first approve the song's price of the pay token.
    function mint(uint256 id) external nonReentrant {
        _exists(id);
        Song storage s = _songs[id];
        if (!s.open) revert SongClosed();
        if (s.minted >= s.cap) revert SoldOut();
        s.minted += 1;
        payToken.safeTransferFrom(msg.sender, payout, s.price);
        _mint(msg.sender, id, 1, "");
        emit Bought(msg.sender, id, s.price);
    }

    function songInfo(uint256 id) external view returns (uint256 price, uint256 cap, uint256 minted, bool open, bool frozen, string memory metadataURI) {
        _exists(id);
        Song storage s = _songs[id];
        return (s.price, s.cap, s.minted, s.open, s.frozen, s.metadataURI);
    }

    function hasSong(address who, uint256 id) external view returns (bool) {
        return balanceOf(who, id) > 0;
    }

    function uri(uint256 id) public view override returns (string memory) {
        _exists(id);
        return _songs[id].metadataURI;
    }

    function _exists(uint256 id) private view {
        if (id == 0 || id > songCount) revert NoSuchSong();
    }
}
