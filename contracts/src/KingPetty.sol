// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*  KING PETTY — 200-supply edition NFT (Robinhood Chain, chainId 4663)
 *
 *  • Max supply hard-capped at 200.
 *  • You (owner) mint for FREE via ownerMint() — from a hidden page or directly. No public
 *    listing anywhere; it only shows in a holder's wallet. Fully transferable (standard ERC-721),
 *    so you can send them to any wallet.
 *  • Optional public sale can be switched on later (setSale) if you ever want others to mint.
 *  • Metadata is fully ON-CHAIN (data URI) — nothing hosted on any website. The only off-chain
 *    piece is the artwork, referenced by an IPFS URI set at deploy.
 */

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract KingPetty is ERC721, Ownable {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = 200;
    uint256 public totalMinted;
    string  public imageURI;          // ipfs://<CID> of the art (only off-chain piece)

    // optional public sale (off by default — you mint free via ownerMint)
    bool    public saleOpen;
    uint256 public price;
    uint256 public maxPerTx = 10;

    constructor(string memory _imageURI)
        ERC721("King Petty", "PETTY")
        Ownable(msg.sender)
    {
        imageURI = _imageURI;
    }

    // ---- minting ----
    function _mintMany(address to, uint256 qty) internal {
        require(qty > 0, "qty=0");
        require(totalMinted + qty <= MAX_SUPPLY, "sold out");
        for (uint256 i = 0; i < qty; i++) { _mint(to, ++totalMinted); } // ids 1..200
    }

    /// @notice FREE mint for the owner (you). Use this from the hidden page or directly.
    function ownerMint(address to, uint256 qty) external onlyOwner {
        _mintMany(to == address(0) ? msg.sender : to, qty);
    }

    /// @notice Public mint — only if you switch the sale on. Off by default.
    function mint(uint256 qty) external payable {
        require(saleOpen, "sale closed");
        require(qty <= maxPerTx, "over max/tx");
        require(msg.value >= price * qty, "underpaid");
        _mintMany(msg.sender, qty);
    }

    // ---- owner config ----
    function setSale(bool open, uint256 price_, uint256 maxPerTx_) external onlyOwner {
        saleOpen = open; price = price_; if (maxPerTx_ > 0) maxPerTx = maxPerTx_;
    }
    function setImageURI(string calldata _imageURI) external onlyOwner {
        imageURI = _imageURI; emit BatchMetadataUpdate(1, MAX_SUPPLY);
    }
    function withdraw(address to) external onlyOwner {
        (bool ok, ) = payable(to).call{value: address(this).balance}(""); require(ok, "withdraw failed");
    }

    // ---- fully on-chain metadata ----
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        bytes memory json = abi.encodePacked(
            '{"name":"King Petty #', tokenId.toString(), ' \\u2014 FU Hater",',
            '"description":"King Petty rides the neon Sherwood in a vine-wrapped emerald hypercar, bow slung, hood up, middle finger to every orc and hater in the rearview. The stolen hood of Robin Hood, worn like a crown. FU Hater. $STAGWIFHOOD.",',
            '"image":"', imageURI, '",',
            '"external_url":"https://stagwifhood.fun",',
            '"attributes":[',
                '{"trait_type":"Character","value":"King Petty"},',
                '{"trait_type":"Hood","value":"Robin Hood Cap + Feather"},',
                '{"trait_type":"Weapon","value":"Compound Bow + Arrows"},',
                '{"trait_type":"Ride","value":"Vine-Wrapped Emerald Hypercar"},',
                '{"trait_type":"Plate","value":"KING PETTY"},',
                '{"trait_type":"Gesture","value":"FU Hater"},',
                '{"trait_type":"Background","value":"Cyberpunk Sherwood"},',
                '{"trait_type":"Eyes","value":"Emerald Glow"},',
                '{"trait_type":"Aura","value":"Neon Green"},',
                '{"trait_type":"Chain","value":"Robinhood Chain"},',
                '{"display_type":"number","trait_type":"Edition","value":', tokenId.toString(), ',"max_value":200}',
            ']}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @dev ERC-4906 signals so wallets/marketplaces refresh metadata.
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
}
