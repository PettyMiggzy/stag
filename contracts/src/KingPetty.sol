// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*  KING PETTY — a 1-of-1 NFT (Robinhood Chain, chainId 4663)
 *
 *  Mints exactly ONE token (id 1) to the owner at deploy. tokenURI points at the
 *  hosted metadata JSON (which points at the art). Standard ERC-721, so it shows +
 *  trades on any marketplace. Supply is hard-capped at 1 — no further mints possible.
 *
 *  Metadata:  https://stagwifhood.fun/assets/nft/king-petty.json
 *  Art:       https://stagwifhood.fun/assets/nft/king-petty.png
 */

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract KingPetty is ERC721, Ownable {
    uint256 public constant TOKEN_ID = 1;
    string private _uri;

    constructor(address to, string memory metadataURI)
        ERC721("King Petty", "PETTY")
        Ownable(msg.sender)
    {
        _uri = metadataURI;
        _mint(to == address(0) ? msg.sender : to, TOKEN_ID); // the one and only mint
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _uri;
    }

    /// @notice Owner can re-point metadata if hosting moves (e.g. site → IPFS). Emits so it's auditable.
    function setTokenURI(string calldata metadataURI) external onlyOwner {
        _uri = metadataURI;
        emit MetadataUpdate(TOKEN_ID);
    }

    /// @dev ERC-4906 metadata-update signal so marketplaces refresh.
    event MetadataUpdate(uint256 _tokenId);
}
