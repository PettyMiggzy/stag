// Battles between brought-in pools (an unchanged PadBattle pointed at the open hook), the owner's bar, the read-only
// registry, and the hard limit between the two hooks. NEW, UNAUDITED code under test.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { fundStag, deployStack, mk } = require("./helpers");
const { STAG, DEAD, E, deployOpen, mkOpen, newToken, predictKey, poolId } = require("./open.helpers");
const DAY = 86400, HOUR = 3600;

describe("open pad battles and the shared registry (mainnet fork)", function () {
  this.timeout(900000);
  let owner, alice, bob, carol, dave, eve, S, P, V, PV, X, Y, L, M, reg;

  before(async () => {
    [owner, alice, bob, carol, dave, eve] = await ethers.getSigners();
    await fundStag([owner, alice, bob, carol, dave, eve], E(400_000_000));
    S = await deployOpen(owner);
    P = mkOpen(S, [owner, alice, bob, carol, dave, eve]);
    V = await deployStack(owner);                                    // the existing stack, deployed exactly as its own tests do
    PV = mk(V, [owner, alice, bob, carol, dave, eve]);
    X = await P.bring(alice, await newToken(alice, { name: "Xray", symbol: "XRY" }));
    Y = await P.bring(bob, await newToken(bob, { name: "Yoke", symbol: "YOK" }));
    L = await PV.launch(dave, true);                                 // a token launched the old way
    reg = await (await ethers.getContractFactory("PadRegistry")).deploy(await V.hook.getAddress(), await S.hook.getAddress());
  });

  it("only the creator (the wallet that seeded the pool) can offer or accept; strangers and the platform owner cannot", async () => {
    await expect(S.battle.connect(bob).challenge(X.key, Y.key, DAY)).to.be.reverted;       // not X's creator
    await expect(S.battle.connect(owner).challenge(X.key, Y.key, DAY)).to.be.reverted;     // not the platform either
    await expect(S.battle.connect(alice).challenge(X.key, X.key, DAY)).to.be.reverted;
    await expect(S.battle.connect(alice).challenge(X.key, Y.key, 60)).to.be.reverted;
    await S.battle.connect(alice).challenge(X.key, Y.key, DAY);
    await expect(S.battle.connect(alice).accept(0)).to.be.reverted;                        // only Y's creator accepts
    await expect(S.battle.connect(owner).accept(0)).to.be.reverted;
    await S.battle.connect(alice).cancel(0);
    expect((await P.inf(X)).locked).to.equal(false);
  });

  it("a full fight between two brought-in tokens: volume decides, only fight earnings move, the win is burned to the dead address", async () => {
    await P.buy(X, carol, E(1_000_000)); await P.buy(Y, carol, E(1_000_000)); await P.buy(Y, dave, E(5_000_000));   // Y has more volume BEFORE the fight
    const n = Number(await S.battle.count());
    await S.battle.connect(alice).challenge(X.key, Y.key, DAY);
    expect((await P.inf(X)).locked).to.equal(true);
    await expect(S.hook.connect(alice).burnChest(X.key, 0)).to.be.revertedWithCustomError(S.hook, "Locked");
    await expect(S.hook.connect(alice).setMode(X.key, false)).to.be.revertedWithCustomError(S.hook, "Locked");
    await S.battle.connect(bob).accept(n);
    await expect(S.battle.connect(carol).settle(n)).to.be.reverted;                        // clock not up
    await P.buy(X, carol, E(2_000_000)); await P.buy(Y, dave, E(500_000));                  // X leads during the fight
    await time.increase(DAY + 5);
    const xEnd = (await P.inf(X)).chest, yEnd = (await P.inf(Y)).chest, vY = (await P.inf(Y)).volume;
    await P.buy(Y, dave, E(40_000_000));                                                    // a whale buys Y AFTER the end
    expect((await P.inf(Y)).volume).to.equal(vY);                                           // not counted
    const bt = await S.battle.get(n), xNow = (await P.inf(X)).chest, yNow = (await P.inf(Y)).chest;
    await S.battle.connect(eve).settle(n);                                                  // anyone settles
    const x = await P.inf(X), y = await P.inf(Y);
    const loot = yEnd - bt.chestB0, earnX = xEnd - bt.chestA0;
    expect(loot).to.be.gt(0n);
    expect(y.chest).to.equal(yNow - loot); expect(x.chest).to.equal(xNow + loot);
    expect(await S.hook.forced(X.id)).to.equal(earnX + loot);
    expect(x.locked).to.equal(false); expect(y.locked).to.equal(false);
    await expect(S.battle.connect(eve).settle(n)).to.be.reverted;                           // only once
    expect(await P.balanced()).to.equal(true);

    // the forced burn: creator first, then anyone; tokens go to the dead address
    await expect(S.hook.connect(eve).burnForced(X.key, 0)).to.be.revertedWithCustomError(S.hook, "BurnTooSoon");
    await time.increase(15 * 60 + 5);
    const d0 = await X.tok.balanceOf(DEAD), f0 = await S.hook.forced(X.id), sup = await X.tok.totalSupply();
    await S.hook.connect(eve).burnForced(X.key, 0);
    expect((await X.tok.balanceOf(DEAD)) - d0).to.be.gt(0n);
    expect(await S.hook.forced(X.id)).to.be.lt(f0);
    expect(await X.tok.totalSupply()).to.equal(sup);
    await expect(S.battle.connect(alice).challenge(X.key, Y.key, DAY)).to.be.reverted;      // no new fight until the win is burned
    for (let i = 0; i < 200 && (await S.hook.forced(X.id)) > 0n; i++) { await time.increase(HOUR + 1); await S.hook.connect(alice).burnForced(X.key, 0); }
    expect(await S.hook.forced(X.id)).to.equal(0n);
    expect(await P.balanced()).to.equal(true);
  });

  it("a tie moves nothing; a peace-mode pool cannot fight; offers lapse and free the challenger", async () => {
    await S.hook.connect(bob).setMode(Y.key, false);                                        // Y goes to peace
    await expect(S.battle.connect(bob).challenge(Y.key, X.key, DAY)).to.be.reverted;        // peace cannot offer
    let n = Number(await S.battle.count());
    await S.battle.connect(alice).challenge(X.key, Y.key, DAY);
    await expect(S.battle.connect(bob).accept(n)).to.be.reverted;                           // nor accept
    await expect(S.battle.connect(eve).cancel(n)).to.be.reverted;                           // a stranger cannot cancel a live offer
    await time.increase(3 * DAY + 5);
    await expect(S.battle.connect(bob).accept(n)).to.be.reverted;                           // lapsed
    await S.battle.connect(eve).cancel(n);                                                  // anyone clears it
    expect((await P.inf(X)).locked).to.equal(false);
    await S.hook.connect(bob).setMode(Y.key, true);
    n = Number(await S.battle.count());
    await S.battle.connect(alice).challenge(X.key, Y.key, HOUR);
    await S.battle.connect(bob).accept(n);
    await time.increase(HOUR + 5);                                                          // nobody trades: equal volume
    const ca = (await P.inf(X)).chest, cb = (await P.inf(Y)).chest;
    await S.battle.settle(n);
    expect((await P.inf(X)).chest).to.equal(ca); expect((await P.inf(Y)).chest).to.equal(cb);
    expect(await S.hook.forced(X.id)).to.equal(0n); expect(await S.hook.forced(Y.id)).to.equal(0n);
    expect((await P.inf(X)).locked).to.equal(false); expect((await P.inf(Y)).locked).to.equal(false);
  });

  it("a token launched the old way fights a brought-in token once it is brought in itself (a second pool, on the open hook)", async () => {
    await PV.buy(L, dave, E(1_500_000));                                                    // the launcher of L buys some of it on its original pool
    const have = await L.tok.balanceOf(dave.address);
    expect(have).to.be.gt(E(60_000_000));
    const Lo = await P.bring(dave, L.tok, { amount: E(50_000_000), price: E("0.05") });     // 5% of supply, above the old pool's price
    expect(Lo.id).to.not.equal(L.id);                                                       // a different pool from the original one
    expect((await S.hook.info(Lo.id)).creator).to.equal(dave.address);
    const n = Number(await S.battle.count());
    await S.battle.connect(dave).challenge(Lo.key, Y.key, HOUR);
    await S.battle.connect(bob).accept(n);
    await P.buy(Lo, carol, E(3_000_000)); await P.buy(Y, carol, E(1_000_000));
    await time.increase(HOUR + 5);
    await S.battle.settle(n);
    const won = await S.hook.forced(Lo.id);
    expect(won).to.equal(E(3_000_000) * 3n / 100n + E(1_000_000) * 3n / 100n);              // its own fight earnings plus the loser's
    const d0 = await L.tok.balanceOf(DEAD), sup = await L.tok.totalSupply();
    await S.hook.connect(dave).burnForced(Lo.key, 0);
    expect((await L.tok.balanceOf(DEAD)) - d0).to.be.gt(0n);
    expect(await L.tok.totalSupply()).to.equal(sup);                                        // the open hook never calls the token's burn(), even when it has one
    const v1 = await PV.inf(L);
    expect(v1.locked).to.equal(false); expect(v1.creator).to.equal(dave.address);           // the original pool and its chest were never involved
    expect(await PV.solvent([L])).to.equal(true); expect(await P.balanced()).to.equal(true);
  });

  it("THE LIMIT: a pool on the old hook and a pool on the open hook cannot fight, on either battle contract", async () => {
    await PV.buy(L, carol, E(100_000));
    await expect(V.battle.connect(dave).challenge(L.key, Y.key, DAY)).to.be.reverted;       // old battle: Y is not registered on the old hook
    await expect(S.battle.connect(bob).challenge(Y.key, L.key, DAY)).to.be.reverted;        // open battle: L is not registered on the open hook
    await expect(S.battle.connect(dave).challenge(L.key, Y.key, DAY)).to.be.reverted;
    // neither battle contract can lock a pool on the other hook, and nobody else can lock anything
    await expect(V.hook.connect(owner).setLocked(L.key, true, 0)).to.be.revertedWithCustomError(V.hook, "NotAllowed");
    await expect(S.hook.connect(owner).setLocked(Y.key, true, 0)).to.be.revertedWithCustomError(S.hook, "NotAllowed");
    await expect(S.hook.connect(owner).settleChests(Y.key, X.key, 0, 0)).to.be.revertedWithCustomError(S.hook, "NotAllowed");
    expect(await V.hook.battle()).to.equal(await V.battle.getAddress());                    // the old hook still obeys only its own battle contract
    expect(await V.hook.factory()).to.equal(await V.factory.getAddress());
    expect((await PV.inf(L)).locked).to.equal(false); expect((await P.inf(Y)).locked).to.equal(false);
  });

  it("the old stack still runs its own battles, untouched, next to the open one", async () => {
    const m = M = await PV.launch(alice, true);
    await V.battle.connect(dave).challenge(L.key, m.key, HOUR);
    const n = Number(await V.battle.count()) - 1;
    await V.battle.connect(alice).accept(n);
    await PV.buy(L, carol, E(500_000)); await PV.buy(m, carol, E(100_000));
    await time.increase(HOUR + 5);
    await V.battle.settle(n);
    expect(await V.hook.forced(L.id)).to.be.gt(0n);
    expect(await PV.solvent([L, m])).to.equal(true);
  });

  it("the registry tells the two systems apart and names the battle contract that can run a given fight (or none)", async () => {
    expect(await reg.launchedHook()).to.equal(await V.hook.getAddress()); expect(await reg.launchedBattle()).to.equal(await V.battle.getAddress());
    expect(await reg.openHook()).to.equal(await S.hook.getAddress()); expect(await reg.openBattle()).to.equal(await S.battle.getAddress());
    const m = M;
    expect(await reg.systemOf(L.key)).to.equal(1n); expect(await reg.systemOf(X.key)).to.equal(2n);
    expect(await reg.isPadPool(L.key)).to.equal(true); expect(await reg.isPadPool(Y.key)).to.equal(true);
    const never = await predictKey(S, await (await newToken(eve)).getAddress());            // right hook, never registered
    expect(await reg.systemOf(never)).to.equal(0n); expect(await reg.isPadPool(never)).to.equal(false);
    expect(await reg.systemOf({ ...X.key, hooks: eve.address })).to.equal(0n);              // somebody else's hook
    expect(await reg.systemOf({ ...X.key, hooks: ethers.ZeroAddress })).to.equal(0n);
    expect(await reg.battleFor(X.key, Y.key)).to.equal(await S.battle.getAddress());
    expect(await reg.battleFor(L.key, m.key)).to.equal(await V.battle.getAddress());
    expect(await reg.battleFor(L.key, Y.key)).to.equal(ethers.ZeroAddress);                 // across the two hooks: none
    expect(await reg.battleFor(Y.key, L.key)).to.equal(ethers.ZeroAddress);
    expect(await reg.battleFor(X.key, X.key)).to.equal(ethers.ZeroAddress);
    expect(await reg.battleFor(X.key, never)).to.equal(ethers.ZeroAddress);
    const st = await reg.state(X.key), i = await P.inf(X);
    expect(st.system).to.equal(2n); expect(st.creator).to.equal(alice.address); expect(st.chest).to.equal(i.chest); expect(st.volume).to.equal(i.volume); expect(st.war).to.equal(true);
    expect((await reg.state(never)).system).to.equal(0n);
    // it is read-only and cannot be pointed at a hook that is not wired
    expect(reg.interface.fragments.filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).length).to.equal(0);
    const R = await ethers.getContractFactory("PadRegistry");
    const U = await deployOpen(owner, { doWire: false });
    await expect(R.deploy(await V.hook.getAddress(), await U.hook.getAddress())).to.be.revertedWithCustomError(reg, "BadHook");
    await expect(R.deploy(await V.hook.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(reg, "BadHook");
    await expect(R.deploy(await S.hook.getAddress(), await S.hook.getAddress())).to.be.revertedWithCustomError(reg, "BadHook");
    await expect(R.deploy(eve.address, await S.hook.getAddress())).to.be.revertedWithCustomError(reg, "BadHook");
    const solo = await R.deploy(ethers.ZeroAddress, await S.hook.getAddress());             // the open system on its own
    expect(await solo.systemOf(L.key)).to.equal(0n); expect(await solo.battleFor(X.key, Y.key)).to.equal(await S.battle.getAddress());
  });

  it("the owner's bar: a barred pool cannot offer or accept; a running fight still settles; nothing else changes", async () => {
    const a = X, b = Y;
    await expect(S.hook.connect(alice).setBarred(b.id, true)).to.be.revertedWithCustomError(S.hook, "NotOwner");
    await S.hook.connect(owner).setBarred(b.id, true);
    await expect(S.battle.connect(bob).challenge(b.key, a.key, HOUR)).to.be.reverted;       // cannot offer
    let n = Number(await S.battle.count());
    await S.battle.connect(alice).challenge(a.key, b.key, HOUR);
    await expect(S.battle.connect(bob).accept(n)).to.be.reverted;                           // cannot accept
    await S.battle.connect(alice).cancel(n);                                                // the honest challenger is not stuck
    expect((await P.inf(a)).locked).to.equal(false);
    await P.buy(b, carol, E(500_000)); await P.sell(b, carol, (await b.tok.balanceOf(carol.address)) / 2n);   // trading goes on
    await S.hook.connect(bob).burnChest(b.key, 0);                                          // so does burning
    await S.hook.connect(owner).setBarred(b.id, false);
    n = Number(await S.battle.count());
    await S.battle.connect(alice).challenge(a.key, b.key, HOUR);
    await S.battle.connect(bob).accept(n);
    await S.hook.connect(owner).setBarred(a.id, true); await S.hook.connect(owner).setBarred(b.id, true);     // barred in the middle of a fight
    await P.buy(a, carol, E(300_000)); await P.buy(b, carol, E(900_000));
    await time.increase(HOUR + 5);
    await S.battle.connect(eve).settle(n);                                                  // the result stands: the bar cannot stop or steer it
    expect((await P.inf(a)).locked).to.equal(false); expect((await P.inf(b)).locked).to.equal(false);
    expect(await S.hook.forced(b.id)).to.equal(E(300_000) * 3n / 100n + E(900_000) * 3n / 100n);
    await time.increase(HOUR + 1);
    await S.hook.connect(bob).burnForced(b.key, 0);                                         // a barred winner still burns
    await S.hook.connect(owner).setBarred(a.id, false); await S.hook.connect(owner).setBarred(b.id, false);
    for (let i = 0; i < 50 && (await S.hook.forced(b.id)) > 0n; i++) { await time.increase(HOUR + 1); await S.hook.connect(bob).burnForced(b.key, 0); }
    expect(await P.balanced()).to.equal(true);
  });

  it("ACCEPTED, as today: wash trading can win a fight, and it pays 3% of every $STAG it counts", async () => {
    const a = X, b = Y;
    const n = Number(await S.battle.count());
    await S.battle.connect(alice).challenge(a.key, b.key, HOUR);
    await S.battle.connect(bob).accept(n);
    await P.buy(a, carol, E(1_000_000));                                                    // honest demand for a
    const s0 = await S.stag.balanceOf(bob.address), v0 = (await P.inf(b)).volume, c0 = (await P.inf(b)).chest, p0 = await S.hook.platformOwed();
    for (let i = 0; i < 3; i++) { const t0 = await b.tok.balanceOf(bob.address); await P.buy(b, bob, E(400_000)); await P.sell(b, bob, (await b.tok.balanceOf(bob.address)) - t0); }   // bob buys and sells straight back
    const lost = s0 - (await S.stag.balanceOf(bob.address)), vol = (await P.inf(b)).volume - v0;
    const taxes = ((await P.inf(b)).chest - c0) + ((await S.hook.platformOwed()) - p0);
    expect(vol).to.be.gt(E(1_000_000));                                                     // enough counted volume to beat the honest side
    expect(taxes * 100n).to.be.gte(vol * 3n);                                               // at least 3% of every counted $STAG was taxed
    expect(lost).to.be.gte(taxes);                                                          // and bob paid all of it (plus LP fees)
    await time.increase(HOUR + 5);
    await S.battle.settle(n);
    expect(await S.hook.forced(b.id)).to.be.gt(0n);                                         // he wins; what he won can only be burned
    expect(await P.balanced()).to.equal(true);
  });
});
