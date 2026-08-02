// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*  KING PETTY — a private 1-of-1 NFT (Robinhood Chain, chainId 4663)
 *
 *  Fully on-chain metadata: the name, description and traits live IN the contract and are
 *  returned as a data: URI — so NOTHING is hosted on any website. The only off-chain asset is
 *  the artwork itself, referenced by an IPFS URI (ipfs://…) set at deploy. Not listed anywhere;
 *  only whoever holds token #1 sees it in their wallet. Supply hard-capped at 1.
 */

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

contract KingPetty is ERC721, Ownable {
    uint256 public constant TOKEN_ID = 1;
    string public imageURI; // ipfs://<CID> of the art (only off-chain piece)

    constructor(address to, string memory _imageURI)
        ERC721("King Petty", "PETTY")
        Ownable(msg.sender)
    {
        imageURI = _imageURI;
        _mint(to == address(0) ? msg.sender : to, TOKEN_ID);
    }

    /// @notice Owner can re-point the art (e.g. new IPFS pin). Metadata/traits stay on-chain.
    function setImageURI(string calldata _imageURI) external onlyOwner {
        imageURI = _imageURI;
        emit MetadataUpdate(TOKEN_ID);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        bytes memory json = abi.encodePacked(
            '{"name":"King Petty \\u2014 FU Hater",',
            '"description":"One of one. King Petty rides the neon Sherwood in a vine-wrapped emerald hypercar, bow slung, hood up, middle finger to every orc and hater in the rearview. The stolen hood of Robin Hood, worn like a crown. FU Hater. $STAGWIFHOOD.",',
            '"image":"', imageURI, '",',
            '"external_url":"https://stagwifhood.fun",',
            '"attributes":[',
                '{"trait_type":"Rarity","value":"1 of 1"},',
                '{"trait_type":"Character","value":"King Petty"},',
                '{"trait_type":"Hood","value":"Robin Hood Cap + Feather"},',
                '{"trait_type":"Weapon","value":"Compound Bow + Arrows"},',
                '{"trait_type":"Ride","value":"Vine-Wrapped Emerald Hypercar"},',
                '{"trait_type":"Plate","value":"KING PETTY"},',
                '{"trait_type":"Gesture","value":"FU Hater"},',
                '{"trait_type":"Background","value":"Cyberpunk Sherwood"},',
                '{"trait_type":"Eyes","value":"Emerald Glow"},',
                '{"trait_type":"Aura","value":"Neon Green"},',
                '{"trait_type":"Collection","value":"The Hooded 20 \\u2014 1/1s"},',
                '{"trait_type":"Chain","value":"Robinhood Chain"}',
            ']}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @dev ERC-4906 metadata-update signal so wallets/marketplaces refresh.
    event MetadataUpdate(uint256 _tokenId);
}
