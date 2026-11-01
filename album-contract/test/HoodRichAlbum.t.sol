// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HoodRichAlbum} from "../src/HoodRichAlbum.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDG is ERC20 {
    constructor() ERC20("USDG", "USDG") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract HoodRichAlbumTest is Test {
    MockUSDG usdg; HoodRichAlbum nft;
    address owner = address(0xA11CE); address payout = address(0xBEEF);
    address bob = address(0xB0B); address eve = address(0xE7E);
    uint256 constant PRICE = 24_990_000;

    function setUp() public {
        usdg = new MockUSDG();
        nft = new HoodRichAlbum(address(usdg), payout, PRICE, 3, "https://records.stagwifhood.fun/album/meta.json", owner);
        usdg.mint(bob, 1_000e6); usdg.mint(eve, 1_000e6);
    }

    function test_startsPaused() public {
        vm.startPrank(bob); usdg.approve(address(nft), PRICE);
        vm.expectRevert(HoodRichAlbum.MintPaused.selector); nft.mint();
    }

    function test_mintPaysPayoutDirectly() public {
        vm.prank(owner); nft.setPaused(false);
        vm.startPrank(bob); usdg.approve(address(nft), PRICE); uint256 id = nft.mint(); vm.stopPrank();
        assertEq(id, 1); assertEq(nft.ownerOf(1), bob);
        assertEq(usdg.balanceOf(payout), PRICE); assertEq(usdg.balanceOf(address(nft)), 0);
        assertTrue(nft.hasAccess(bob)); assertFalse(nft.hasAccess(eve));
        assertEq(nft.tokenURI(1), "https://records.stagwifhood.fun/album/meta.json");
    }

    function test_capEnforced() public {
        vm.prank(owner); nft.setPaused(false);
        for (uint256 i; i < 3; i++) { vm.startPrank(bob); usdg.approve(address(nft), PRICE); nft.mint(); vm.stopPrank(); }
        vm.startPrank(eve); usdg.approve(address(nft), PRICE);
        vm.expectRevert(HoodRichAlbum.SoldOut.selector); nft.mint();
        assertEq(nft.totalSupply(), 3);
    }

    function test_needsApproval() public {
        vm.prank(owner); nft.setPaused(false);
        vm.prank(bob); vm.expectRevert(); nft.mint();
        assertEq(nft.totalSupply(), 0);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(bob); vm.expectRevert(); nft.setPaused(false);
        vm.prank(bob); vm.expectRevert(); nft.setMetadataURI("x");
    }

    function test_freezeLocksMetadata() public {
        vm.startPrank(owner); nft.freezeMetadata();
        vm.expectRevert(HoodRichAlbum.Frozen.selector); nft.setMetadataURI("x");
    }

    function testFuzz_neverHoldsFunds(uint8 n) public {
        vm.prank(owner); nft.setPaused(false);
        uint256 k = n % 4;
        for (uint256 i; i < k; i++) { vm.startPrank(bob); usdg.approve(address(nft), PRICE); nft.mint(); vm.stopPrank(); }
        assertEq(usdg.balanceOf(address(nft)), 0); assertEq(usdg.balanceOf(payout), PRICE * k);
    }
}
