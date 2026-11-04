// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Stag House Records catalog: songs, albums, any artist
/// @notice One token id per song or album. The owner can keep adding items (any artist, any number) without
///         redeploying. Each item has its own price, a hard copy cap, its own artist wallet, and a label cut
///         (a percentage that goes to the label wallet), all fixed when the item is added. The owner can never
///         raise the label cut or redirect an artist's money later. Buyers pay in Robinhood Chain ETH and the ETH
///         is split between the label and the artist in the same transaction: this contract never holds funds.
///         New items start closed.
contract HoodRichSongs is ERC1155, Ownable2Step, ReentrancyGuard {
    struct Song {
        uint128 price; // in wei; the owner can update it as the ETH price moves
        uint32 cap;
        uint32 minted;
        bool open;
        bool frozen;
        uint16 labelBps; // label's cut in basis points (100 = 1%), locked when the item is added
        address payout; // the artist wallet: gets the rest of the ETH
        string metadataURI;
    }

    uint16 public constant MAX_LABEL_BPS = 5000; // a label cut can never be set above 50%
    address public labelWallet; // receives the label's cut
    uint256 public songCount;
    mapping(uint256 => Song) private _songs;

    event SongAdded(uint256 indexed id, uint256 price, uint256 cap, address indexed payout, uint256 labelBps, string metadataURI);
    event LabelWalletChanged(address indexed oldWallet, address indexed newWallet);
    event PayoutChanged(uint256 indexed id, address indexed oldPayout, address indexed newPayout);
    event SongPrice(uint256 indexed id, uint256 price);
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
    error WrongPayment();
    error RenounceDisabled();
    error PayoutFailed();
    error NotPayee();
    error CutTooHigh();

    constructor(address owner_, address labelWallet_) ERC1155("") Ownable(owner_) {
        if (owner_ == address(0) || labelWallet_ == address(0)) revert ZeroAddress();
        labelWallet = labelWallet_;
    }

    function setLabelWallet(address w) external onlyOwner {
        if (w == address(0)) revert ZeroAddress();
        emit LabelWalletChanged(labelWallet, w);
        labelWallet = w;
    }

    /// @notice Add a new song or album for any artist. `payout_` is the wallet that receives the ETH for this item.
    function addSong(uint128 price, uint32 cap, address payout_, uint16 labelBps, string calldata metadataURI) external onlyOwner returns (uint256 id) {
        if (cap == 0) revert BadCap();
        if (labelBps > MAX_LABEL_BPS) revert CutTooHigh();
        if (payout_ == address(0)) revert ZeroAddress();
        id = ++songCount;
        _songs[id] = Song(price, cap, 0, false, false, labelBps, payout_, metadataURI);
        emit SongAdded(id, price, cap, payout_, labelBps, metadataURI);
    }

    /// @notice The current payout wallet of an item can hand its earnings to a new wallet (for example if the
    ///         artist gets a new wallet). Nobody else, including the owner, can change where an item pays.
    function changePayout(uint256 id, address newPayout) external {
        _exists(id);
        if (msg.sender != _songs[id].payout) revert NotPayee();
        if (newPayout == address(0)) revert ZeroAddress();
        emit PayoutChanged(id, msg.sender, newPayout);
        _songs[id].payout = newPayout;
    }

    /// @dev Renouncing ownership would permanently lock the sale (no pause, no price change), so it is disabled.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function setPrice(uint256 id, uint128 price) external onlyOwner {
        _exists(id);
        _songs[id].price = price;
        emit SongPrice(id, price);
    }

    function setOpen(uint256 id, bool open_) external onlyOwner {
        _exists(id);
        _songs[id].open = open_;
        emit SongOpen(id, open_);
    }

    /// @notice Open or close several items in one transaction.
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

    /// @notice Buy one copy by sending exactly the item's price in ETH. The ETH goes straight to the payout wallet.
    ///         If the owner changes the price while a buyer's transaction is pending, it reverts and nothing is charged.
    function mint(uint256 id) external payable nonReentrant {
        _exists(id);
        Song storage s = _songs[id];
        if (!s.open) revert SongClosed();
        if (s.minted >= s.cap) revert SoldOut();
        if (msg.value != s.price) revert WrongPayment();
        s.minted += 1;
        uint256 cut = (msg.value * s.labelBps) / 10_000; // label's share, rounded down; the artist gets the rest
        if (cut > 0) {
            (bool okLabel,) = labelWallet.call{value: cut}("");
            if (!okLabel) revert PayoutFailed();
        }
        (bool ok,) = s.payout.call{value: msg.value - cut}("");
        if (!ok) revert PayoutFailed();
        _mint(msg.sender, id, 1, "");
        emit Bought(msg.sender, id, msg.value);
    }

    function songInfo(uint256 id) external view returns (uint256 price, uint256 cap, uint256 minted, bool open, bool frozen, string memory metadataURI) {
        _exists(id);
        Song storage s = _songs[id];
        return (s.price, s.cap, s.minted, s.open, s.frozen, s.metadataURI);
    }

    function labelBpsOf(uint256 id) external view returns (uint256) {
        _exists(id);
        return _songs[id].labelBps;
    }

    function payoutOf(uint256 id) external view returns (address) {
        _exists(id);
        return _songs[id].payout;
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
