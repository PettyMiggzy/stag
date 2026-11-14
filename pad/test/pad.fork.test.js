const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, STAG, fundStag, deployStack, mk } = require("./helpers");

describe("pad v2 on a mainnet fork ($STAG pair)", function () {
  this.timeout(900000);
  let owner, alice, bob, carol, dave, P, pools = {};

  before(async () => {
    [owner, alice, bob, carol, dave] = await ethers.getSigners();
    await fundStag([owner, alice, bob, carol, dave], E(200_000_000));
    P = mk(await deployStack(owner), [owner, alice, bob, carol, dave]);
    // launch war pools until we hold one of each ordering (quote is currency0 / quote is currency1)
    for (let n = 0; n < 24 && !(pools.q0 && pools.q1); n++) {
      const p = await P.launch(alice, true);
      if (p.quoteIs0 && !pools.q0) pools.q0 = p; else if (!p.quoteIs0 && !pools.q1) pools.q1 = p;
    }
    expect(pools.q0 && pools.q1, "need both orderings").to.be.ok;
  });

  for (const name of ["q0", "q1"]) {
    describe(`ordering ${name}`, () => {
      let p;
      before(() => { p = pools[name]; });

      it("whole supply is in the pool, nothing but dust left in the factory", async () => {
        const f = await P.factory.getAddress();
        expect(await p.tok.totalSupply()).to.equal(E(1_000_000_000));
        expect(await p.tok.balanceOf(f)).to.be.lt(E(20));
        expect(await p.tok.balanceOf("0x8366a39cc670b4001a1121b8f6a443a643e40951")).to.be.gte(E(999_999_980));
      });

      it("buy exact-in: 3% of the quote goes to the war chest", async () => {
        await P.buy(p, bob, E(1_000_000));
        expect((await P.inf(p)).chest).to.equal(E(30_000));
        expect(await p.tok.balanceOf(bob.address)).to.be.gt(0n);
        expect(await P.solvent(Object.values(pools))).to.equal(true);
      });

      it("buy exact-out: the tax sits on top of what the tokens cost", async () => {
        const c0 = (await P.inf(p)).chest, b0 = await p.tok.balanceOf(bob.address);
        await P.buyOut(p, bob, E(1_000_000));
        expect((await p.tok.balanceOf(bob.address)) - b0).to.equal(E(1_000_000));
        expect((await P.inf(p)).chest).to.be.gt(c0);
        expect(await P.solvent(Object.values(pools))).to.equal(true);
      });

      it("sell exact-in: 3% of the quote paid out goes to the platform", async () => {
        const o0 = await P.hook.platformOwed();
        await P.sell(p, bob, (await p.tok.balanceOf(bob.address)) / 2n);
        expect((await P.hook.platformOwed()) - o0).to.be.gt(0n);
        expect(await P.solvent(Object.values(pools))).to.equal(true);
      });

      it("sell exact-out: exactly 3% of the quote leg", async () => {
        const o0 = await P.hook.platformOwed();
        await P.sellOut(p, bob, E(10_000));
        expect((await P.hook.platformOwed()) - o0).to.equal(E(300));
        expect(await P.solvent(Object.values(pools))).to.equal(true);
      });

      it("REGRESSION partial fills are rejected, so tax and volume are always on what traded", async () => {
        const v0 = (await P.inf(p)).volume, c0 = (await P.inf(p)).chest;
        const sqrtP = (await P.stateView.getSlot0(p.id))[0];
        const near = p.quoteIs0 ? sqrtP - sqrtP / 1000000n : sqrtP + sqrtP / 1000000n; // limit a hair from spot: only a sliver can fill
        const run = (spec) => P.router.connect(bob).swap(p.key, spec, { takeClaims: false, settleUsingBurn: false }, "0x");
        // buy exact-in (quote specified): would have booked the full 1M as volume and 30k tax for a sliver of a fill
        await expect(run({ zeroForOne: p.quoteIs0, amountSpecified: -E(1_000_000), sqrtPriceLimitX96: near })).to.be.reverted;
        // sell exact-out (quote specified): same
        const nearSell = p.quoteIs0 ? sqrtP + sqrtP / 1000000n : sqrtP - sqrtP / 1000000n;
        await p.tok.connect(bob).approve(await P.router.getAddress(), ethers.MaxUint256);
        await expect(run({ zeroForOne: !p.quoteIs0, amountSpecified: E(500_000), sqrtPriceLimitX96: nearSell })).to.be.reverted;
        const i = await P.inf(p);
        expect(i.volume).to.equal(v0); expect(i.chest).to.equal(c0);
      });

      it("the creator burns the chest into the token; a stranger cannot; price moves at most ~1.5%", async () => {
        await P.buy(p, carol, E(30_000_000));                          // big chest (3% of 30M)
        const s0 = await p.tok.totalSupply(), c0 = (await P.inf(p)).chest, t0 = await P.tick(p);
        await expect(P.hook.connect(bob).burnChest(p.key, 0)).to.be.reverted;
        await P.hook.connect(alice).burnChest(p.key, 0);
        const t1 = await P.tick(p);
        expect(Math.abs(t1 - t0)).to.be.lte(151);
        expect(await p.tok.totalSupply()).to.be.lt(s0);
        const c1 = (await P.inf(p)).chest;
        console.log(`   [${name}] chest ${ethers.formatEther(c0)} -> ${ethers.formatEther(c1)} STAG left, ticks moved ${Math.abs(t1 - t0)}`);
        expect(await P.solvent(Object.values(pools))).to.equal(true);
      });

      it("only the platform owner can take only the platform share", async () => {
        const c0 = await P.claims(), o0 = await P.hook.platformOwed(), s0 = await P.stag.balanceOf(owner.address);
        await expect(P.hook.connect(bob).claimPlatform(bob.address)).to.be.reverted;
        await P.hook.claimPlatform(owner.address);
        expect(await P.claims()).to.equal(c0 - o0);
        expect((await P.stag.balanceOf(owner.address)) - s0).to.equal(o0);
        expect(await P.solvent(Object.values(pools))).to.equal(true);
      });

      it("the creator collects LP fees; nobody else can", async () => {
        await expect(P.factory.connect(bob).collectFees(p.key, bob.address)).to.be.reverted;
        await P.factory.connect(alice).collectFees(p.key, alice.address);
      });
    });
  }

  describe("peace mode and the token", () => {
    let pp, q;
    before(async () => { pp = await P.launch(alice, false); });

    it("1% to the creator, 2% reaches holders at the next swap, and they can claim it", async () => {
      await P.buy(pp, bob, E(1_000_000));
      const i = await P.inf(pp);
      expect(i.chest).to.equal(0n);
      expect(i.creatorOwed).to.equal(E(10_000));
      expect(i.holderOwed).to.equal(E(20_000));                       // waiting: nobody has been paid yet
      await P.buy(pp, carol, E(1_000_000));                          // this swap first flushes bob's 20k to the token (bob is the only holder)
      expect((await P.inf(pp)).holderOwed).to.equal(E(20_000));       // now carol's buy is waiting
      expect(await pp.tok.claimable(bob.address)).to.be.closeTo(E(20_000), E(1));
      const before = await P.stag.balanceOf(bob.address);
      await pp.tok.connect(bob).claim();
      expect((await P.stag.balanceOf(bob.address)) - before).to.be.closeTo(E(20_000), E(1));
      await P.hook.pushHolders(pp.key);                              // anyone can push the waiting share
      expect((await P.inf(pp)).holderOwed).to.equal(0n);
      await P.hook.connect(alice).claimCreator(pp.key, alice.address);
      expect(await P.solvent(Object.values(pools).concat([pp]))).to.equal(true);
    });

    it("REGRESSION the token cannot be bricked by shrinking eligible supply", async () => {
      const tp = await P.launch(alice, false);
      await P.buy(tp, dave, E(1_000_000));
      const bal = await tp.tok.balanceOf(dave.address);
      await tp.tok.connect(dave).burn(bal - 1n);                      // eligible supply is now 1 wei
      expect(await tp.tok.eligibleSupply()).to.equal(1n);
      await P.buy(tp, bob, E(500_000));                               // tax lands while eligible is ~0: must park, not blow up
      expect(await tp.tok.pendingDividends()).to.be.gt(0n);
      const got = await tp.tok.balanceOf(bob.address);
      expect(got).to.be.gt(E(1000));
      await tp.tok.connect(bob).transfer(carol.address, got / 2n);   // big transfers still work
      await P.sell(tp, carol, got / 4n);
      await P.buy(tp, carol, E(500_000));
      expect(await tp.tok.magnifiedPerShare()).to.be.lt(2n ** 100n);
    });

    it("holders earn in proportion to what they held", async () => {
      const t2 = await P.launch(alice, false);
      await P.buy(t2, bob, E(1_000_000)); await P.buy(t2, carol, E(3_000_000)); await P.buy(t2, dave, E(1_000_000));
      const [b, c] = [await t2.tok.balanceOf(bob.address), await t2.tok.balanceOf(carol.address)];
      const [cb, cc] = [await t2.tok.claimable(bob.address), await t2.tok.claimable(carol.address)];
      await P.buy(t2, dave, E(2_000_000));
      const db = (await t2.tok.claimable(bob.address)) - cb, dc = (await t2.tok.claimable(carol.address)) - cc;
      const r = Number((dc * 1000n) / db) / 1000, w = Number((c * 1000n) / b) / 1000;
      console.log("   payout ratio carol:bob", r, "balance ratio", w);
      expect(Math.abs(r - w) / w).to.be.lt(0.01);
    });

    it("mode switch: creator only, affects later buys only", async () => {
      await expect(P.hook.connect(bob).setMode(pp.key, true)).to.be.reverted;
      await P.hook.connect(alice).setMode(pp.key, true);
      const c0 = (await P.inf(pp)).chest;
      await P.buy(pp, bob, E(1_000_000));
      expect((await P.inf(pp)).chest - c0).to.equal(E(30_000));
    });
  });

  describe("admin, registry and strings", () => {
    it("wiring is one-time, owner cannot be zeroed, register cannot be re-run", async () => {
      await expect(P.hook.wire(owner.address, owner.address)).to.be.reverted;
      await expect(P.hook.setOwner(ethers.ZeroAddress)).to.be.reverted;
      await expect(P.hook.connect(bob).setOwner(bob.address)).to.be.reverted;
      await expect(P.hook.register(pools.q0.key, bob.address, pools.q0.key.currency1, true, true)).to.be.reverted; // not the factory
    });
    it("hostile names and out-of-range prices are refused", async () => {
      for (const bad of ["", "x".repeat(33), "<script>", "a&b", 'q"q', "tab\t", "nöpe"]) await expect(P.factory.connect(alice).launch(bad, "PT", E(10_000_000), true)).to.be.reverted;
      await expect(P.factory.connect(alice).launch("ok", "x".repeat(13), E(10_000_000), true)).to.be.reverted;
      await expect(P.factory.connect(alice).launch("ok", "OK", 1n, true)).to.be.reverted;
      await expect(P.factory.connect(alice).launch("ok", "OK", ethers.parseEther("1" + "0".repeat(13)), true)).to.be.reverted;
    });
    it("a pool the factory did not register can never use the hook", async () => {
      const pmc = await ethers.getContractAt("IPoolManager", "0x8366a39cc670b4001a1121b8f6a443a643e40951");
      const bad = { ...pools.q0.key, tickSpacing: 10 };
      await expect(pmc.initialize(bad, 79228162514264337593543950336n)).to.be.reverted;
    });
  });
});
