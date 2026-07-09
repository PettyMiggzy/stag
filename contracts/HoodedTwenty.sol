// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*  The Hooded 20 — STAGWIFHOOD NFT mint (Robinhood Chain)
 *  - 20 supply, provably no duplicates, random assignment on mint
 *  - pay a mint fee in native ETH; owner withdraws proceeds
 *  - tokenURI -> hosted metadata (stagwifhood.fun)
 *  - ABI matches the site's mint-wallet.js: mint() / totalSupply() / MAX_SUPPLY()
 *
 *  ⚠️ Review + test on the Robinhood Chain TESTNET (chainId 46630) before mainnet.
 *  On-chain randomness (prevrandao) is fine for a fair 20-piece draw but is not
 *  cryptographically unpredictable — do not reuse this pattern for high-value RNG.
 */

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract HoodedTwenty is ERC721Enumerable, Ownable {
    uint256 public constant MAX_SUPPLY = 20;

    uint256 public mintPrice;          // fee per mint, in wei (native ETH)
    bool    public mintActive;         // owner flips on at go-live
    string  private _base;             // e.g. https://stagwifhood.fun/assets/nft/stagwifhood/metadata/

    address public stakingPool;        // StagStaking — receives a cut of mint sales
    uint256 public poolBps = 3000;     // 30% of each mint's ETH goes to the stake pool

    // gas-efficient random-without-duplicates (Fisher–Yates on demand)
    uint256 private _remaining = MAX_SUPPLY;
    mapping(uint256 => uint256) private _slot;

    constructor(uint256 _price, string memory baseURI_)
        ERC721("The Hooded 20", "HOOD20")
        Ownable(msg.sender)
    {
        mintPrice = _price;
        _base = baseURI_;
    }

    function mint() external payable {
        require(mintActive, "mint not active");
        require(_remaining > 0, "sold out");
        require(msg.value >= mintPrice, "fee too low");
        uint256 id = _draw();
        _safeMint(msg.sender, id);
        // route 30% of the sale into the staking reward pool (real yield for stakers)
        if (stakingPool != address(0) && msg.value > 0) {
            uint256 share = (msg.value * poolBps) / 10000;
            if (share > 0) { (bool ok, ) = stakingPool.call{value: share}(""); require(ok, "pool fwd failed"); }
        }
    }

    // returns a token id in 1..MAX_SUPPLY, each exactly once, in random order
    function _draw() internal returns (uint256) {
        uint256 r = uint256(
            keccak256(abi.encodePacked(block.prevrandao, block.timestamp, msg.sender, _remaining))
        ) % _remaining;
        uint256 last = _remaining - 1;
        uint256 picked = _slot[r] == 0 ? r : _slot[r];
        uint256 lastVal = _slot[last] == 0 ? last : _slot[last];
        _slot[r] = lastVal;
        _remaining = last;
        return picked + 1;
    }

    function minted() external view returns (uint256) { return MAX_SUPPLY - _remaining; }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string(abi.encodePacked(_base, _toString(tokenId), ".json"));
    }

    /* ---- owner controls ---- */
    function setMintActive(bool v) external onlyOwner { mintActive = v; }
    function setMintPrice(uint256 v) external onlyOwner { mintPrice = v; }
    function setBaseURI(string calldata v) external onlyOwner { _base = v; }
    function setStakingPool(address p) external onlyOwner { stakingPool = p; }
    function setPoolBps(uint256 bps) external onlyOwner { require(bps <= 10000, "max 100%"); poolBps = bps; }

    function withdraw(address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
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
