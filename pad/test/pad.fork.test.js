const { expect } = require("chai");
const { ethers } = require("hardhat");

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const MIN = 4295128740n, MAXP = 1461446703485210103287273052203988822378723970341n;
const E = ethers.parseEther;

function mine(deployer, initHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(deployer, salt, initHash);
    if ((BigInt(a) & 0x3fffn) === 0x20ccn) return salt;
  }
}

describe("pad on a mainnet fork", function () {
  this.timeout(600000);
  let hook, factory, router, owner, alice, bob, key, token, key2, token2;
  const startTick = Math.floor(Math.log(2e8) / Math.log(1.0001) / 60) * 60;

  const buy = (k, who, eth, exactOut = 0n) => router.connect(who).swap(k,
    { zeroForOne: true, amountSpecified: exactOut ? exactOut : -eth, sqrtPriceLimitX96: MIN + 1n },
    { takeClaims: false, settleUsingBurn: false }, "0x", { value: exactOut ? eth : eth });
  const sell = (k, who, amt, exactOutEth = 0n) => router.connect(who).swap(k,
    { zeroForOne: false, amountSpecified: exactOutEth ? exactOutEth : -amt, sqrtPriceLimitX96: MAXP - 1n },
    { takeClaims: false, settleUsingBurn: false }, "0x");

  before(async () => {
    [owner, alice, bob] = await ethers.getSigners();
    const Hd = await (await ethers.getContractFactory("HookDeployer")).deploy();
    const H = await ethers.getContractFactory("PadHook");
    const init = ethers.concat([H.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [PM, owner.address])]);
    const salt = mine(await Hd.getAddress(), ethers.keccak256(init));
    await Hd.deploy(salt, init);
    hook = H.attach(ethers.getCreate2Address(await Hd.getAddress(), salt, ethers.keccak256(init)));
    factory = await (await ethers.getContractFactory("PadFactory")).deploy(PM, await hook.getAddress());
    await hook.setFactory(await factory.getAddress());
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(PM);
    console.log("hook", await hook.getAddress(), "startTick", startTick);
  });

  async function launch(who, war) {
    const r = await (await factory.connect(who).launch("Pad Test", "PT", startTick, war)).wait();
    const idx = Number(await factory.launchCount()) - 1;
    const k = await factory.keyAt(idx);
    const key = { currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] };
    const tok = (await ethers.getContractFactory("PadToken")).attach(k[1]);
    return { key, tok };
  }
  const id = (k) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
  const totalOwed = async (ks) => { let t = await hook.platformOwed(); for (const k of ks) { const i = await hook.info(id(k)); t += i.chest + i.creatorOwed + i.holderOwed; } return t; };

  it("launches a token with the whole supply in locked one-sided liquidity", async () => {
    ({ key, tok: token } = await launch(alice, true));
    expect(await token.totalSupply()).to.equal(E("1000000000"));
    expect(await token.balanceOf(PM)).to.be.gte(E("999999999"));
    const i = await hook.info(id(key));
    expect(i.creator).to.equal(alice.address); expect(i.war).to.equal(true);
  });

  it("buy exact-in: 3% of the ETH goes to the war chest", async () => {
    await buy(key, bob, E("1"));
    const i = await hook.info(id(key));
    expect(i.chest).to.equal(E("0.03"));
    expect(await token.balanceOf(bob.address)).to.be.gt(0n);
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(await totalOwed([key]));
  });

  it("buy exact-out: the tax is added on top of what the tokens cost", async () => {
    const before = (await hook.info(id(key))).chest;
    const bal = await token.balanceOf(bob.address);
    await buy(key, bob, E("5"), E("1000000")); // ask for exactly 1,000,000 tokens, send surplus (refunded)
    expect((await token.balanceOf(bob.address)) - bal).to.equal(E("1000000"));
    expect((await hook.info(id(key))).chest).to.be.gt(before);
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(await totalOwed([key]));
  });

  it("sell exact-in: 3% of the ETH out goes to the platform", async () => {
    const p0 = await hook.platformOwed();
    const amt = (await token.balanceOf(bob.address)) / 2n;
    await token.connect(bob).approve(await router.getAddress(), amt);
    const e0 = await ethers.provider.getBalance(bob.address);
    await sell(key, bob, amt);
    const fee = (await hook.platformOwed()) - p0;
    expect(fee).to.be.gt(0n);
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(await totalOwed([key]));
    console.log("   sold", ethers.formatEther(amt), "tokens, platform took", ethers.formatEther(fee), "ETH");
  });

  it("sell exact-out: the tax comes out of what the pool pays", async () => {
    const p0 = await hook.platformOwed();
    const bal = await token.balanceOf(bob.address);
    await token.connect(bob).approve(await router.getAddress(), bal);
    await sell(key, bob, 0n, E("0.2"));
    expect((await hook.platformOwed()) - p0).to.equal(E("0.006"));
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(await totalOwed([key]));
  });

  it("the creator can burn the chest into the token, without paying the tax again", async () => {
    const supply0 = await token.totalSupply();
    const c = (await hook.info(id(key))).chest;
    await expect(hook.connect(bob).burnChest(key, 0)).to.be.reverted;      // not the creator
    await hook.connect(alice).burnChest(key, 0);
    expect((await hook.info(id(key))).chest).to.equal(0n);
    expect(await token.totalSupply()).to.be.lt(supply0);
    console.log("   chest", ethers.formatEther(c), "ETH burned", ethers.formatEther(supply0 - await token.totalSupply()), "tokens");
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(await totalOwed([key]));
  });

  it("nobody can pull ETH out of a chest and the platform can only take its own share", async () => {
    await buy(key, bob, E("1"));
    const h0 = await ethers.provider.getBalance(await hook.getAddress());
    const o0 = await hook.platformOwed();
    await hook.claimPlatform(owner.address);
    expect(await hook.platformOwed()).to.equal(0n);
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(h0 - o0);
    expect((await hook.info(id(key))).chest).to.equal(E("0.03"));
    await expect(hook.connect(bob).claimPlatform(bob.address)).to.be.reverted;
  });

  it("peace mode: 1% to the creator, 2% to holders, holders can claim", async () => {
    ({ key: key2, tok: token2 } = await launch(alice, false));
    await buy(key2, bob, E("1"));
    const i = await hook.info(id(key2));
    expect(i.chest).to.equal(0n);
    expect(i.creatorOwed).to.equal(E("0.01"));
    expect(i.holderOwed).to.equal(E("0.02"));
    await hook.connect(alice).claimCreator(key2, alice.address);
    await hook.pushHolders(key2);
    const c = await token2.claimable(bob.address);
    console.log("   bob can claim", ethers.formatEther(c), "ETH");
    expect(c).to.be.closeTo(E("0.02"), E("0.0000001"));
    await token2.connect(bob).claim();
    expect(await token2.claimable(bob.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(await token2.getAddress())).to.be.lt(E("0.000001"));
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(await totalOwed([key, key2]));
  });

  it("holders earn in proportion to what they held when the payout landed", async () => {
    // bob holds X; alice buys 3X-ish later; a fresh payout splits by balance
    await buy(key2, alice, E("3"));
    const [b, a] = [await token2.balanceOf(bob.address), await token2.balanceOf(alice.address)];
    const cb0 = await token2.claimable(bob.address), ca0 = await token2.claimable(alice.address);
    await buy(key2, owner, E("1"));
    await hook.pushHolders(key2);
    const db = (await token2.claimable(bob.address)) - cb0, da = (await token2.claimable(alice.address)) - ca0;
    // owner also holds tokens now; just check bob:alice ratio matches balances
    const ratio = Number(da * 1000n / db) / 1000, want = Number(a * 1000n / b) / 1000;
    console.log("   payout ratio alice:bob", ratio, "balance ratio", want);
    expect(Math.abs(ratio - want) / want).to.be.lt(0.01);
  });

  it("mode switch works for the creator only and affects later buys only", async () => {
    await expect(hook.connect(bob).setMode(key2, true)).to.be.reverted;
    await hook.connect(alice).setMode(key2, true);
    const c0 = (await hook.info(id(key2))).chest;
    await buy(key2, bob, E("1"));
    expect((await hook.info(id(key2))).chest - c0).to.equal(E("0.03"));
  });

  it("the creator collects LP fees; nobody else can", async () => {
    await expect(factory.connect(bob).collectFees(key, bob.address)).to.be.reverted;
    const e0 = await ethers.provider.getBalance(alice.address);
    await factory.connect(alice).collectFees(key, alice.address);
    console.log("   creator LP fee ETH collected:", ethers.formatEther((await ethers.provider.getBalance(alice.address)) - e0));
  });

  it("a pool with no registry entry can't use the hook", async () => {
    const bad = { ...key, tickSpacing: 10 };
    await expect(factory.connect(alice).launch("x", "x", 7, true)).to.be.reverted; // bad tick
    const pmc = await ethers.getContractAt("IPoolManager", PM);
    await expect(pmc.initialize(bad, 79228162514264337593543950336n)).to.be.reverted;
  });
});
