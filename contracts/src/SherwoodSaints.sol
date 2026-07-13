// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*  Sherwood Saints — STAGWIFHOOD's 5-piece, all-top-tier 1/1 animated drop (Robinhood Chain 4663).
 *  "The 5 who called it. Founders eat first." Sits above the Hooded 20 as the rarest drop.
 *
 *  • Supply: 5 (token ids 1..5, every one a 1/1 "Saint").
 *  • Mint: PICK a specific available Saint and pay the flat mint price (owner-settable, default 0.03 ETH).
 *  • ERC-2981 royalties on secondary; proceeds routed to a SaintsSplitter (buy-burn / pool / team).
 *  • Free-mint allowlist (owner reserves / gifting the real Saints their own piece).
 *
 *  SCANNER-SAFE: the signed mint tx pays ONLY this contract (single recipient) — no ETH fan-out
 *  inside the user's tx, so MetaMask/Blockaid don't read it as a drainer. The split happens
 *  out-of-band via forwardProceeds().
 *
 *  ⚠️ Holds real funds. Audited + tested before mainnet.
 */

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SherwoodSaints is ERC721Enumerable, ERC2981, Ownable, ReentrancyGuard {
    uint256 public constant MAX_SUPPLY = 5; // token ids 1..5, all 1/1

    // ---- pricing / policy (owner-tunable) ----
    uint256 public mintPrice = 0.03 ether;     // flat price per Saint
    uint256 public maxPerWallet = 2;           // anti-sweep on a 5-piece drop (owner-settable)
    bool    public mintActive;

    string  private _base;                     // https://stagwifhood.fun/assets/nft/saints/metadata/
    address payable public splitter;           // SaintsSplitter (or a payout wallet)

    mapping(address => uint256) public mintedBy;
    mapping(address => uint256) public freeMints; // allowlist: remaining free mints per wallet

    event Minted(address indexed to, uint256 indexed tokenId, uint256 pricePaid);
    event ProceedsForwarded(uint256 amount);
    event MintStateChanged(bool active);
    event PriceChanged(uint256 mintPrice);
    event SplitterChanged(address splitter);
    event FreeMintsGranted(address indexed wallet, uint256 count);

    constructor(string memory baseURI, address royaltyReceiver, uint96 royaltyBps)
        ERC721("Sherwood Saints", "SAINT")
        Ownable(msg.sender)
    {
        _base = baseURI;
        if (royaltyReceiver != address(0)) _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    /* ---------------- mint ---------------- */

    /// @notice Mint a specific available Saint (id 1..5) at the flat mint price.
    function mintPick(uint256 tokenId) external payable nonReentrant {
        require(isAvailable(tokenId), "unavailable");
        // EOA-only: removes the _safeMint reentrancy surface and contract-grinding. Smart-contract
        // wallets can't mint (accepted trade-off, same as the Hooded 20).
        require(msg.sender == tx.origin, "no contracts");
        require(mintActive, "mint not active");

        bool isFree = freeMints[msg.sender] > 0;
        if (isFree) freeMints[msg.sender] -= 1;
        else require(mintedBy[msg.sender] < maxPerWallet, "wallet limit");
        uint256 due = isFree ? 0 : mintPrice;
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

    function isAvailable(uint256 tokenId) public view returns (bool) {
        return tokenId >= 1 && tokenId <= MAX_SUPPLY && _ownerOf(tokenId) == address(0);
    }

    /// @notice List of Saint ids not yet minted.
    function availableIds() external view returns (uint256[] memory ids) {
        uint256 n;
        for (uint256 i = 1; i <= MAX_SUPPLY; i++) if (_ownerOf(i) == address(0)) n++;
        ids = new uint256[](n);
        uint256 j;
        for (uint256 i = 1; i <= MAX_SUPPLY; i++) if (_ownerOf(i) == address(0)) ids[j++] = i;
    }

    function _baseURI() internal view override returns (string memory) { return _base; }

    /* ---------------- admin (no access to nothing but policy) ---------------- */

    function setMintActive(bool active) external onlyOwner { mintActive = active; emit MintStateChanged(active); }
    function setMintPrice(uint256 price) external onlyOwner { mintPrice = price; emit PriceChanged(price); }
    function setMaxPerWallet(uint256 n) external onlyOwner { require(n > 0, "zero"); maxPerWallet = n; }
    function setBaseURI(string calldata baseURI) external onlyOwner { _base = baseURI; }
    function setSplitter(address payable s) external onlyOwner { require(s != address(0), "zero"); splitter = s; emit SplitterChanged(s); }
    function setRoyalty(address receiver, uint96 bps) external onlyOwner { _setDefaultRoyalty(receiver, bps); }

    /// @notice Grant free mints (reserves / gifting the real Saints their own piece). Bypasses the
    ///         per-wallet cap and price. Cannot exceed remaining supply's worth in practice.
    function grantFreeMints(address wallet, uint256 count) external onlyOwner {
        require(wallet != address(0), "zero");
        freeMints[wallet] += count;
        emit FreeMintsGranted(wallet, count);
    }

    /* ---------------- required overrides ---------------- */

    function supportsInterface(bytes4 id)
        public view override(ERC721Enumerable, ERC2981) returns (bool)
    {
        return super.supportsInterface(id);
    }
}
