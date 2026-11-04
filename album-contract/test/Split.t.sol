// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HoodRichSongs} from "../src/HoodRichSongs.sol";

contract RejectingLabel { receive() external payable { revert("no"); } }

contract SplitTest is Test {
    address owner = address(0xA11CE); address label = address(0x1ABE1); address artistA = address(0xAA); address artistB = address(0xBB); address bob = address(0xB0B);
    HoodRichSongs c;
    function setUp() public { c = new HoodRichSongs(owner, label); vm.deal(bob, 100 ether); }
    function _add(uint128 price, address artist, uint16 bps) internal returns (uint256 id) {
        vm.prank(owner); id = c.addSong(price, 1000, artist, bps, "x");
        uint256[] memory ids = new uint256[](1); ids[0] = id; vm.prank(owner); c.setOpenMany(ids, true);
    }

    function test_labelTakesItsCutArtistKeepsTheRest() public {
        uint256 id = _add(1 ether, artistA, 2000); // 20% to the label
        vm.prank(bob); c.mint{value: 1 ether}(id);
        assertEq(label.balance, 0.2 ether); assertEq(artistA.balance, 0.8 ether); assertEq(address(c).balance, 0);
    }
    function test_differentArtistsDifferentDeals() public {
        uint256 a = _add(1 ether, artistA, 2000); uint256 b = _add(1 ether, artistB, 5000); uint256 z = _add(1 ether, artistA, 0);
        vm.startPrank(bob); c.mint{value: 1 ether}(a); c.mint{value: 1 ether}(b); c.mint{value: 1 ether}(z); vm.stopPrank();
        assertEq(label.balance, 0.2 ether + 0.5 ether + 0); assertEq(artistA.balance, 0.8 ether + 1 ether); assertEq(artistB.balance, 0.5 ether);
    }
    function test_zeroCutPaysArtistEverything() public { uint256 id = _add(1 ether, artistA, 0); vm.prank(bob); c.mint{value: 1 ether}(id); assertEq(label.balance, 0); assertEq(artistA.balance, 1 ether); }
    function test_cutCannotExceedMax() public { vm.prank(owner); vm.expectRevert(HoodRichSongs.CutTooHigh.selector); c.addSong(1, 1, artistA, 5001, "x"); vm.prank(owner); c.addSong(1, 1, artistA, 5000, "x"); }
    function test_roundingNeverLosesAWei() public { // 1 wei at 33.33%: label floor(0.3333)=0, artist gets the whole wei
        uint256 id = _add(7, artistA, 3333); vm.prank(bob); c.mint{value: 7}(id);
        assertEq(label.balance + artistA.balance, 7); assertEq(label.balance, 2); assertEq(artistA.balance, 5); assertEq(address(c).balance, 0);
    }
    function test_ownerCannotRaiseTheCutLater() public { // there is simply no function that changes an item's cut
        uint256 id = _add(1 ether, artistA, 1000); assertEq(c.labelBpsOf(id), 1000);
        vm.prank(owner); c.setPrice(id, 2 ether); assertEq(c.labelBpsOf(id), 1000);
        vm.prank(artistA); c.changePayout(id, artistB); assertEq(c.labelBpsOf(id), 1000);
    }
    function test_onlyOwnerChangesLabelWallet() public {
        vm.prank(bob); vm.expectRevert(); c.setLabelWallet(bob);
        vm.prank(owner); vm.expectRevert(HoodRichSongs.ZeroAddress.selector); c.setLabelWallet(address(0));
        uint256 id = _add(1 ether, artistA, 2000); address newLabel = address(0x1ABE2); vm.prank(owner); c.setLabelWallet(newLabel);
        vm.prank(bob); c.mint{value: 1 ether}(id); assertEq(newLabel.balance, 0.2 ether); assertEq(label.balance, 0); assertEq(artistA.balance, 0.8 ether);
    }
    function test_rejectingLabelRevertsAndChargesNothing() public {
        HoodRichSongs d = new HoodRichSongs(owner, address(new RejectingLabel()));
        vm.prank(owner); d.addSong(1 ether, 5, artistA, 2000, "x"); uint256[] memory ids = new uint256[](1); ids[0] = 1; vm.prank(owner); d.setOpenMany(ids, true);
        vm.prank(bob); vm.expectRevert(HoodRichSongs.PayoutFailed.selector); d.mint{value: 1 ether}(1);
        assertEq(bob.balance, 100 ether); assertEq(artistA.balance, 0); (,, uint256 minted,,,) = d.songInfo(1); assertEq(minted, 0);
        // owner fixes the label wallet and sales work again
        vm.prank(owner); d.setLabelWallet(label); vm.prank(bob); d.mint{value: 1 ether}(1); assertEq(label.balance, 0.2 ether);
    }
    function test_zeroCutItemsIgnoreABrokenLabelWallet() public {
        HoodRichSongs d = new HoodRichSongs(owner, address(new RejectingLabel()));
        vm.prank(owner); d.addSong(1 ether, 5, artistA, 0, "x"); uint256[] memory ids = new uint256[](1); ids[0] = 1; vm.prank(owner); d.setOpenMany(ids, true);
        vm.prank(bob); d.mint{value: 1 ether}(1); assertEq(artistA.balance, 1 ether);
    }
    function testFuzz_everyWeiAccountedFor(uint96 price, uint16 bpsRaw, uint8 n) public {
        vm.deal(bob, 1000 ether); uint16 bps = bpsRaw % 5001; uint256 p = uint256(price) % 50 ether; uint256 id = _add(uint128(p), artistA, bps);
        uint256 k = n % 5 + 1;
        for (uint256 i; i < k; i++) { vm.prank(bob); c.mint{value: p}(id); }
        assertEq(address(c).balance, 0); assertEq(label.balance + artistA.balance, p * k);
        assertEq(label.balance, ((p * bps) / 10_000) * k); assertLe(label.balance * 2, p * k);  // label never gets more than half
    }
}
