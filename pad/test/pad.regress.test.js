const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E, PM, STAG, MIN, MAXP, fundStag, deployStack, mk } = require("./helpers");

describe("pad v3 regressions from the audit rounds", function () {
  this.timeout(900000);
  let owner, alice, bob, carol, dave, atk, S, P;

  before(async () => {
    [owner, alice, bob, carol, dave, atk] = await ethers.getSigners();
    await fundStag([owner, alice, bob, carol, dave, atk], E(900_000_000));
    S = await deployStack(owner);
    P = mk(S, [owner, alice, bob, carol, dave, atk]);
  });

  const all = [];
  const launchOrd = async (who, war, q0) => { for (let n = 0; n < 40; n++) { const p = await P.launch(who, war); all.push(p); if (p.quoteIs0 === q0) return p; } throw new Error("ordering not found"); };

  for (const q0 of [true, false]) describe(q0 ? "quote is currency0" : "quote is currency1", () => {
    it("third parties cannot add liquidity (a private LP could absorb a chest burn); the factory's fee poke still works", async () => {
      const p = await launchOrd(alice, true, q0);
      const lp = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(PM);
      await p.tok.connect(bob); // bob holds nothing yet
      await P.buy(p, bob, E(1_000_000));
      await p.tok.connect(bob).approve(await lp.getAddress(), ethers.MaxUint256);
      await S.stag.connect(bob).approve(await lp.getAddress(), ethers.MaxUint256);
      const t = await P.tick(p);
      const base = Math.floor(t / 60) * 60;
      await expect(lp.connect(bob).modifyLiquidity(p.key, { tickLower: base - 60, tickUpper: base + 60, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash }, "0x")).to.be.reverted;
      await P.factory.connect(alice).collectFees(p.key, alice.address);
    });

    it("flash-taking the pool's tokens earns no dividend (credit comes a block later, to real holders)", async () => {
      const p = await launchOrd(alice, false, q0);
      await P.buy(p, bob, E(100_000)); await P.buy(p, carol, E(100_000));
      await P.buy(p, dave, E(1_000_000));                                  // 2% = 20k STAG waiting for holders
      const waiting = (await P.inf(p)).holderOwed;
      const M = await (await ethers.getContractFactory("TestMulti")).deploy(PM);
      const m = await M.getAddress();
      await S.stag.connect(atk).transfer(m, E(1_000)); await S.stag.connect(atk).approve(m, ethers.MaxUint256);
      const tokAddr = await p.tok.getAddress();
      const pmTok = await p.tok.balanceOf(PM);
      const tiny = { kind: 0, key: p.key, sp: { zeroForOne: p.quoteIs0, amountSpecified: -1000n, sqrtPriceLimitX96: p.quoteIs0 ? MIN + 1n : MAXP - 1n }, cur: ethers.ZeroAddress, amt: 0n };
      const ops = [{ kind: 1, key: p.key, sp: tiny.sp, cur: tokAddr, amt: (pmTok * 99n) / 100n }, tiny, { kind: 5, key: p.key, sp: tiny.sp, cur: tokAddr, amt: 0n }];
      const s0 = await S.stag.balanceOf(m);
      await M.connect(atk).run(ops, [tokAddr, STAG]);
      const gain = (await S.stag.balanceOf(m)) - s0;
      console.log(`   [${q0 ? "q0" : "q1"}] attacker STAG change: ${ethers.formatEther(gain)} (waiting was ${ethers.formatEther(waiting)})`);
      expect(gain).to.be.lte(0n);                                          // it can only lose its own tax
      await ethers.provider.send("hardhat_mine", ["0x2"]);
      const honest = (await p.tok.claimable(bob.address)) + (await p.tok.claimable(carol.address)) + (await p.tok.claimable(dave.address));
      expect(honest).to.be.gt((waiting * 95n) / 100n);                      // the real holders get it
      expect(await p.tok.claimable(m)).to.be.lt(waiting / 1_000_000n);        // it keeps only the sliver bought by its own 1000-wei swap
    });

    it("two swaps on the same peace pool in one unlock work even when the pool manager holds little STAG", async () => {
      const p = await launchOrd(alice, false, q0);
      const M = await (await ethers.getContractFactory("TestMulti")).deploy(PM);
      const m = await M.getAddress();
      await S.stag.connect(bob).approve(m, ethers.MaxUint256);
      const sw = (amt) => ({ kind: 0, key: p.key, sp: { zeroForOne: p.quoteIs0, amountSpecified: -amt, sqrtPriceLimitX96: p.quoteIs0 ? MIN + 1n : MAXP - 1n }, cur: ethers.ZeroAddress, amt: 0n });
      await M.connect(bob).run([sw(E(20_000_000)), sw(E(1_000)), sw(E(5_000))], [STAG, await p.tok.getAddress()]);
      expect((await P.inf(p)).holderOwed).to.be.gt(0n);
      await P.buy(p, carol, E(1_000));                                      // next tx flushes normally
      expect(await P.solvent(all)).to.equal(true);
    });

    it("a burn against an exhausted pool does not revert; the chest just stays", async () => {
      const p = await launchOrd(alice, true, q0);
      await P.buy(p, bob, E(1_000_000));
      // exact-out buy of almost the whole supply with a loose limit: the pool runs dry, price runs to the edge
      await P.buyOut(p, carol, E(999_999_000)).catch(() => {});
      const c0 = (await P.inf(p)).chest;
      await P.hook.connect(alice).burnChest(p.key, 0);
      expect((await P.inf(p)).chest).to.be.lte(c0);
      expect(await P.solvent(all)).to.equal(true);
    });
  });

  it("wiring refuses a factory or battle that belongs to another hook", async () => {
    const S2 = await deployStack(owner, false);
    const other = await (await ethers.getContractFactory("PadFactory")).deploy(PM, await S.hook.getAddress(), STAG);   // points at the OTHER hook
    await expect(S2.hook.wire(await other.getAddress(), await S2.battle.getAddress())).to.be.reverted;
    await expect(S2.hook.wire(await S2.factory.getAddress(), await S2.battle.getAddress())).to.not.be.reverted;
  });

  it("burn caps still hold with a different caller choosing minOut", async () => {
    const p = await launchOrd(alice, true, true);
    await P.buy(p, carol, E(30_000_000));
    const t0 = await P.tick(p);
    await P.hook.connect(alice).burnChest(p.key, 0);
    expect(Math.abs((await P.tick(p)) - t0)).to.be.lte(151);
  });
});
