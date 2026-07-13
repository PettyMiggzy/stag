// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Plain ERC-20 for lock/withdraw/top-up tests.
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Fee-on-transfer ERC-20: burns `feeBps` of every transfer. Proves the locker
///      records the amount actually RECEIVED, not the amount requested.
contract MockFeeToken is ERC20 {
    uint256 public feeBps; // e.g. 500 = 5%
    constructor(uint256 _feeBps) ERC20("Fee", "FEE") { feeBps = _feeBps; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10000;
            super._update(from, address(0xdead), fee); // burn the fee
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @dev Stand-in for the Uniswap V3 NonfungiblePositionManager (just an ERC-721).
///      Adds a mock `collect` that pays out preset ERC-20 fees to the recipient, so the
///      locker's collectV3Fees (fees to owner, position untouched) can be tested.
contract MockPositionManager is ERC721 {
    uint256 public nextId;
    // Preloaded "swap fee" payout per tokenId, paid in these mock ERC-20s on collect().
    MockERC20 public feeToken0;
    MockERC20 public feeToken1;
    mapping(uint256 => uint256) public feesOwed0;
    mapping(uint256 => uint256) public feesOwed1;

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    constructor() ERC721("Position", "POS") {}
    function mint(address to) external returns (uint256 id) { id = nextId++; _mint(to, id); }

    /// @dev Configure the fee tokens and mint them to this manager so collect() can pay out.
    function setFeeTokens(address t0, address t1) external {
        feeToken0 = MockERC20(t0);
        feeToken1 = MockERC20(t1);
    }
    function setFeesOwed(uint256 tokenId, uint256 a0, uint256 a1) external {
        feesOwed0[tokenId] = a0;
        feesOwed1[tokenId] = a1;
        if (a0 > 0) feeToken0.mint(address(this), a0);
        if (a1 > 0) feeToken1.mint(address(this), a1);
    }

    /// @dev Pays the owed fees (capped by amountMax) to `recipient`, mirroring the real
    ///      NPM.collect. The ERC-721 owner is NEVER changed — collecting can't unlock.
    function collect(CollectParams calldata p) external returns (uint256 amount0, uint256 amount1) {
        amount0 = feesOwed0[p.tokenId];
        if (amount0 > p.amount0Max) amount0 = p.amount0Max;
        amount1 = feesOwed1[p.tokenId];
        if (amount1 > p.amount1Max) amount1 = p.amount1Max;
        feesOwed0[p.tokenId] -= amount0;
        feesOwed1[p.tokenId] -= amount1;
        if (amount0 > 0) feeToken0.transfer(p.recipient, amount0);
        if (amount1 > 0) feeToken1.transfer(p.recipient, amount1);
    }
}

/// @dev A contract that REJECTS all incoming ETH. Used as a hostile feeRecipient to
///      prove that (a) lock creation is NOT bricked by a reverting recipient (pull
///      payment accrues instead of pushing) and (b) withdrawFees reverts and keeps
///      fees accrued (never lost) when the recipient rejects the transfer.
contract RevertingReceiver {
    receive() external payable { revert("no eth"); }
}

/// @dev Attempts to re-enter withdraw() during the ERC-721 receive callback.
contract ReentrantReceiver {
    address public locker;
    uint256 public targetId;
    constructor(address _locker) { locker = _locker; }
    function arm(uint256 id) external { targetId = id; }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        // Re-enter; must be blocked by ReentrancyGuard on withdraw().
        (bool ok, ) = locker.call(abi.encodeWithSignature("withdraw(uint256)", targetId));
        require(ok, "reenter blocked"); // if guard works, this reverts and bubbles up
        return this.onERC721Received.selector;
    }
}

// Reverts on balanceOf — simulates a hostile/paused fee-exempt token for the fail-closed test.
contract RevertingBalanceToken {
    function balanceOf(address) external pure returns (uint256) { revert("nope"); }
}
