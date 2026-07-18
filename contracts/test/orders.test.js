const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const RATE = 1000n;  // mock router: 1 ETH = 1000 TOKEN

async function deploy() {
  const [owner, feeWallet, maker, keeper, other] = await ethers.getSigners();
  const WETH = await (await ethers.getContractFactory("MockWETH")).deploy();
  const TOKEN = await (await ethers.getContractFactory("MockERC20")).deploy();
  const Router = await (await ethers.getContractFactory("MockSwapRouter02")).deploy(await WETH.getAddress(), RATE);
  const Pool = await (await ethers.getContractFactory("MockV3Pool")).deploy();
  const Factory = await (await ethers.getContractFactory("MockV3Factory")).deploy();
  await Factory.setPool(await Pool.getAddress());
  const Orders = await (await ethers.getContractFactory("SherwoodOrders")).deploy(
    await Router.getAddress(), await WETH.getAddress(), await Factory.getAddress(), feeWallet.address);
  await owner.sendTransaction({ to: await WETH.getAddress(), value: E(100) });  // back withdrawals
  await WETH.testMint(await Router.getAddress(), E(100));                        // router WETH inventory
  await TOKEN.mint(maker.address, E(1_000_000));
  return { owner, feeWallet, maker, keeper, other, WETH, TOKEN, Router, Pool, Factory, Orders };
}

describe("SherwoodOrders — limit / stop-loss / take-profit", () => {
  it("TAKE-PROFIT sell: fills only when price crosses ABOVE the trigger", async () => {
    const { Orders, TOKEN, Pool, maker, keeper, feeWallet } = await deploy();
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(1000));
    // sell 1000 TOKEN, trigger when sqrtP >= 1000, floor 0.9 ETH (gross 1 ETH -> 0.99 net)
    await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), 1000, true, E("0.9"));
    // below trigger -> not fillable
    await Pool.setSqrt(500);
    expect(await Orders.isFillable(0)).to.equal(false);
    await expect(Orders.connect(keeper).execute(0)).to.be.revertedWith("not triggered");
    // at/above trigger -> fills
    await Pool.setSqrt(1500);
    expect(await Orders.isFillable(0)).to.equal(true);
    const feeBefore = await ethers.provider.getBalance(feeWallet.address);
    const makerBefore = await ethers.provider.getBalance(maker.address);
    await Orders.connect(keeper).execute(0);   // keeper pays gas, maker is paid
    expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(feeBefore + E("0.01"));
    expect(await ethers.provider.getBalance(maker.address)).to.equal(makerBefore + E("0.99"));
    expect((await Orders.getOrder(0)).active).to.equal(false);
    expect(await ethers.provider.getBalance(await Orders.getAddress())).to.equal(0);
  });

  it("STOP-LOSS sell: fills only when price falls to/below the stop", async () => {
    const { Orders, TOKEN, Pool, maker, keeper } = await deploy();
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(1000));
    // stop-loss: triggerAbove=false -> fill when sqrtP <= 800
    await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), 800, false, E("0.5"));
    await Pool.setSqrt(1200);  // still above stop
    await expect(Orders.connect(keeper).execute(0)).to.be.revertedWith("not triggered");
    await Pool.setSqrt(700);   // dropped below stop
    const makerBefore = await ethers.provider.getBalance(maker.address);
    await Orders.connect(keeper).execute(0);
    expect(await ethers.provider.getBalance(maker.address)).to.equal(makerBefore + E("0.99"));
  });

  it("LIMIT BUY: escrow ETH, fill when price drops to/below target", async () => {
    const { Orders, TOKEN, Pool, maker, keeper } = await deploy();
    // buy with 1 ETH, trigger when sqrtP <= 1000, want >= 900 TOKEN (0.99 ETH * 1000 = 990)
    await Orders.connect(maker).createBuyOrder(await TOKEN.getAddress(), 10000, 1000, false, E(900), { value: E(1) });
    await Pool.setSqrt(1500);  // above target -> not triggered
    await expect(Orders.connect(keeper).execute(0)).to.be.revertedWith("not triggered");
    await Pool.setSqrt(800);   // dipped to target
    await Orders.connect(keeper).execute(0);
    expect(await TOKEN.balanceOf(maker.address)).to.equal(E(1_000_000) + E(990)); // 990 delivered to maker
    expect(await ethers.provider.getBalance(await Orders.getAddress())).to.equal(0);
  });

  it("minOut floor: a fill that can't meet minOut reverts (keeper can't dump the maker)", async () => {
    const { Orders, TOKEN, Pool, maker, keeper } = await deploy();
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(1000));
    // trigger met, but demand 2 ETH out for 1000 TOKEN (only ~1 possible) -> swap reverts on minOut
    await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), 1000, true, E(2));
    await Pool.setSqrt(1500);
    await expect(Orders.connect(keeper).execute(0)).to.be.revertedWith("Too little received");
  });

  it("cancel: maker gets escrow back (token for sells, ETH for buys)", async () => {
    const { Orders, TOKEN, maker, other } = await deploy();
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(1000));
    await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), 1000, true, E("0.9"));
    await expect(Orders.connect(other).cancelOrder(0)).to.be.revertedWith("not maker");
    const before = await TOKEN.balanceOf(maker.address);
    await Orders.connect(maker).cancelOrder(0);
    expect(await TOKEN.balanceOf(maker.address)).to.equal(before + E(1000));
    await expect(Orders.connect(maker).execute?.(0)).to.be.reverted; // closed
  });

  it("fee admin + openOrders pager", async () => {
    const { Orders, TOKEN, owner, other, maker } = await deploy();
    await expect(Orders.connect(owner).setFee(301)).to.be.revertedWith("fee too high");
    await Orders.connect(owner).setFee(50); expect(await Orders.feeBps()).to.equal(50n);
    await expect(Orders.connect(other).setFee(10)).to.be.reverted;
    await TOKEN.connect(maker).approve(await Orders.getAddress(), E(3000));
    for (let i = 0; i < 3; i++) await Orders.connect(maker).createSellOrder(await TOKEN.getAddress(), 10000, E(1000), 1000, true, E("0.9"));
    await Orders.connect(maker).cancelOrder(1);
    expect((await Orders.openOrders(0, 100)).map(Number)).to.deep.equal([0, 2]);
  });
});
