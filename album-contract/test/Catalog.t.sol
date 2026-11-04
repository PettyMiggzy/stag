// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HoodRichSongs} from "../src/HoodRichSongs.sol";

contract Rejecter2 { receive() external payable { revert("no"); } }
contract GasHog2 { uint256 public n; receive() external payable { for (uint256 i; i < 50; ++i) n += i; } }
contract ReentrantPayout2 {
    HoodRichSongs public s; uint256 public targetId; bool public tried; bool public blocked;
    function setTarget(HoodRichSongs s_, uint256 id) external { s = s_; targetId = id; }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return this.onERC1155Received.selector; }
    receive() external payable { if (!tried) { tried = true; try s.mint{value: msg.value}(targetId) {} catch { blocked = true; } } }
}

contract CatalogTest is Test {
    address owner = address(0xA11CE); address label = address(0x1ABE1); address winslow = address(0xB1); address artist2 = address(0xB2);
    address bob = address(0xB0B); address eve = address(0xE7E);
    uint128 constant SP = 0.0022 ether; uint128 constant AP = 0.011 ether;
    HoodRichSongs c;

    function setUp() public {
        c = new HoodRichSongs(owner, label);
        vm.startPrank(owner);
        c.addSong(SP, 2, winslow, 0, "s1");       // id 1: a song
        c.addSong(AP, 5, winslow, 0, "album");    // id 2: an album
        vm.stopPrank();
        vm.deal(bob, 10 ether); vm.deal(eve, 10 ether);
    }
    function _open(uint256 id) internal { uint256[] memory ids = new uint256[](1); ids[0] = id; vm.prank(owner); c.setOpenMany(ids, true); }

    // ---- adding more items later, any artist, no redeploy
    function test_addMoreItemsLaterForAnotherArtist() public {
        vm.prank(owner); uint256 id = c.addSong(0.5 ether, 10, artist2, 0, "other artist song"); assertEq(id, 3); assertEq(c.songCount(), 3);
        assertEq(c.payoutOf(3), artist2); assertEq(c.payoutOf(1), winslow);
        _open(1); _open(3);
        vm.prank(bob); c.mint{value: SP}(1); vm.prank(bob); c.mint{value: 0.5 ether}(3);
        assertEq(winslow.balance, SP, "winslow paid wrong"); assertEq(artist2.balance, 0.5 ether, "artist2 paid wrong");
        assertEq(address(c).balance, 0);
    }
    function test_manyItems() public { vm.startPrank(owner); for (uint256 i; i < 60; i++) c.addSong(1, 1, artist2, 0, "x"); vm.stopPrank(); assertEq(c.songCount(), 62); }
    function test_newItemClosed() public { vm.prank(bob); vm.expectRevert(HoodRichSongs.SongClosed.selector); c.mint{value: SP}(1); }
    function test_zeroPayoutRejected() public { vm.prank(owner); vm.expectRevert(HoodRichSongs.ZeroAddress.selector); c.addSong(1, 1, address(0), 0, "x"); }
    function test_zeroCapRejected() public { vm.prank(owner); vm.expectRevert(HoodRichSongs.BadCap.selector); c.addSong(1, 0, winslow, 0, "x"); }

    // ---- paying
    function test_paysTheItemsOwnPayout() public { _open(1); _open(2);
        vm.prank(bob); c.mint{value: SP}(1); vm.prank(eve); c.mint{value: AP}(2);
        assertEq(winslow.balance, uint256(SP) + uint256(AP)); assertEq(address(c).balance, 0); assertTrue(c.hasSong(bob, 1)); assertFalse(c.hasSong(bob, 2)); assertTrue(c.hasSong(eve, 2)); }
    function test_exactPaymentOnly() public { _open(1);
        vm.startPrank(bob);
        vm.expectRevert(HoodRichSongs.WrongPayment.selector); c.mint{value: SP - 1}(1);
        vm.expectRevert(HoodRichSongs.WrongPayment.selector); c.mint{value: SP + 1}(1);
        vm.expectRevert(HoodRichSongs.WrongPayment.selector); c.mint(1); }
    function test_capEnforced() public { _open(1);
        vm.prank(bob); c.mint{value: SP}(1); vm.prank(eve); c.mint{value: SP}(1);
        vm.prank(bob); vm.expectRevert(HoodRichSongs.SoldOut.selector); c.mint{value: SP}(1); }
    function test_priceChangeProtectsBuyer() public { _open(1); vm.prank(owner); c.setPrice(1, SP * 3);
        vm.prank(bob); vm.expectRevert(HoodRichSongs.WrongPayment.selector); c.mint{value: SP}(1); assertEq(bob.balance, 10 ether);
        vm.prank(bob); c.mint{value: SP * 3}(1); assertEq(winslow.balance, SP * 3); }
    function test_noSuchItem() public { vm.expectRevert(HoodRichSongs.NoSuchSong.selector); c.mint{value: SP}(3); vm.expectRevert(HoodRichSongs.NoSuchSong.selector); c.mint{value: SP}(0); }

    // ---- who can do what
    function test_onlyOwnerAdmin() public { vm.startPrank(bob);
        vm.expectRevert(); c.addSong(1, 1, bob, 0, "x"); vm.expectRevert(); c.setOpen(1, true); vm.expectRevert(); c.setPrice(1, 1); vm.expectRevert(); c.setSongURI(1, "x"); vm.expectRevert(); c.freezeSong(1); }
    function test_ownerCannotRedirectMoney() public { // owner has no function that changes an item's payout
        vm.prank(owner); vm.expectRevert(HoodRichSongs.NotPayee.selector); c.changePayout(1, owner); assertEq(c.payoutOf(1), winslow); }
    function test_payeeCanMoveOwnPayout() public { _open(1);
        vm.prank(winslow); c.changePayout(1, artist2); assertEq(c.payoutOf(1), artist2);
        vm.prank(bob); c.mint{value: SP}(1); assertEq(artist2.balance, SP); assertEq(winslow.balance, 0);
        vm.prank(winslow); vm.expectRevert(HoodRichSongs.NotPayee.selector); c.changePayout(1, winslow); // old wallet lost the right
        vm.prank(artist2); vm.expectRevert(HoodRichSongs.ZeroAddress.selector); c.changePayout(1, address(0)); }
    function test_freeze() public { vm.startPrank(owner); c.freezeSong(1); vm.expectRevert(HoodRichSongs.Frozen.selector); c.setSongURI(1, "x"); }
    function test_openMany() public { uint256[] memory ids = new uint256[](2); ids[0] = 1; ids[1] = 2; vm.prank(owner); c.setOpenMany(ids, true);
        vm.prank(bob); c.mint{value: SP}(1); vm.prank(bob); c.mint{value: AP}(2);
        vm.prank(bob); vm.expectRevert(); c.setOpenMany(ids, false);
        ids[1] = 9; vm.prank(owner); vm.expectRevert(HoodRichSongs.NoSuchSong.selector); c.setOpenMany(ids, false); }
    function test_cannotRenounce() public { vm.prank(owner); vm.expectRevert(HoodRichSongs.RenounceDisabled.selector); c.renounceOwnership(); assertEq(c.owner(), owner); }
    function test_ownershipTransferIsTwoStep() public { vm.prank(owner); c.transferOwnership(bob); assertEq(c.owner(), owner);
        vm.prank(eve); vm.expectRevert(); c.acceptOwnership(); vm.prank(bob); c.acceptOwnership(); assertEq(c.owner(), bob); }

    // ---- safety
    function test_payoutRejectingReverts() public {
        address rej = address(new Rejecter2()); vm.prank(owner); c.addSong(SP, 5, rej, 0, "x"); _open(3);
        vm.prank(bob); vm.expectRevert(HoodRichSongs.PayoutFailed.selector); c.mint{value: SP}(3);
        (,, uint256 minted,,,) = c.songInfo(3); assertEq(minted, 0); assertEq(bob.balance, 10 ether); }
    function test_oneBadPayoutDoesNotBlockOthers() public {
        address rej = address(new Rejecter2()); vm.prank(owner); c.addSong(SP, 5, rej, 0, "bad"); _open(3); _open(1);
        vm.prank(bob); vm.expectRevert(HoodRichSongs.PayoutFailed.selector); c.mint{value: SP}(3);
        vm.prank(bob); c.mint{value: SP}(1); assertEq(c.balanceOf(bob, 1), 1); }
    function test_smartAccountPayoutWorks() public { GasHog2 g = new GasHog2();
        vm.prank(owner); c.addSong(SP, 5, address(g), 0, "x"); _open(3); vm.prank(bob); c.mint{value: SP}(3); assertEq(address(g).balance, SP); }
    function test_reentrancyBlocked() public {
        ReentrantPayout2 rp = new ReentrantPayout2();
        vm.prank(owner); uint256 id = c.addSong(SP, 5, address(rp), 0, "x"); rp.setTarget(c, id); _open(id);
        vm.prank(bob); c.mint{value: SP}(id);
        assertTrue(rp.tried(), "payout did not try to re-enter"); assertTrue(rp.blocked(), "re-entry was NOT blocked");
        (,, uint256 minted,,,) = c.songInfo(id); assertEq(minted, 1); assertEq(address(c).balance, 0); }
    function testFuzz_neverHoldsEthAndPaysExactly(uint8 n, uint8 m) public {
        _open(1); _open(2); uint256 k = n % 3; uint256 j = m % 6;
        for (uint256 i; i < k; i++) { vm.prank(bob); c.mint{value: SP}(1); }
        for (uint256 i; i < j && i < 5; i++) { vm.prank(eve); c.mint{value: AP}(2); }
        assertEq(address(c).balance, 0); (,, uint256 m1,,,) = c.songInfo(1); (,, uint256 m2,,,) = c.songInfo(2);
        assertEq(winslow.balance, m1 * SP + m2 * uint256(AP)); }
}
