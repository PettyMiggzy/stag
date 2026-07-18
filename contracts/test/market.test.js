const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const ZERO = "0x0000000000000000000000000000000000000000";

async function deploy() {
  const [owner, feeWallet, maker, taker, other] = await ethers.getSigners();
  const market = await (await ethers.getContractFactory("SherwoodMarket")).deploy(feeWallet.address);
  const TokenA = await (await ethers.getContractFactory("MockERC20")).deploy(); // "sell" token
  const TokenB = await (await ethers.getContractFactory("MockERC20")).deploy(); // ERC20 "pay" token
  await TokenA.mint(maker.address, E(1_000_000));
  await TokenB.mint(taker.address, E(1_000_000));
  return { owner, feeWallet, maker, taker, other, market, TokenA, TokenB };
}

describe("SherwoodMarket — P2P token exchange", () => {
  it("escrows the sell token on createOrder", async () => {
    const { market, TokenA, maker } = await deploy();
    await TokenA.connect(maker).approve(await market.getAddress(), E(1000));
    await market.connect(maker).createOrder(await TokenA.getAddress(), E(1000), ZERO, E(1));
    expect(await TokenA.balanceOf(await market.getAddress())).to.equal(E(1000));
    const o = await market.getOrder(0);
    expect(o.maker).to.equal(maker.address);
    expect(o.sellAmount).to.equal(E(1000));
    expect(o.active).to.equal(true);
  });

  it("fills an ETH-priced order with 1%/1% fees to the fee wallet", async () => {
    const { market, TokenA, maker, taker, feeWallet } = await deploy();
    const mAddr = await market.getAddress();
    await TokenA.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await TokenA.getAddress(), E(1000), ZERO, E(1)); // sell 1000 A for 1 ETH

    const makerEthBefore = await ethers.provider.getBalance(maker.address);
    const feeEthBefore = await ethers.provider.getBalance(feeWallet.address);

    await market.connect(taker).fillOrder(0, { value: E(1) });

    // taker gets 99% of the token; fee wallet gets 1% of the token
    expect(await TokenA.balanceOf(taker.address)).to.equal(E(990));
    expect(await TokenA.balanceOf(feeWallet.address)).to.equal(E(10));
    // maker gets 99% of the ETH; fee wallet gets 1% of the ETH
    expect(await ethers.provider.getBalance(maker.address)).to.equal(makerEthBefore + E("0.99"));
    expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(feeEthBefore + E("0.01"));
    // order closed, escrow drained
    expect((await market.getOrder(0)).active).to.equal(false);
    expect(await TokenA.balanceOf(mAddr)).to.equal(0);
  });

  it("fills an ERC20-priced order with 1%/1% fees", async () => {
    const { market, TokenA, TokenB, maker, taker, feeWallet } = await deploy();
    const mAddr = await market.getAddress();
    await TokenA.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await TokenA.getAddress(), E(1000), await TokenB.getAddress(), E(500)); // 1000 A for 500 B
    await TokenB.connect(taker).approve(mAddr, E(500));

    await market.connect(taker).fillOrder(0);

    expect(await TokenA.balanceOf(taker.address)).to.equal(E(990));       // 99% of A
    expect(await TokenB.balanceOf(maker.address)).to.equal(E(495));       // 99% of B
    expect(await TokenA.balanceOf(feeWallet.address)).to.equal(E(10));    // 1% A
    expect(await TokenB.balanceOf(feeWallet.address)).to.equal(E(5));     // 1% B
  });

  it("maker can cancel and get the full escrow back", async () => {
    const { market, TokenA, maker } = await deploy();
    const mAddr = await market.getAddress();
    await TokenA.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await TokenA.getAddress(), E(1000), ZERO, E(1));
    const before = await TokenA.balanceOf(maker.address);
    await market.connect(maker).cancelOrder(0);
    expect(await TokenA.balanceOf(maker.address)).to.equal(before + E(1000));
    expect(await TokenA.balanceOf(mAddr)).to.equal(0);
  });

  it("blocks: fill own order, double-fill, cancelled fill, wrong ETH, non-maker cancel", async () => {
    const { market, TokenA, maker, taker, other } = await deploy();
    const mAddr = await market.getAddress();
    await TokenA.connect(maker).approve(mAddr, E(3000));
    await market.connect(maker).createOrder(await TokenA.getAddress(), E(1000), ZERO, E(1)); // id 0
    await market.connect(maker).createOrder(await TokenA.getAddress(), E(1000), ZERO, E(1)); // id 1

    await expect(market.connect(maker).fillOrder(0, { value: E(1) })).to.be.revertedWith("maker cannot fill own");
    await expect(market.connect(taker).fillOrder(0, { value: E("0.5") })).to.be.revertedWith("wrong ETH amount");
    await expect(market.connect(other).cancelOrder(0)).to.be.revertedWith("not maker");

    await market.connect(taker).fillOrder(0, { value: E(1) });
    await expect(market.connect(taker).fillOrder(0, { value: E(1) })).to.be.revertedWith("not open"); // double-fill
    await market.connect(maker).cancelOrder(1);
    await expect(market.connect(taker).fillOrder(1, { value: E(1) })).to.be.revertedWith("not open"); // cancelled
  });

  it("enforces the fee cap and lets owner retune fees + wallet", async () => {
    const { market, owner, other } = await deploy();
    await expect(market.connect(owner).setFees(301, 100)).to.be.revertedWith("fee too high");
    await market.connect(owner).setFees(200, 50); // 2% buy / 0.5% sell
    expect(await market.buyFeeBps()).to.equal(200n);
    expect(await market.sellFeeBps()).to.equal(50n);
    await market.connect(owner).setFeeWallet(other.address);
    expect(await market.feeWallet()).to.equal(other.address);
    // non-owner can't
    await expect(market.connect(other).setFees(100, 100)).to.be.reverted;
  });

  it("openOrders pager returns only active orders", async () => {
    const { market, TokenA, maker, taker } = await deploy();
    const mAddr = await market.getAddress();
    await TokenA.connect(maker).approve(mAddr, E(5000));
    for (let i = 0; i < 5; i++) await market.connect(maker).createOrder(await TokenA.getAddress(), E(1000), ZERO, E(1));
    await market.connect(taker).fillOrder(2, { value: E(1) }); // close id 2
    const open = (await market.openOrders(0, 100)).map(Number);
    expect(open).to.deep.equal([0, 1, 3, 4]);
  });
});
