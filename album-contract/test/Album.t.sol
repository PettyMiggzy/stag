// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HoodRichAlbum} from "../src/HoodRichAlbum.sol";

contract Rejecter { receive() external payable { revert("no"); } }
contract GasHog { uint256 public n; receive() external payable { for (uint256 i; i < 50; ++i) n += i; } } // like a smart-account wallet that runs code on receive
contract ReentrantBuyer {
    HoodRichAlbum public a; uint256 public price; bool public tried; bool public blocked;
    constructor(HoodRichAlbum a_) { a = a_; }
    function buy() external payable { price = a.price(); a.mint{value: price}(); }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!tried) { tried = true; try a.mint{value: price}() {} catch { blocked = true; } }
        return this.onERC721Received.selector;
    }
    receive() external payable {}
}
contract AlbumTest is Test {
    address owner = address(0xA11CE); address payout = address(0xBEEF); address bob = address(0xB0B); address eve = address(0xE7E);
    uint256 constant AP = 0.011 ether;
    HoodRichAlbum a;

    function setUp() public {
        a = new HoodRichAlbum(payout, AP, 3, "u", owner);
        vm.deal(bob, 10 ether); vm.deal(eve, 10 ether);
    }
    // ---- album ----
    function test_album_startsPaused() public { vm.prank(bob); vm.expectRevert(HoodRichAlbum.MintPaused.selector); a.mint{value: AP}(); }
    function test_album_paysPayoutDirectly() public {
        vm.prank(owner); a.setPaused(false);
        vm.prank(bob); uint256 id = a.mint{value: AP}();
        assertEq(id, 1); assertEq(a.ownerOf(1), bob); assertEq(payout.balance, AP); assertEq(address(a).balance, 0); assertTrue(a.hasAccess(bob));
    }
    function test_album_exactPaymentOnly() public {
        vm.prank(owner); a.setPaused(false);
        vm.startPrank(bob);
        vm.expectRevert(HoodRichAlbum.WrongPayment.selector); a.mint{value: AP - 1}();
        vm.expectRevert(HoodRichAlbum.WrongPayment.selector); a.mint{value: AP + 1}();
        vm.expectRevert(HoodRichAlbum.WrongPayment.selector); a.mint();
    }
    function test_album_capEnforced() public {
        vm.prank(owner); a.setPaused(false);
        for (uint256 i; i < 3; i++) { vm.prank(bob); a.mint{value: AP}(); }
        vm.prank(eve); vm.expectRevert(HoodRichAlbum.SoldOut.selector); a.mint{value: AP}();
        assertEq(a.totalSupply(), 3); assertEq(payout.balance, 3 * AP);
    }
    function test_album_priceChangeProtectsBuyer() public {
        vm.prank(owner); a.setPaused(false);
        vm.prank(owner); a.setPrice(AP * 2);
        vm.prank(bob); vm.expectRevert(HoodRichAlbum.WrongPayment.selector); a.mint{value: AP}(); // stale price reverts, nothing charged
        assertEq(bob.balance, 10 ether);
        vm.prank(bob); a.mint{value: AP * 2}(); assertEq(payout.balance, AP * 2);
    }
    function test_album_onlyOwnerAdmin() public {
        vm.startPrank(bob);
        vm.expectRevert(); a.setPaused(false); vm.expectRevert(); a.setPrice(1); vm.expectRevert(); a.setMetadataURI("x"); vm.expectRevert(); a.freezeMetadata();
    }
    function test_album_cannotRenounce() public { vm.prank(owner); vm.expectRevert(HoodRichAlbum.RenounceDisabled.selector); a.renounceOwnership(); assertEq(a.owner(), owner); }
    function test_album_freeze() public { vm.startPrank(owner); a.freezeMetadata(); vm.expectRevert(HoodRichAlbum.Frozen.selector); a.setMetadataURI("x"); }
    function test_album_payoutRejectingReverts() public {
        HoodRichAlbum b = new HoodRichAlbum(address(new Rejecter()), AP, 3, "u", owner);
        vm.prank(owner); b.setPaused(false);
        vm.prank(bob); vm.expectRevert(HoodRichAlbum.PayoutFailed.selector); b.mint{value: AP}();
        assertEq(b.totalSupply(), 0); assertEq(bob.balance, 10 ether);
    }
    function test_album_smartAccountPayoutWorks() public {
        GasHog g = new GasHog(); HoodRichAlbum b = new HoodRichAlbum(address(g), AP, 3, "u", owner);
        vm.prank(owner); b.setPaused(false); vm.prank(bob); b.mint{value: AP}(); assertEq(address(g).balance, AP);
    }
    function test_album_reentrancyBlocked() public {
        vm.prank(owner); a.setPaused(false);
        ReentrantBuyer r = new ReentrantBuyer(a); vm.deal(address(r), 1 ether);
        r.buy(); assertTrue(r.tried()); assertTrue(r.blocked()); assertEq(a.totalSupply(), 1); assertEq(payout.balance, AP);
    }
}
