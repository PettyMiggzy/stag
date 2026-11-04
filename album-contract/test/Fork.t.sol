// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HoodRichSongs} from "../src/HoodRichSongs.sol";

/// Mainnet fork: pays Winslow's real wallet (a smart-account wallet) in real Robinhood Chain ETH, through the catalog.
contract ForkTest is Test {
    address constant WINSLOW = 0xC3e89fC7F9d3594DE794EA4C60E5E4D7d59AB055;
    address constant OWNER = 0x72938Daaf3c2Fa4bEf722E1263a5766755788392;
    address bob = address(0xB0B);

    function test_catalogPaysWinslowInEth() public {
        HoodRichSongs c = new HoodRichSongs(address(this), OWNER);
        c.addSong(0.0022 ether, 100, WINSLOW, 2000, "song");
        c.addSong(0.011 ether, 100, WINSLOW, 2000, "album");
        uint256[] memory ids = new uint256[](2); ids[0] = 1; ids[1] = 2; c.setOpenMany(ids, true);
        vm.deal(bob, 1 ether); uint256 before = WINSLOW.balance; uint256 ownerBefore = OWNER.balance;
        vm.prank(bob); c.mint{value: 0.0022 ether}(1);
        vm.prank(bob); c.mint{value: 0.011 ether}(2);
        // 20% to the label wallet (the owner wallet), 80% to Winslow
        assertEq(WINSLOW.balance - before, 0.01056 ether, "Winslow share wrong");
        assertEq(OWNER.balance - ownerBefore, 0.00264 ether, "label share wrong"); assertEq(address(c).balance, 0);
        assertEq(c.balanceOf(bob, 1), 1); assertEq(c.balanceOf(bob, 2), 1);
    }
}
