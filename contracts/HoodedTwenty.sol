// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  The Hooded 20 — STAGWIFHOOD NFT mint (Robinhood Chain) — LOCKABLE
 *
 *  KEY FEATURE (must exist before minting — cannot be added later):
 *  lock-in-place staking. The staking contract ("locker") can lock/unlock a
 *  token; while locked the NFT is NON-TRANSFERABLE but STAYS IN THE HOLDER'S
 *  WALLET. No custody transfer — nobody can move a holder's NFT. (ERC-5192 style.)
 *
 *  Also: 20 supply, random no-duplicate draw, ERC-2981 royalties, and mint
 *  proceeds routed to the RevenueSplitter (60% pool / 40% owner).
 *
 *  ⚠️ Holds real funds. Test on Robinhood Chain testnet (46630), review before mainnet.
 */

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract HoodedTwenty is ERC721Enumerable, ERC2981, Ownable {
    uint256 public constant MAX_SUPPLY = 20;

    uint256 public mintPrice;            // native ETH per mint (wei). 0 = free.
    uint256 public maxPerWallet = 2;
    bool    public mintActive;
    string  private _base;               // https://stagwifhood.fun/assets/nft/stagwifhood/metadata/
    address payable public splitter;     // RevenueSplitter — receives 100% of proceeds, then splits 60/40
    address public locker;               // staking contract allowed to lock/unlock

    mapping(uint256 => bool) public locked;     // ERC-5192: is the token locked?
    mapping(address => uint256) public mintedBy;

    // random-without-duplicates state (Fisher–Yates on demand)
    uint256 private _remaining = MAX_SUPPLY;
    mapping(uint256 => uint256) private _slot;

    event Locked(uint256 tokenId);       // ERC-5192
    event Unlocked(uint256 tokenId);     // ERC-5192

    constructor(uint256 _price, string memory baseURI_, address payable _splitter, uint96 royaltyBps)
        ERC721("The Hooded 20", "HOOD20")
        Ownable(msg.sender)
    {
        mintPrice = _price;
        _base = baseURI_;
        splitter = _splitter;
        if (_splitter != address(0)) _setDefaultRoyalty(_splitter, royaltyBps); // royalties also split 60/40
    }

    /* ---------------- mint ---------------- */
    function mint() external payable {
        // EOA-only: blocks a contract from reverting in onERC721Received to grind for rare
        // ids (rarity → staking yield), and removes the _safeMint reentrancy surface entirely.
        require(msg.sender == tx.origin, "no contracts");
        require(mintActive, "mint not active");
        require(_remaining > 0, "sold out");
        require(msg.value >= mintPrice, "fee too low");
        require(mintedBy[msg.sender] < maxPerWallet, "wallet limit");
        mintedBy[msg.sender] += 1;
        uint256 id = _draw();
        _safeMint(msg.sender, id);
        if (splitter != address(0) && msg.value > 0) {
            (bool ok, ) = splitter.call{value: msg.value}("");   // splitter splits 60/40 on receive
            require(ok, "split failed");
        }
    }

    function _draw() internal returns (uint256) {
        uint256 r = uint256(keccak256(abi.encodePacked(block.prevrandao, block.timestamp, msg.sender, _remaining))) % _remaining;
        uint256 last = _remaining - 1;
        uint256 picked = _slot[r] == 0 ? r : _slot[r];
        uint256 lastVal = _slot[last] == 0 ? last : _slot[last];
        _slot[r] = lastVal;
        _remaining = last;
        return picked + 1;   // ids 1..20
    }

    function minted() external view returns (uint256) { return MAX_SUPPLY - _remaining; }

    /* ---------------- lock-in-place (only the staking contract) ---------------- */
    modifier onlyLocker() { require(msg.sender == locker && locker != address(0), "not locker"); _; }
    function lock(uint256 tokenId) external onlyLocker { locked[tokenId] = true; emit Locked(tokenId); }
    function unlock(uint256 tokenId) external onlyLocker { locked[tokenId] = false; emit Unlocked(tokenId); }
    // emergency escape so a staked NFT can never be permanently frozen (e.g. after a locker
    // migration, when the old staking contract can no longer unlock). Owner-only.
    function adminUnlock(uint256 tokenId) external onlyOwner { locked[tokenId] = false; emit Unlocked(tokenId); }

    // block transfers of a locked token; mint (from==0) and burn (to==0) still allowed
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) require(!locked[tokenId], "locked (staked)");
        return super._update(to, tokenId, auth);
    }

    /* ---------------- metadata ---------------- */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string(abi.encodePacked(_base, _toString(tokenId), ".json"));
    }

    /* ---------------- owner ---------------- */
    function setMintActive(bool v) external onlyOwner { mintActive = v; }
    function setMintPrice(uint256 v) external onlyOwner { mintPrice = v; }
    function setMaxPerWallet(uint256 v) external onlyOwner { maxPerWallet = v; }
    function setBaseURI(string calldata v) external onlyOwner { _base = v; }
    function setLocker(address v) external onlyOwner { locker = v; }
    function setSplitter(address payable v) external onlyOwner { splitter = v; }
    function setRoyalty(address receiver, uint96 bps) external onlyOwner { _setDefaultRoyalty(receiver, bps); }
    // recover any ETH that got stuck here (e.g. a mint while splitter was unset) — normally 0
    function withdrawETH(address to) external onlyOwner { (bool ok, ) = payable(to).call{value: address(this).balance}(""); require(ok, "eth send failed"); }

    /* ---------------- plumbing ---------------- */
    function supportsInterface(bytes4 id) public view override(ERC721Enumerable, ERC2981) returns (bool) {
        return id == 0xb45a3c0e /* ERC-5192 */ || super.supportsInterface(id);
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v; uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { len--; b[len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
