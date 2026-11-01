// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {HoodRichSongs} from "../src/HoodRichSongs.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract M is ERC20 { constructor() ERC20("U","U"){} function decimals() public pure override returns(uint8){return 6;} function mint(address t,uint256 a) external {_mint(t,a);} }
contract HoodRichSongsTest is Test {
    M usdg; HoodRichSongs s; address owner=address(0xA11CE); address payout=address(0xBEEF); address bob=address(0xB0B); address eve=address(0xE7E);
    function setUp() public { usdg=new M(); s=new HoodRichSongs(address(usdg),payout,owner); usdg.mint(bob,1000e6); usdg.mint(eve,1000e6);
        vm.startPrank(owner); s.addSong(2_990_000,2,"u1"); s.addSong(4_990_000,5,"u2"); vm.stopPrank(); }
    function buy(address w,uint256 id,uint256 p) internal { vm.startPrank(w); usdg.approve(address(s),p); s.mint(id); vm.stopPrank(); }
    function test_newSongClosed() public { vm.startPrank(bob); usdg.approve(address(s),2_990_000); vm.expectRevert(HoodRichSongs.SongClosed.selector); s.mint(1); }
    function test_buyPaysPayout() public { vm.prank(owner); s.setOpen(1,true); buy(bob,1,2_990_000);
        assertEq(s.balanceOf(bob,1),1); assertEq(usdg.balanceOf(payout),2_990_000); assertEq(usdg.balanceOf(address(s)),0); assertTrue(s.hasSong(bob,1)); assertFalse(s.hasSong(bob,2)); }
    function test_perSongPriceAndCap() public { vm.startPrank(owner); s.setOpen(1,true); s.setOpen(2,true); vm.stopPrank();
        buy(bob,2,4_990_000); assertEq(usdg.balanceOf(payout),4_990_000);
        buy(bob,1,2_990_000); buy(eve,1,2_990_000);
        vm.startPrank(bob); usdg.approve(address(s),2_990_000); vm.expectRevert(HoodRichSongs.SoldOut.selector); s.mint(1); }
    function test_noSuchSong() public { vm.expectRevert(HoodRichSongs.NoSuchSong.selector); s.mint(3); vm.expectRevert(HoodRichSongs.NoSuchSong.selector); s.mint(0); }
    function test_onlyOwner() public { vm.startPrank(bob); vm.expectRevert(); s.addSong(1,1,"x"); vm.expectRevert(); s.setOpen(1,true); }
    function test_freeze() public { vm.startPrank(owner); s.freezeSong(1); vm.expectRevert(HoodRichSongs.Frozen.selector); s.setSongURI(1,"x"); }
    function test_priceNeverChanges() public { vm.prank(owner); s.setOpen(1,true); (uint256 p,,,,,)=s.songInfo(1); assertEq(p,2_990_000); }
    function test_zeroCapRejected() public { vm.prank(owner); vm.expectRevert(HoodRichSongs.BadCap.selector); s.addSong(1,0,"x"); }
    function testFuzz_neverHoldsFunds(uint8 n) public { vm.prank(owner); s.setOpen(2,true); uint256 k=n%6;
        for(uint256 i;i<k;i++){ if(i>=5)break; buy(bob,2,4_990_000);} assertEq(usdg.balanceOf(address(s)),0); }
}
