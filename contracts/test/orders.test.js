const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const RATE = 1000n;  // mock router: 1 ETH = 1000 TOKEN

async function deploy() {
  const [owner, feeWallet, maker, keeper, other] = await ethers.getSigners();
  const WETH = await (await ethers.getContractFactory("MockWETH")).deploy();
  const TOKEN = await (await ethers.getContractFactory("MockERC20")).deploy();
  const Router = await (await ethers.getContractFactory("MockSwapRouter02")).deploy(await WETH.getAddress(), RATE);
  const Orders = await (await ethers.getContractFactory("SherwoodOrders")).deploy(
    await Router.getAddress(), await WETH.getAddress(), feeWallet.address);
  await owner.sendTransaction({ to: await WETH.getAddress(), value: E(100) });
  await WETH.testMint(await Router.getAddress(), E(100));
  await TOKEN.mint(maker.address, E(1_000_000));
  return { owner, feeWallet, maker, keeper, other, WETH, TOKEN, Router, Orders };
}

describe("SherwoodOrders — limit buy / limit sell (take-profit)", () => {
  it("LIMIT SELL / take-profit: keeper fills to >= minOut ETH, 1% fee to feeWallet", async () => {
    const { Orders, TOKEN, maker, keeper, feeWallet } = await deploy();
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(1000));
    await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), E("0.9")); // want >= 0.9 ETH
    expect(await Orders.escrowedToken(await TOKEN.getAddress())).to.equal(E(1000));
    const feeBefore = await ethers.provider.getBalance(feeWallet.address);
    const makerBefore = await ethers.provider.getBalance(maker.address);
    await Orders.connect(keeper).execute(0);   // 1000 TOKEN -> 1 ETH -> 0.99 net
    expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(feeBefore + E("0.01"));
    expect(await ethers.provider.getBalance(maker.address)).to.equal(makerBefore + E("0.99"));
    expect((await Orders.getOrder(0)).active).to.equal(false);
    expect(await Orders.escrowedToken(await TOKEN.getAddress())).to.equal(0);
    expect(await ethers.provider.getBalance(await Orders.getAddress())).to.equal(0);
  });

  it("LIMIT BUY: escrow ETH, keeper delivers >= minOut tokens to the maker", async () => {
    const { Orders, TOKEN, maker, keeper } = await deploy();
    await Orders.connect(maker).createBuyOrder(await TOKEN.getAddress(), 10000, E(900), { value: E(1) });
    expect(await Orders.escrowedEth()).to.equal(E(1));
    await Orders.connect(keeper).execute(0);   // 0.99 ETH -> 990 TOKEN
    expect(await TOKEN.balanceOf(maker.address)).to.equal(E(1_000_000) + E(990));
    expect(await Orders.escrowedEth()).to.equal(0);
    expect(await ethers.provider.getBalance(await Orders.getAddress())).to.equal(0);
  });

  it("minOut floor: a fill that can't meet the limit reverts (keeper can't short the maker)", async () => {
    const { Orders, TOKEN, maker, keeper } = await deploy();
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(1000));
    await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), E(2)); // impossible floor
    await expect(Orders.connect(keeper).execute(0)).to.be.revertedWith("Too little received");
    expect((await Orders.getOrder(0)).active).to.equal(true); // still open (tx reverted)
  });

  it("cancel: maker gets escrow back + accounting decremented", async () => {
    const { Orders, TOKEN, maker, other } = await deploy();
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(1000));
    await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), E("0.9"));
    await expect(Orders.connect(other).cancelOrder(0)).to.be.revertedWith("not maker");
    const before = await TOKEN.balanceOf(maker.address);
    await Orders.connect(maker).cancelOrder(0);
    expect(await TOKEN.balanceOf(maker.address)).to.equal(before + E(1000));
    expect(await Orders.escrowedToken(await TOKEN.getAddress())).to.equal(0);
  });

  it("C-1 FIX: rescueSurplus can take ONLY untracked surplus, never a maker's escrow", async () => {
    const { Orders, TOKEN, WETH, owner, maker, other } = await deploy();
    const oAddr = await Orders.getAddress();
    // escrow: 1000 TOKEN (sell) + 1 ETH (buy)
    await TOKEN.connect(maker).approve(oAddr, E(1000));
    await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), E("0.9"));
    await Orders.connect(maker).createBuyOrder(await TOKEN.getAddress(), 10000, E(900), { value: E(1) });
    // someone donates/misfires 250 TOKEN + 0.5 ETH directly
    await TOKEN.mint(oAddr, E(250));
    await owner.sendTransaction({ to: oAddr, value: E("0.5") });
    // owner can sweep ONLY the surplus
    await Orders.connect(owner).rescueSurplus(await TOKEN.getAddress(), other.address);
    expect(await TOKEN.balanceOf(other.address)).to.equal(E(250));       // only the donation
    expect(await TOKEN.balanceOf(oAddr)).to.equal(E(1000));              // maker escrow intact
    await Orders.connect(owner).rescueSurplus(ethers.ZeroAddress, other.address);
    expect(await ethers.provider.getBalance(oAddr)).to.equal(E(1));      // maker's 1 ETH escrow intact
    // nothing left to rescue
    await expect(Orders.connect(owner).rescueSurplus(await TOKEN.getAddress(), other.address)).to.be.revertedWith("no surplus");
    await expect(Orders.connect(other).rescueSurplus(ethers.ZeroAddress, other.address)).to.be.reverted; // owner-only
    // makers can still fully cancel and recover
    await Orders.connect(maker).cancelOrder(0);
    await Orders.connect(maker).cancelOrder(1);
    expect(await TOKEN.balanceOf(oAddr)).to.equal(0);
    expect(await ethers.provider.getBalance(oAddr)).to.equal(0);
  });

  it("fee admin + openOrders pager", async () => {
    const { Orders, TOKEN, owner, other, maker } = await deploy();
    await expect(Orders.connect(owner).setFee(301)).to.be.revertedWith("fee too high");
    await Orders.connect(owner).setFee(50); expect(await Orders.feeBps()).to.equal(50n);
    await expect(Orders.connect(other).setFee(10)).to.be.reverted;
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(3000));
    for (let i = 0; i < 3; i++) await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), E("0.9"));
    await Orders.connect(maker).cancelOrder(1);
    expect((await Orders.openOrders(0, 100)).map(Number)).to.deep.equal([0, 2]);
  });
});
