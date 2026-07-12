// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  The Hooded 20 — STAGWIFHOOD NFT mint (Robinhood Chain) — LOCKABLE, TWO-MODE MINT
 *
 *  MINT MODES:
 *   • PICK  — choose a specific available token; pay its TIER price:
 *              Common 0.010 · Rare 0.015 · Epic 0.020 · Legendary 0.025 · Mythic 0.030 (owner-settable).
 *   • GAMBLE — flat 0.010; a rarity-WEIGHTED random draw picks one for you. Weights make the top
 *              tiers rare to hit (owner-settable). Both modes share one pool → no duplicates ever.
 *
 *  KEY FEATURE (must exist before minting — cannot be added later):
 *  lock-in-place staking. The staking contract ("locker") can lock/unlock a token; while locked the
 *  NFT is NON-TRANSFERABLE but STAYS IN THE HOLDER'S WALLET. No custody transfer. (ERC-5192 style.)
 *
 *  20 supply, ERC-2981 royalties, proceeds routed to the RevenueSplitter (default 90% pool / 10% owner).
 *  Free-mint allowlist lets whitelisted wallets mint at 0 cost (owner testing on mainnet).
 *
 *  ⚠️ Holds real funds and forfeits balances downstream. Get a review before mainnet.
 */

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract HoodedTwenty is ERC721Enumerable, ERC2981, Ownable, ReentrancyGuard {
    uint256 public constant MAX_SUPPLY = 20;

    // Tier of each token id (1..20), packed one byte per id. 0=Common 1=Rare 2=Epic 3=Legendary 4=Mythic.
    // Derived from the collection metadata (see manifest.json).
    bytes public constant TIERS =
        hex"0403000101030201020201000203000001030204"; // id1..id20

    uint256 public constant NUM_TIERS = 5;
    string[5] public TIER_NAMES = ["Common", "Rare", "Epic", "Legendary", "Mythic"];

    // ---- pricing / policy (owner-tunable) ----
    uint256[5] public tierPrice;     // pick price per tier (wei)
    uint256    public randomPrice;   // gamble price (wei)
    uint256[5] public tierWeight;    // gamble draw weight per tier (lower = rarer)
    uint256    public maxPerWallet = 2;
    bool       public mintActive;

    string  private _base;                 // https://stagwifhood.fun/assets/nft/stagwifhood/metadata/
    address payable public splitter;       // RevenueSplitter (or payout wallet)
    address public locker;                 // staking contract allowed to lock/unlock

    mapping(uint256 => bool) public locked;         // ERC-5192
    mapping(address => uint256) public mintedBy;
    mapping(address => uint256) public freeMints;   // allowlist: remaining free mints per wallet

    // ---- remaining-token pool (shared by both modes; weighted-random capable) ----
    uint256[] private _pool;                 // token ids not yet minted
    mapping(uint256 => uint256) private _pos; // id => (index in _pool)+1; 0 = minted/none
    uint256 public totalWeight;              // Σ tierWeight[tier] over remaining
    uint256 private _nonce;                  // draw entropy

    event Locked(uint256 tokenId);           // ERC-5192
    event Unlocked(uint256 tokenId);
    event Minted(address indexed to, uint256 indexed tokenId, uint8 tier, bool gamble, uint256 paid);

    constructor(string memory baseURI_, address payable _splitter, uint96 royaltyBps)
        ERC721("The Hooded 20", "HOOD20")
        Ownable(msg.sender)
    {
        _base = baseURI_;
        splitter = _splitter;
        if (_splitter != address(0)) _setDefaultRoyalty(_splitter, royaltyBps);

        // default pick prices: Common .01 → Mythic .03 (+.005/tier)
        tierPrice = [uint256(0.010 ether), 0.015 ether, 0.020 ether, 0.025 ether, 0.030 ether];
        randomPrice = 0.010 ether;
        // default gamble weights: top tiers rare (per-token weight, lower = rarer)
        tierWeight = [uint256(100), 60, 30, 10, 3];

        // seed the pool with ids 1..20 and accumulate their weights
        for (uint256 id = 1; id <= MAX_SUPPLY; id++) {
            _pool.push(id);
            _pos[id] = _pool.length;         // index+1
            totalWeight += tierWeight[_tier(id)];
        }
    }

    /* ---------------- views ---------------- */
    function _tier(uint256 id) internal pure returns (uint8) { return uint8(TIERS[id - 1]); }
    function tierOf(uint256 id) public pure returns (uint8) { require(id >= 1 && id <= MAX_SUPPLY, "bad id"); return _tier(id); }
    function priceOf(uint256 id) public view returns (uint256) { return tierPrice[tierOf(id)]; }
    function isAvailable(uint256 id) public view returns (bool) { return id >= 1 && id <= MAX_SUPPLY && _pos[id] != 0; }
    function remaining() public view returns (uint256) { return _pool.length; }
    function remainingIds() external view returns (uint256[] memory) { return _pool; }
    function minted() external view returns (uint256) { return MAX_SUPPLY - _pool.length; }

    /* ---------------- mint ---------------- */
    // PICK: mint a specific available token at its tier price.
    function mintPick(uint256 tokenId) external payable nonReentrant {
        require(isAvailable(tokenId), "unavailable");
        _mintOne(tokenId, tierPrice[_tier(tokenId)], false);
    }

    // GAMBLE: pay the flat random price; a rarity-weighted draw assigns a token.
    function mintRandom() external payable nonReentrant {
        require(_pool.length > 0, "sold out");
        uint256 id = _drawWeighted();
        _mintOne(id, randomPrice, true);
    }

    function _mintOne(uint256 id, uint256 price, bool gamble) internal {
        // EOA-only: blocks a contract from grinding onERC721Received for rare ids and removes
        // the _safeMint reentrancy surface. (Trade-off: smart-contract wallets can't mint.)
        require(msg.sender == tx.origin, "no contracts");
        require(mintActive, "mint not active");

        // free-mint allowlist (owner testing / reserves): consumes an allowance, price = 0, and
        // bypasses the per-wallet cap so an owner-granted allowance is fully usable.
        bool isFree = freeMints[msg.sender] > 0;
        if (isFree) freeMints[msg.sender] -= 1;
        else require(mintedBy[msg.sender] < maxPerWallet, "wallet limit");
        uint256 due = isFree ? 0 : price;
        require(msg.value >= due, "fee too low");

        // effects (CEI)
        mintedBy[msg.sender] += 1;
        _take(id);
        _safeMint(msg.sender, id);
        emit Minted(msg.sender, id, _tier(id), gamble, due);

        // forward exactly `due` to the splitter. BEST-EFFORT: a reverting/mis-set splitter must
        // not be able to brick minting — on failure the ETH stays here, recoverable via withdrawETH.
        if (due > 0 && splitter != address(0)) { (bool ok, ) = splitter.call{value: due}(""); ok; }
        // refund any overpayment to the minter
        uint256 over = msg.value - due;
        if (over > 0) { (bool r, ) = payable(msg.sender).call{value: over}(""); require(r, "refund failed"); }
    }

    // weighted random over the remaining pool: rarer tiers have lower weight → less likely.
    // NOTE: on-chain entropy on an L2 is influenceable by the sequencer/searcher who orders txs.
    // For a 20-piece art mint this is an accepted trade-off; tiered PICK pricing bounds the
    // incentive to snipe rares via GAMBLE. Use PICK-only (setTierWeight aside) if that matters.
    function _drawWeighted() internal returns (uint256) {
        require(totalWeight > 0, "no weight");
        uint256 r = uint256(keccak256(abi.encodePacked(
            blockhash(block.number - 1), block.prevrandao, block.timestamp,
            msg.sender, _pool.length, totalWeight, address(this).balance, _nonce++
        ))) % totalWeight;
        uint256 cum = 0;
        uint256 n = _pool.length;
        for (uint256 i = 0; i < n; i++) {
            cum += tierWeight[_tier(_pool[i])];
            if (r < cum) return _pool[i];
        }
        return _pool[n - 1]; // rounding fallback (unreachable when totalWeight is exact)
    }

    // remove a token id from the pool (swap-pop) and decrement totalWeight.
    function _take(uint256 id) internal {
        uint256 idx = _pos[id] - 1;
        uint256 lastIdx = _pool.length - 1;
        uint256 lastId = _pool[lastIdx];
        _pool[idx] = lastId;
        _pos[lastId] = idx + 1;
        _pool.pop();
        _pos[id] = 0;
        totalWeight -= tierWeight[_tier(id)];
    }

    /* ---------------- lock-in-place (only the staking contract) ---------------- */
    modifier onlyLocker() { require(msg.sender == locker && locker != address(0), "not locker"); _; }
    function lock(uint256 tokenId) external onlyLocker { locked[tokenId] = true; emit Locked(tokenId); }
    function unlock(uint256 tokenId) external onlyLocker { locked[tokenId] = false; emit Unlocked(tokenId); }
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
    function setTierPrice(uint8 tier, uint256 v) external onlyOwner { require(tier < NUM_TIERS, "tier"); tierPrice[tier] = v; }
    function setRandomPrice(uint256 v) external onlyOwner { randomPrice = v; }
    function setTierWeight(uint8 tier, uint256 v) external onlyOwner {
        require(tier < NUM_TIERS, "tier");
        require(v > 0, "weight=0"); // never let a tier hit 0 weight (would brick the gamble draw)
        // keep totalWeight consistent for tokens of this tier still in the pool
        uint256 old = tierWeight[tier];
        if (v != old) {
            uint256 n = _pool.length;
            for (uint256 i = 0; i < n; i++) {
                if (_tier(_pool[i]) == tier) { totalWeight = totalWeight - old + v; }
            }
            tierWeight[tier] = v;
        }
    }
    function setMaxPerWallet(uint256 v) external onlyOwner { maxPerWallet = v; }
    function setBaseURI(string calldata v) external onlyOwner { _base = v; }
    function setLocker(address v) external onlyOwner { locker = v; }
    function setSplitter(address payable v) external onlyOwner { splitter = v; }
    function setRoyalty(address receiver, uint96 bps) external onlyOwner { _setDefaultRoyalty(receiver, bps); }
    function grantFreeMints(address wallet, uint256 count) external onlyOwner { freeMints[wallet] = count; }
    // recover any ETH stuck here (e.g. a mint while splitter was unset) — normally 0
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
