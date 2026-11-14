const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const MIN = 4295128740n;
const E = ethers.parseEther;
const DAY = 86400, HOUR = 3600;

function mine(deployer, initHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(deployer, salt, initHash)) & 0x3fffn) === 0x20ccn) return salt;
  }
}

describe("pad battles on a mainnet fork", function () {
  this.timeout(600000);
  let hook, factory, battle, router, owner, alice, bob, carol, dave, A, B, C, D, E2;
  const startTick = Math.floor(Math.log(2e8) / Math.log(1.0001) / 60) * 60;
  const id = (k) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
  const buy = (k, who, eth) => router.connect(who).swap(k, { zeroForOne: true, amountSpecified: -eth, sqrtPriceLimitX96: MIN + 1n }, { takeClaims: false, settleUsingBurn: false }, "0x", { value: eth });
  const inf = (k) => hook.info(id(k));

  async function launch(who, war) {
    await (await factory.connect(who).launch("Pad Test", "PT", startTick, war)).wait();
    const k = await factory.keyAt(Number(await factory.launchCount()) - 1);
    return { key: { currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] }, tok: (await ethers.getContractFactory("PadToken")).attach(k[1]) };
  }
  async function owed(keys) { let t = await hook.platformOwed(); for (const k of keys) { const i = await inf(k); t += i.chest + i.creatorOwed + i.holderOwed; } return t; }

  before(async () => {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const Hd = await (await ethers.getContractFactory("HookDeployer")).deploy();
    const H = await ethers.getContractFactory("PadHook");
    const init = ethers.concat([H.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [PM, owner.address])]);
    const salt = mine(await Hd.getAddress(), ethers.keccak256(init));
    await Hd.deploy(salt, init);
    hook = H.attach(ethers.getCreate2Address(await Hd.getAddress(), salt, ethers.keccak256(init)));
    factory = await (await ethers.getContractFactory("PadFactory")).deploy(PM, await hook.getAddress());
    battle = await (await ethers.getContractFactory("PadBattle")).deploy(await hook.getAddress());
    await hook.setFactory(await factory.getAddress());
    await hook.setBattle(await battle.getAddress());
    await expect(hook.setBattle(owner.address)).to.be.reverted;            // wiring is one-time
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(PM);
    A = await launch(alice, true); B = await launch(bob, true); C = await launch(carol, false);
  });

  it("only the creator of a war-mode pool can challenge, with sane terms", async () => {
    await expect(battle.connect(bob).challenge(A.key, B.key, DAY)).to.be.reverted;        // not A's creator
    await expect(battle.connect(carol).challenge(C.key, B.key, DAY)).to.be.reverted;      // peace mode can't fight
    await expect(battle.connect(alice).challenge(A.key, A.key, DAY)).to.be.reverted;      // not yourself
    await expect(battle.connect(alice).challenge(A.key, B.key, 60)).to.be.reverted;       // too short
    await expect(battle.connect(alice).challenge(A.key, B.key, 30 * DAY)).to.be.reverted; // too long
  });

  it("an accepted battle locks both pools; the clock only counts volume from acceptance", async () => {
    await buy(A.key, carol, E("1")); await buy(B.key, carol, E("1"));
    await buy(B.key, dave, E("5"));                                       // B has lots of volume BEFORE the fight
    await battle.connect(alice).challenge(A.key, B.key, DAY);
    await expect(battle.connect(alice).accept(0)).to.be.reverted;          // only B's creator accepts
    await battle.connect(bob).accept(0);
    expect((await inf(A.key)).locked).to.equal(true);
    expect((await inf(B.key)).locked).to.equal(true);
    await expect(hook.connect(alice).setMode(A.key, false)).to.be.reverted;
    await expect(hook.connect(alice).burnChest(A.key, 0)).to.be.reverted;  // can't empty the chest mid-fight
    await expect(hook.connect(bob).burnChest(B.key, 0)).to.be.reverted;
    await battle.connect(alice).challenge(A.key, B.key, DAY);               // a second offer...
    await expect(battle.connect(bob).accept(1)).to.be.reverted;             // ...can't start while locked
    await expect(battle.connect(owner).settle(0)).to.be.reverted;           // clock not up
  });

  it("settles by volume since the start, the winner takes the loser's chest, combined chest is marked to burn", async () => {
    await buy(A.key, carol, E("2")); await buy(B.key, dave, E("0.5"));
    await time.increase(DAY + 5);
    const aChest0 = (await inf(A.key)).chest, bChest0 = (await inf(B.key)).chest;
    await battle.connect(dave).settle(0);                                   // anyone can settle
    const a = await inf(A.key), b = await inf(B.key);
    expect(a.locked).to.equal(false); expect(b.locked).to.equal(false);
    expect(b.chest).to.equal(0n);
    expect(a.chest).to.equal(aChest0 + bChest0);
    expect(await hook.forced(id(A.key))).to.equal(a.chest);
    console.log("   A won; chest", ethers.formatEther(a.chest), "ETH (B's", ethers.formatEther(bChest0), "moved over)");
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(await owed([A.key, B.key, C.key]));
    await expect(battle.connect(dave).settle(0)).to.be.reverted;           // only once
  });

  it("the burn happens even if the creator never acts: anyone, in small steps, an hour apart", async () => {
    const tok = A.tok, s0 = await tok.totalSupply();
    const f0 = await hook.forced(id(A.key));
    await hook.connect(dave).burnForced(A.key, 0);
    const f1 = await hook.forced(id(A.key));
    expect(f0 - f1).to.equal(E("0.05"));
    expect(await tok.totalSupply()).to.be.lt(s0);
    await expect(hook.connect(dave).burnForced(A.key, 0)).to.be.reverted;   // too soon
    await time.increase(HOUR + 1);
    await hook.connect(dave).burnForced(A.key, 0);
    expect(await hook.forced(id(A.key))).to.be.lt(f1);
    expect(await ethers.provider.getBalance(await hook.getAddress())).to.equal(await owed([A.key, B.key, C.key]));
  });

  it("the winning creator can burn the rest at once; later buys are theirs to decide", async () => {
    const s0 = await A.tok.totalSupply();
    await hook.connect(alice).burnForced(A.key, 0);
    expect(await hook.forced(id(A.key))).to.equal(0n);
    expect((await inf(A.key)).chest).to.equal(0n);
    expect(await A.tok.totalSupply()).to.be.lt(s0);
    await buy(A.key, carol, E("1"));
    expect((await inf(A.key)).chest).to.equal(E("0.03"));                   // new tax is back to the creator's control
    expect(await hook.forced(id(A.key))).to.equal(0n);
    await hook.connect(alice).setMode(A.key, false); await hook.connect(alice).setMode(A.key, true); // unlocked again
  });

  it("a tie moves nothing and unlocks both", async () => {
    const t1 = await launch(alice, true), t2 = await launch(bob, true);
    await buy(t1.key, carol, E("1")); await buy(t2.key, carol, E("1"));
    const n = Number(await battle.count());
    await battle.connect(alice).challenge(t1.key, t2.key, HOUR);
    await battle.connect(bob).accept(n);
    await time.increase(HOUR + 5);
    const c1 = (await inf(t1.key)).chest, c2 = (await inf(t2.key)).chest;
    await battle.settle(n);
    expect((await inf(t1.key)).chest).to.equal(c1); expect((await inf(t2.key)).chest).to.equal(c2);
    expect((await inf(t1.key)).locked).to.equal(false); expect((await inf(t2.key)).locked).to.equal(false);
  });

  it("offers can be withdrawn or lapse; a lapsed offer can't be accepted", async () => {
    const x = await launch(alice, true), y = await launch(bob, true);
    const n = Number(await battle.count());
    await battle.connect(alice).challenge(x.key, y.key, DAY);
    await expect(battle.connect(carol).cancel(n)).to.be.reverted;           // strangers can't cancel a live offer
    await battle.connect(alice).cancel(n);
    await expect(battle.connect(bob).accept(n)).to.be.reverted;
    await battle.connect(alice).challenge(x.key, y.key, DAY);
    await time.increase(3 * DAY + 5);
    await expect(battle.connect(bob).accept(n + 1)).to.be.reverted;         // lapsed
    await battle.connect(carol).cancel(n + 1);                              // anyone can clear it
  });

  it("a creator who switches to peace first can't be dragged into a fight", async () => {
    const x = await launch(alice, true), y = await launch(bob, true);
    const n = Number(await battle.count());
    await battle.connect(alice).challenge(x.key, y.key, DAY);
    await hook.connect(bob).setMode(y.key, false);
    await expect(battle.connect(bob).accept(n)).to.be.reverted;             // must be at war to accept
  });
});
