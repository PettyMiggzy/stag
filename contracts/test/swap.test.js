const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const RATE = 1000n;   // 1 ETH = 1000 TOKEN in the mock router

async function deploy() {
  const [owner, feeWallet, user, other] = await ethers.getSigners();
  const WETH = await (await ethers.getContractFactory("MockWETH")).deploy();
  const TOKEN = await (await ethers.getContractFactory("MockERC20")).deploy();
  const Router = await (await ethers.getContractFactory("MockSwapRouter02")).deploy(await WETH.getAddress(), RATE);
  const Swap = await (await ethers.getContractFactory("SherwoodSwap")).deploy(
    await Router.getAddress(), await WETH.getAddress(), feeWallet.address);
  // fund the WETH contract with ETH (to back withdrawals) + give the router WETH inventory for sells
  await owner.sendTransaction({ to: await WETH.getAddress(), value: E(100) });
  await WETH.testMint(await Router.getAddress(), E(100));
  return { owner, feeWallet, user, other, WETH, TOKEN, Router, Swap };
}

describe("SherwoodSwap — fee-taking swap router", () => {
  it("BUY: 1% fee to feeWallet, rest swapped to the buyer", async () => {
    const { Swap, TOKEN, user, feeWallet } = await deploy();
    const feeBefore = await ethers.provider.getBalance(feeWallet.address);
    await Swap.connect(user).buy(await TOKEN.getAddress(), 10000, 0, { value: E(1) });
    // fee = 0.01 ETH; amountIn = 0.99 ETH -> 990 TOKEN
    expect(await TOKEN.balanceOf(user.address)).to.equal(E(990));
    expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(feeBefore + E("0.01"));
    // nothing stuck in the swap contract
    expect(await ethers.provider.getBalance(await Swap.getAddress())).to.equal(0);
  });

  it("SELL: token -> ETH, 1% fee to feeWallet, rest to the seller", async () => {
    const { Swap, TOKEN, WETH, user, feeWallet } = await deploy();
    await TOKEN.mint(user.address, E(1000));
    await TOKEN.connect(user).approve(await Swap.getAddress(), E(1000));
    const feeBefore = await ethers.provider.getBalance(feeWallet.address);
    const userBefore = await ethers.provider.getBalance(user.address);
    // 1000 TOKEN -> 1 WETH -> 1 ETH; fee 0.01 -> feeWallet; user nets 0.99 (minus gas)
    const tx = await Swap.connect(user).sell(await TOKEN.getAddress(), 10000, E(1000), 0);
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(feeBefore + E("0.01"));
    const userAfter = await ethers.provider.getBalance(user.address);
    expect(userAfter).to.equal(userBefore + E("0.99") - gas);
    expect(await TOKEN.balanceOf(user.address)).to.equal(0);
    expect(await ethers.provider.getBalance(await Swap.getAddress())).to.equal(0);
    expect(await WETH.balanceOf(await Swap.getAddress())).to.equal(0);
  });

  it("slippage: reverts when out < minOut", async () => {
    const { Swap, TOKEN, user } = await deploy();
    await expect(
      Swap.connect(user).buy(await TOKEN.getAddress(), 10000, E(100000), { value: E(1) })
    ).to.be.revertedWith("Too little received");
  });

  it("blocks bad inputs: zero eth, weth-as-token", async () => {
    const { Swap, WETH, TOKEN, user } = await deploy();
    await expect(Swap.connect(user).buy(await TOKEN.getAddress(), 10000, 0, { value: 0 })).to.be.revertedWith("no eth");
    await expect(Swap.connect(user).buy(await WETH.getAddress(), 10000, 0, { value: E(1) })).to.be.revertedWith("bad token");
    await expect(Swap.connect(user).sell(await TOKEN.getAddress(), 10000, 0, 0)).to.be.revertedWith("no amount");
  });

  it("fee admin: cap enforced, owner-only, retunable", async () => {
    const { Swap, owner, other, feeWallet, TOKEN, user } = await deploy();
    await expect(Swap.connect(owner).setFee(301)).to.be.revertedWith("fee too high");
    await expect(Swap.connect(other).setFee(50)).to.be.reverted;
    await Swap.connect(owner).setFee(50); // 0.5%
    expect(await Swap.feeBps()).to.equal(50n);
    // a buy now takes 0.5%
    const feeBefore = await ethers.provider.getBalance(feeWallet.address);
    await Swap.connect(user).buy(await TOKEN.getAddress(), 10000, 0, { value: E(1) });
    expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(feeBefore + E("0.005"));
    expect(await TOKEN.balanceOf(user.address)).to.equal(E(995));
    await Swap.connect(owner).setFeeWallet(other.address);
    expect(await Swap.feeWallet()).to.equal(other.address);
  });

  it("rescue: owner can sweep stray tokens/ETH", async () => {
    const { Swap, TOKEN, owner, other } = await deploy();
    await TOKEN.mint(await Swap.getAddress(), E(7));   // stray tokens sent directly
    await Swap.connect(owner).rescue(await TOKEN.getAddress(), other.address);
    expect(await TOKEN.balanceOf(other.address)).to.equal(E(7));
    await expect(Swap.connect(other).rescue(await TOKEN.getAddress(), other.address)).to.be.reverted;
  });
});
