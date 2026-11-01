// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HoodRichAlbum} from "../src/HoodRichAlbum.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Runs the sale against the REAL USDG on Robinhood Chain (fork of mainnet).
contract ForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address payout = 0x72938Daaf3c2Fa4bEf722E1263a5766755788392;
    address owner = address(0xA11CE); address bob = address(0xB0B);

    function test_realUsdgSale() public {
        HoodRichAlbum nft = new HoodRichAlbum(USDG, payout, 24_990_000, 100, "https://records.stagwifhood.fun/album/meta.json", owner);
        deal(USDG, bob, 100e6);
        assertEq(IERC20(USDG).balanceOf(bob), 100e6, "deal failed for this token");
        vm.prank(owner); nft.setPaused(false);
        uint256 before = IERC20(USDG).balanceOf(payout);
        vm.startPrank(bob); IERC20(USDG).approve(address(nft), 24_990_000); nft.mint(); vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(payout) - before, 24_990_000);
        assertEq(IERC20(USDG).balanceOf(address(nft)), 0);
        assertEq(nft.ownerOf(1), bob);
        assertEq(IERC20(USDG).balanceOf(bob), 100e6 - 24_990_000);
    }
}
