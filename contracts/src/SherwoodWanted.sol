// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*  WANTED — STAGWIFHOOD's 21-piece, animated 1/1 "outlaws of Sherwood" drop (Robinhood Chain 4663).
 *  Every piece is a WANTED poster: a hooded stag outlaw with a real $STAG bounty the holder claims
 *  on-chain (via the separate WantedBounty contract). Sits alongside the Sherwood Saints.
 *
 *  • LOCK-IN-PLACE STAKING (ERC-5192): the SherwoodVault (the "locker") can lock/unlock a token for
 *    staking; the NFT NEVER leaves the holder's wallet, so ownerOf stays the holder and the $STAG
 *    bounty remains claimable while staked. (Do NOT add this to the vault as custody mode.)
 *
 *  • Supply: 21 (token ids 1..21, every one a 1/1). Ids 1-7 Mythic whales, 8-11 Legendary,
 *    12-16 Epic, 17-21 Rare (see the hosted metadata / roster).
 *  • Mint: PICK a specific available outlaw and pay its price. Price is flat by default
 *    (mintPrice) OR per-token via tokenPrice[id] (lets you charge more for the Mythics) —
 *    priceOf(id) returns the override if set, else the flat price. No rebuild to switch models.
 *  • ERC-2981 royalties on secondary; proceeds routed to a splitter (buy-burn / pool / team),
 *    same scanner-safe pattern as the Saints.
 *  • Free-mint allowlist (owner reserves / gifting).
 *
 *  SCANNER-SAFE: the signed mint tx pays ONLY this contract (single recipient) — no ETH fan-out
 *  inside the user's tx. The split happens out-of-band via forwardProceeds().
 *
 *  The $STAG BOUNTY is NOT held here — it lives in WantedBounty.sol (funded with 87,000 $STAG,
 *  bountied per id, then locked). This contract is just the collection + mint.
 *
 *  ⚠️ Holds real funds. Audited + tested before mainnet.
 */

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract SherwoodWanted is ERC721Enumerable, ERC2981, Ownable, ReentrancyGuard {
    using Strings for uint256;
    uint256 public constant MAX_SUPPLY = 21; // token ids 1..21, all 1/1

    // ---- pricing / policy (owner-tunable) ----
    uint256 public mintPrice = 0.02 ether;      // flat fallback price per outlaw
    mapping(uint256 => uint256) public tokenPrice; // optional per-id override (0 = use flat mintPrice)
    uint256 public maxPerWallet = 3;            // anti-sweep (owner-settable)
    bool    public mintActive;

    string  private _base;                      // https://stagwifhood.fun/assets/nft/wanted/metadata/
    address payable public splitter;            // splitter (buy-burn / pool / team) or a payout wallet

    mapping(address => uint256) public mintedBy;
    mapping(address => uint256) public freeMints; // allowlist: remaining free mints per wallet

    // ---- lock-in-place staking (ERC-5192): the vault locks/unlocks; token never leaves the wallet ----
    address public locker;                     // SherwoodVault (staking) allowed to lock/unlock
    mapping(uint256 => bool) public locked;    // tokenId => staked/locked (blocks transfer)

    event Minted(address indexed to, uint256 indexed tokenId, uint256 pricePaid);
    event ProceedsForwarded(uint256 amount);
    event MintStateChanged(bool active);
    event PriceChanged(uint256 mintPrice);
    event TokenPriceChanged(uint256 indexed tokenId, uint256 price);
    event SplitterChanged(address splitter);
    event FreeMintsGranted(address indexed wallet, uint256 count);
    event Locked(uint256 indexed tokenId);     // ERC-5192
    event Unlocked(uint256 indexed tokenId);
    event LockerChanged(address locker);

    constructor(string memory baseURI, address royaltyReceiver, uint96 royaltyBps)
        ERC721("WANTED", "WANTED")
        Ownable(msg.sender)
    {
        _base = baseURI;
        if (royaltyReceiver != address(0)) _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    /* ---------------- mint ---------------- */

    /// @notice Mint a specific available outlaw (id 1..21) at its price (flat or per-id override).
    function mintPick(uint256 tokenId) external payable nonReentrant {
        require(isAvailable(tokenId), "unavailable");
        // EOA-only: removes the _safeMint reentrancy surface and contract-grinding (same as Saints/Hooded).
        require(msg.sender == tx.origin, "no contracts");
        require(mintActive, "mint not active");

        bool isFree = freeMints[msg.sender] > 0;
        if (isFree) freeMints[msg.sender] -= 1;
        else require(mintedBy[msg.sender] < maxPerWallet, "wallet limit");
        uint256 due = isFree ? 0 : priceOf(tokenId);
        require(msg.value == due, "wrong price"); // EXACT — no refund leg needed

        // effects (CEI). Free mints don't consume the paid per-wallet cap.
        if (!isFree) mintedBy[msg.sender] += 1;
        _safeMint(msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, due);

        // proceeds STAY here (scanner-safe). Forwarded out-of-band via forwardProceeds().
    }

    /// @notice Forward accumulated mint proceeds to the splitter. Permissionless, NOT part of any
    ///         user-signed mint — run from a keeper/cron/admin. Keeps the signed mint single-recipient.
    function forwardProceeds() external nonReentrant {
        uint256 bal = address(this).balance;
        require(bal > 0, "nothing to forward");
        require(splitter != address(0), "no splitter");
        (bool ok, ) = splitter.call{value: bal}("");
        require(ok, "forward failed");
        emit ProceedsForwarded(bal);
    }

    /* ---------------- views ---------------- */

    /// @notice Price to mint a given id: the per-id override if set, else the flat mintPrice.
    function priceOf(uint256 tokenId) public view returns (uint256) {
        uint256 p = tokenPrice[tokenId];
        return p > 0 ? p : mintPrice;
    }

    function isAvailable(uint256 tokenId) public view returns (bool) {
        return tokenId >= 1 && tokenId <= MAX_SUPPLY && _ownerOf(tokenId) == address(0);
    }

    /// @notice List of ids not yet minted.
    function availableIds() external view returns (uint256[] memory ids) {
        uint256 n;
        for (uint256 i = 1; i <= MAX_SUPPLY; i++) if (_ownerOf(i) == address(0)) n++;
        ids = new uint256[](n);
        uint256 j;
        for (uint256 i = 1; i <= MAX_SUPPLY; i++) if (_ownerOf(i) == address(0)) ids[j++] = i;
    }

    function _baseURI() internal view override returns (string memory) { return _base; }

    /// @notice tokenURI appends ".json" → .../wanted/metadata/<id>.json (marketplaces need the file path).
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string(abi.encodePacked(_base, tokenId.toString(), ".json"));
    }

    /* ---------------- admin (policy only) ---------------- */

    function setMintActive(bool active) external onlyOwner { mintActive = active; emit MintStateChanged(active); }
    function setMintPrice(uint256 price) external onlyOwner { mintPrice = price; emit PriceChanged(price); }

    /// @notice Set per-id prices (e.g. charge more for the Mythic whales). 0 clears the override → flat price.
    function setTokenPrices(uint256[] calldata ids, uint256[] calldata prices) external onlyOwner {
        require(ids.length == prices.length, "len");
        for (uint256 i; i < ids.length; ++i) { tokenPrice[ids[i]] = prices[i]; emit TokenPriceChanged(ids[i], prices[i]); }
    }

    function setMaxPerWallet(uint256 n) external onlyOwner { require(n > 0, "zero"); maxPerWallet = n; }
    function setBaseURI(string calldata baseURI) external onlyOwner { _base = baseURI; }
    function setSplitter(address payable s) external onlyOwner { require(s != address(0), "zero"); splitter = s; emit SplitterChanged(s); }
    function setRoyalty(address receiver, uint96 bps) external onlyOwner { _setDefaultRoyalty(receiver, bps); }

    /// @notice Rescue valve: send stuck ETH to `to`. Does not touch minted tokens.
    function withdrawETH(address to) external onlyOwner nonReentrant {
        require(to != address(0), "zero");
        uint256 bal = address(this).balance;
        require(bal > 0, "nothing");
        (bool ok, ) = payable(to).call{value: bal}("");
        require(ok, "send failed");
    }

    /// @notice Grant free mints (reserves / gifting). Bypasses the per-wallet cap and price.
    function grantFreeMints(address wallet, uint256 count) external onlyOwner {
        require(wallet != address(0), "zero");
        freeMints[wallet] += count;
        emit FreeMintsGranted(wallet, count);
    }

    /* ---------------- lock-in-place staking (only the vault/locker) ---------------- */

    modifier onlyLocker() { require(msg.sender == locker && locker != address(0), "not locker"); _; }

    /// @notice Vault locks a token when it's staked. Token stays in the holder's wallet (ownerOf
    ///         unchanged) so the $STAG bounty stays claimable; transfers are blocked until unlock.
    function lock(uint256 tokenId) external onlyLocker { require(_ownerOf(tokenId) != address(0), "nonexistent"); locked[tokenId] = true; emit Locked(tokenId); }
    function unlock(uint256 tokenId) external onlyLocker { locked[tokenId] = false; emit Unlocked(tokenId); }
    /// @notice Owner escape hatch if the vault ever mis-locks / is replaced (never traps a holder's NFT).
    function adminUnlock(uint256 tokenId) external onlyOwner { locked[tokenId] = false; emit Unlocked(tokenId); }
    function setLocker(address v) external onlyOwner { locker = v; emit LockerChanged(v); }

    /* ---------------- required overrides ---------------- */

    /// @dev Block transfers of a locked (staked) token. Mint (from==0) always allowed.
    function _update(address to, uint256 tokenId, address auth)
        internal override(ERC721Enumerable) returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) require(!locked[tokenId], "locked (staked)");
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 id)
        public view override(ERC721Enumerable, ERC2981) returns (bool)
    {
        return super.supportsInterface(id);
    }
}
