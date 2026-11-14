const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, fundStag, deployStack, mk } = require("./helpers");
const DAY = 86400, HOUR = 3600;

describe("pad v2 battles on a mainnet fork", function () {
  this.timeout(900000);
  let owner, alice, bob, carol, dave, P, A, B, C;

  before(async () => {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();
    await fundStag([owner, alice, bob, carol, dave], E(400_000_000));
    P = mk(await deployStack(owner), [owner, alice, bob, carol, dave]);
    A = await P.launch(alice, true); B = await P.launch(bob, true); C = await P.launch(carol, false);
  });

  it("only the creator of a war-mode, unlocked pool can challenge, with sane terms", async () => {
    const { battle } = P;
    await expect(battle.connect(bob).challenge(A.key, B.key, DAY)).to.be.reverted;        // not A's creator
    await expect(battle.connect(carol).challenge(C.key, B.key, DAY)).to.be.reverted;      // peace mode can't fight
    await expect(battle.connect(alice).challenge(A.key, A.key, DAY)).to.be.reverted;      // not yourself
    await expect(battle.connect(alice).challenge(A.key, B.key, 60)).to.be.reverted;       // too short
    await expect(battle.connect(alice).challenge(A.key, B.key, 30 * DAY)).to.be.reverted; // too long
  });

  it("REGRESSION making an offer locks the challenger, so they cannot empty their chest before you accept", async () => {
    await P.buy(A, carol, E(1_000_000)); await P.buy(B, carol, E(1_000_000)); await P.buy(B, dave, E(5_000_000)); // B has lots of volume BEFORE the fight
    await P.battle.connect(alice).challenge(A.key, B.key, DAY);
    expect((await P.inf(A)).locked).to.equal(true);
    await expect(P.hook.connect(alice).burnChest(A.key, 0)).to.be.reverted;
    await expect(P.hook.connect(alice).setMode(A.key, false)).to.be.reverted;
    await expect(P.battle.connect(alice).challenge(A.key, B.key, DAY)).to.be.reverted;    // one open offer at a time
    await expect(P.battle.connect(alice).accept(0)).to.be.reverted;                        // only B's creator accepts
    await P.battle.connect(bob).accept(0);
    expect((await P.inf(B)).locked).to.equal(true);
    await expect(P.hook.connect(bob).burnChest(B.key, 0)).to.be.reverted;
    await expect(P.battle.connect(owner).settle(0)).to.be.reverted;                        // clock not up
  });

  it("REGRESSION volume stops counting at the end time: a last-second buy can't flip the result", async () => {
    await P.buy(A, carol, E(2_000_000)); await P.buy(B, dave, E(500_000));                 // A leads during the fight
    await time.increase(DAY + 5);
    const vB = (await P.inf(B)).volume;
    await P.buy(B, dave, E(40_000_000));                                                   // B's creator-side whale buys AFTER the end
    expect((await P.inf(B)).volume).to.equal(vB);                                          // not counted
    const aChest0 = (await P.inf(A)).chest, bChest0 = (await P.inf(B)).chest;
    await P.battle.connect(dave).settle(0);
    const a = await P.inf(A), b = await P.inf(B);
    expect(a.locked).to.equal(false); expect(b.locked).to.equal(false);
    expect(b.chest).to.equal(0n);                                                          // A won: B's chest moved over
    expect(a.chest).to.equal(aChest0 + bChest0);
    expect(await P.hook.forced(A.id)).to.equal(a.chest);
    console.log("   A won; chest", ethers.formatEther(a.chest), "STAG (B's", ethers.formatEther(bChest0), "moved over)");
    expect(await P.solvent([A, B, C])).to.equal(true);
    await expect(P.battle.connect(dave).settle(0)).to.be.reverted;                         // only once
  });

  it("the burn happens even if the creator never acts: anyone, in steps, an hour apart", async () => {
    const f0 = await P.hook.forced(A.id), s0 = await A.tok.totalSupply();
    await P.hook.connect(dave).burnForced(A.key, 0);
    expect(await P.hook.forced(A.id)).to.be.lt(f0);
    expect(await A.tok.totalSupply()).to.be.lt(s0);
    await expect(P.hook.connect(dave).burnForced(A.key, 0)).to.be.reverted;                // too soon
    await time.increase(HOUR + 1);
    await P.hook.connect(dave).burnForced(A.key, 0);
    expect(await P.solvent([A, B, C])).to.equal(true);
  });

  it("REGRESSION the winner cannot use the forced burn to empty its chest once a new fight locks the pool", async () => {
    const x = await P.launch(dave, true);
    await P.buy(x, carol, E(1_000_000));
    const f = await P.hook.forced(A.id);
    expect(f).to.be.gt(0n);                                                                 // A still has forced chest left
    await P.battle.connect(alice).challenge(A.key, x.key, DAY);                            // A's creator offers a new fight: A locks
    await expect(P.hook.connect(alice).burnForced(A.key, 0)).to.be.reverted;               // creator
    await time.increase(HOUR + 1);
    await expect(P.hook.connect(carol).burnForced(A.key, 0)).to.be.reverted;               // anyone
    await P.battle.connect(alice).cancel(Number(await P.battle.count()) - 1);              // withdraw: A is free again
    expect((await P.inf(A)).locked).to.equal(false);
    await P.hook.connect(alice).burnForced(A.key, 0);                                      // and the creator may burn it all
  });

  it("a tie moves nothing and unlocks both", async () => {
    const t1 = await P.launch(alice, true), t2 = await P.launch(bob, true);
    await P.buy(t1, carol, E(1_000_000)); await P.buy(t2, carol, E(1_000_000));
    const n = Number(await P.battle.count());
    await P.battle.connect(alice).challenge(t1.key, t2.key, HOUR);
    await P.battle.connect(bob).accept(n);
    await time.increase(HOUR + 5);
    const c1 = (await P.inf(t1)).chest, c2 = (await P.inf(t2)).chest;
    await P.battle.settle(n);
    expect((await P.inf(t1)).chest).to.equal(c1); expect((await P.inf(t2)).chest).to.equal(c2);
    expect((await P.inf(t1)).locked).to.equal(false); expect((await P.inf(t2)).locked).to.equal(false);
  });

  it("offers can be withdrawn or lapse (and free the challenger); a lapsed offer can't be accepted", async () => {
    const x = await P.launch(alice, true), y = await P.launch(bob, true);
    const n = Number(await P.battle.count());
    await P.battle.connect(alice).challenge(x.key, y.key, DAY);
    await expect(P.battle.connect(carol).cancel(n)).to.be.reverted;                        // strangers can't cancel a live offer
    await P.battle.connect(alice).cancel(n);
    expect((await P.inf(x)).locked).to.equal(false);
    await expect(P.battle.connect(bob).accept(n)).to.be.reverted;
    await P.battle.connect(alice).challenge(x.key, y.key, DAY);
    await time.increase(3 * DAY + 5);
    await expect(P.battle.connect(bob).accept(n + 1)).to.be.reverted;                      // lapsed
    await P.battle.connect(carol).cancel(n + 1);                                           // anyone can clear it
    expect((await P.inf(x)).locked).to.equal(false);
  });

  it("an opponent who went peace can't be dragged in, and one in another fight can't accept", async () => {
    const x = await P.launch(alice, true), y = await P.launch(bob, true), z = await P.launch(carol, true);
    const n = Number(await P.battle.count());
    await P.battle.connect(alice).challenge(x.key, y.key, DAY);
    await P.battle.connect(carol).challenge(z.key, y.key, DAY);
    await P.battle.connect(bob).accept(n);
    await expect(P.battle.connect(bob).accept(n + 1)).to.be.reverted;                      // y already locked
    await P.battle.connect(carol).cancel(n + 1);
    const w = await P.launch(alice, true), v = await P.launch(bob, true);
    const m = Number(await P.battle.count());
    await P.battle.connect(alice).challenge(w.key, v.key, DAY);
    await P.battle.connect(alice).cancel(m);
    await P.hook.connect(bob).setMode(v.key, false);
    await P.battle.connect(alice).challenge(w.key, v.key, DAY);
    await expect(P.battle.connect(bob).accept(m + 1)).to.be.reverted;                      // must be at war
  });
});
