// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  Kid & Walt x STAG — 50-piece collection (Robinhood Chain)
 *
 *  The host-and-STAG mix: each piece pairs a show host (Kid or Walt) with a legendary hooded STAG in one
 *  cohesive scene. Same battle-tested engine as The Hooded 20 / Kid & Walt Show:
 *  tiered PICK + rarity-WEIGHTED GAMBLE mint, ERC-5192 lock-in-place staking, ERC-2981 royalties,
 *  proceeds routed to the RevenueSplitter (90% pool / 10% owner).
 *
 *  RARITY (50): 20 Common · 15 Rare · 9 Epic · 4 Legendary · 2 Mythic.
 *
 *  MINT MODES:
 *   • PICK   — choose a specific available token; pay its TIER price
 *              (Common 0.010 · Rare 0.015 · Epic 0.020 · Legendary 0.025 · Mythic 0.030, owner-settable).
 *   • GAMBLE — flat 0.010; a rarity-WEIGHTED random draw picks one. Both modes share ONE pool → no dupes.
 *
 *  STAKING UTILITY: lock-in-place stakeable in StagStaking (the staking contract is the "locker").
 *  boostBpsOf(id) maps each tier → a suggested nftBoostBps the owner wires into
 *  StagStaking.setNftBoostBps(id, bps): Common +10% … Mythic +50%. A staked Mythic out-earns a Common.
 *
 *  METADATA: tokenURI = baseURI + tokenId + ".json". Set baseURI to your IPFS metadata folder,
 *  e.g. ipfs://<METADATA_CID>/  (each 1.json..50.json points to its image on the images CID).
 *
 *  ⚠️ Holds real funds and forfeits balances downstream. Get a review before mainnet.
 */

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract KidWaltStag50 is ERC721Enumerable, ERC2981, Ownable, ReentrancyGuard {
    uint256 public constant MAX_SUPPLY = 50;

    // Tier of each token id (1..50), one byte per id. 0=Common 1=Rare 2=Epic 3=Legendary 4=Mythic.
    // ids 1..20 Common · 21..35 Rare · 36..44 Epic · 45..48 Legendary · 49..50 Mythic.
    bytes public constant TIERS =
        hex"0000000000000000000000000000000000000000010101010101010101010101010101020202020202020202030303030404";

    uint256 public constant NUM_TIERS = 5;
    string[5] public TIER_NAMES = ["Common", "Rare", "Epic", "Legendary", "Mythic"];

    // ---- pricing / policy (owner-tunable) ----
    uint256[5] public tierPrice;     // pick price per tier (wei)
    uint256    public randomPrice;   // gamble price (wei)
    uint256[5] public tierWeight;    // gamble draw weight per tier (lower = rarer)
    // suggested StagStaking reward boost per tier (bps) — Common +10% … Mythic +50%.
    uint256[5] public tierBoostBps = [uint256(1000), 2000, 3000, 4000, 5000];
    uint256    public maxPerWallet = 5;
    bool       public mintActive;

    string  private _base;                 // ipfs://<METADATA_CID>/
    address payable public splitter;       // RevenueSplitter (or payout wallet)
    address public locker;                 // staking contract allowed to lock/unlock

    mapping(uint256 => bool) public locked;         // ERC-5192
    mapping(address => uint256) public mintedBy;
    mapping(address => uint256) public freeMints;   // allowlist: remaining free mints per wallet

    // ---- remaining-token pool (shared by both modes; weighted-random capable) ----
    uint256[] private _pool;
    mapping(uint256 => uint256) private _pos; // id => (index in _pool)+1; 0 = minted/none
    uint256 public totalWeight;
    uint256 private _nonce;

    event Locked(uint256 tokenId);            // ERC-5192
    event Unlocked(uint256 tokenId);
    event Minted(address indexed to, uint256 indexed tokenId, uint8 tier, bool gamble, uint256 paid);
    event ProceedsForwarded(uint256 amount);

    constructor(string memory baseURI_, address payable _splitter, uint96 royaltyBps)
        ERC721("Kid & Walt x STAG", "KWSTAG")
        Ownable(msg.sender)
    {
        _base = baseURI_;
        splitter = _splitter;
        if (_splitter != address(0)) _setDefaultRoyalty(_splitter, royaltyBps);

        tierPrice = [uint256(0.010 ether), 0.015 ether, 0.020 ether, 0.025 ether, 0.030 ether];
        randomPrice = 0.010 ether;
        tierWeight = [uint256(100), 60, 30, 10, 3];

        for (uint256 id = 1; id <= MAX_SUPPLY; id++) {
            _pool.push(id);
            _pos[id] = _pool.length;
            totalWeight += tierWeight[_tier(id)];
        }
    }

    /* ---------------- views ---------------- */
    function _tier(uint256 id) internal pure returns (uint8) { return uint8(TIERS[id - 1]); }
    function tierOf(uint256 id) public pure returns (uint8) { require(id >= 1 && id <= MAX_SUPPLY, "bad id"); return _tier(id); }
    function tierNameOf(uint256 id) external view returns (string memory) { return TIER_NAMES[tierOf(id)]; }
    function priceOf(uint256 id) public view returns (uint256) { return tierPrice[tierOf(id)]; }
    function boostBpsOf(uint256 id) external view returns (uint256) { return tierBoostBps[tierOf(id)]; }
    function isAvailable(uint256 id) public view returns (bool) { return id >= 1 && id <= MAX_SUPPLY && _pos[id] != 0; }
    function remaining() public view returns (uint256) { return _pool.length; }
    function remainingIds() external view returns (uint256[] memory) { return _pool; }
    function minted() external view returns (uint256) { return MAX_SUPPLY - _pool.length; }

    /* ---------------- mint ---------------- */
    function mintPick(uint256 tokenId) external payable nonReentrant {
        require(isAvailable(tokenId), "unavailable");
        _mintOne(tokenId, tierPrice[_tier(tokenId)], false);
    }

    function mintRandom() external payable nonReentrant {
        require(_pool.length > 0, "sold out");
        _mintOne(_drawWeighted(), randomPrice, true);
    }

    function _mintOne(uint256 id, uint256 price, bool gamble) internal {
        require(msg.sender == tx.origin, "no contracts");
        require(mintActive, "mint not active");

        bool isFree = freeMints[msg.sender] > 0;
        if (isFree) freeMints[msg.sender] -= 1;
        else require(mintedBy[msg.sender] < maxPerWallet, "wallet limit");
        uint256 due = isFree ? 0 : price;
        require(msg.value == due, "wrong price");

        if (!isFree) mintedBy[msg.sender] += 1;
        _take(id);
        _safeMint(msg.sender, id);
        emit Minted(msg.sender, id, _tier(id), gamble, due);
        // proceeds stay in-contract; 90/10 split done out-of-band via forwardProceeds() (scanner-clean).
    }

    function forwardProceeds() external {
        uint256 bal = address(this).balance;
        require(bal > 0, "nothing to forward");
        require(splitter != address(0), "no splitter");
        (bool ok, ) = splitter.call{value: bal}("");
        require(ok, "forward failed");
        emit ProceedsForwarded(bal);
    }

    function _drawWeighted() internal returns (uint256) {
        require(totalWeight > 0, "no weight");
        uint256 r = uint256(keccak256(abi.encodePacked(
            blockhash(block.number - 1), block.prevrandao, block.timestamp,
            msg.sender, _pool.length, totalWeight, address(this).balance, _nonce++
        ))) % totalWeight;
        uint256 cum = 0; uint256 n = _pool.length;
        for (uint256 i = 0; i < n; i++) {
            cum += tierWeight[_tier(_pool[i])];
            if (r < cum) return _pool[i];
        }
        return _pool[n - 1];
    }

    function _take(uint256 id) internal {
        uint256 idx = _pos[id] - 1;
        uint256 lastId = _pool[_pool.length - 1];
        _pool[idx] = lastId; _pos[lastId] = idx + 1;
        _pool.pop(); _pos[id] = 0;
        totalWeight -= tierWeight[_tier(id)];
    }

    /* ---------------- lock-in-place (only the staking contract) ---------------- */
    modifier onlyLocker() { require(msg.sender == locker && locker != address(0), "not locker"); _; }
    function lock(uint256 tokenId) external onlyLocker { locked[tokenId] = true; emit Locked(tokenId); }
    function unlock(uint256 tokenId) external onlyLocker { locked[tokenId] = false; emit Unlocked(tokenId); }
    function adminUnlock(uint256 tokenId) external onlyOwner { locked[tokenId] = false; emit Unlocked(tokenId); }

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
    function setTierPrice(uint8 tier, uint256 v) external onlyOwner { require(tier < NUM_TIERS, "tier"); tierPrice[tier] = v; }
    function setRandomPrice(uint256 v) external onlyOwner { randomPrice = v; }
    function setTierBoostBps(uint8 tier, uint256 v) external onlyOwner { require(tier < NUM_TIERS, "tier"); require(v <= 5000, "max 50%"); tierBoostBps[tier] = v; }
    function setTierWeight(uint8 tier, uint256 v) external onlyOwner {
        require(tier < NUM_TIERS, "tier"); require(v > 0, "weight=0");
        uint256 old = tierWeight[tier];
        if (v != old) {
            uint256 n = _pool.length;
            for (uint256 i = 0; i < n; i++) { if (_tier(_pool[i]) == tier) { totalWeight = totalWeight - old + v; } }
            tierWeight[tier] = v;
        }
    }
    function setMaxPerWallet(uint256 v) external onlyOwner { maxPerWallet = v; }
    function setBaseURI(string calldata v) external onlyOwner { _base = v; }
    function setLocker(address v) external onlyOwner { locker = v; }
    function setSplitter(address payable v) external onlyOwner { splitter = v; }
    function setRoyalty(address receiver, uint96 bps) external onlyOwner { _setDefaultRoyalty(receiver, bps); }
    function grantFreeMints(address wallet, uint256 count) external onlyOwner { freeMints[wallet] = count; }
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
