// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// Plain ERC-721 for custody-staking tests.
contract MockNFT is ERC721 {
    constructor() ERC721("Mock NFT", "MOCK") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}

/// ERC-721 with lock-in-place (ERC-5192 style): a designated locker can lock/unlock; a locked
/// token cannot be transferred but stays in the owner's wallet.
contract MockLockableNFT is ERC721 {
    address public locker;
    mapping(uint256 => bool) public locked;
    constructor() ERC721("Mock Lockable", "MLOCK") {}
    function setLocker(address l) external { locker = l; }
    function mint(address to, uint256 id) external { _mint(to, id); }
    function lock(uint256 id) external { require(msg.sender == locker, "not locker"); locked[id] = true; }
    function unlock(uint256 id) external { require(msg.sender == locker, "not locker"); locked[id] = false; }
    function _update(address to, uint256 id, address auth) internal override returns (address) {
        if (locked[id]) { address from = _ownerOf(id); if (from != address(0) && to != address(0)) revert("locked"); }
        return super._update(to, id, auth);
    }
}
