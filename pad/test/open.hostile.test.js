// Open pad ("bring your token"): who is the creator, what the platform owner can and cannot do, curated mode, tokens that
// turn hostile after registration, reentrancy. NEW, UNAUDITED code under test.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { fundStag } = require("./helpers");
const { PM, STAG, DEAD, ANYONE, E, deployOpen, mkOpen, newToken, predictKey, poolId } = require("./open.helpers");
const HOUR = 3600;

describe("open pad: identity, owner limits and hostile tokens (mainnet fork)", function () {
  this.timeout(900000);
  let owner, alice, bob, carol, dave, eve, S, P;
  let tokA, A;   // a plain brought-in pool (alice is its creator) with some trading behind it
  let FAKE, REAL, DEN; // pools made by earlier tests and reused by later ones (fewer pools = fewer RPC round trips)

  before(async () => {
    [owner, alice, bob, carol, dave, eve] = await ethers.getSigners();
    await fundStag([owner, alice, bob, carol, dave, eve], E(400_000_000));
    S = await deployOpen(owner);
    P = mkOpen(S, [owner, alice, bob, carol, dave, eve]);
    tokA = await newToken(alice);
    A = await P.bring(alice, tokA);
    await P.buy(A, carol, E(2_000_000)); await P.sell(A, carol, (await tokA.balanceOf(carol.address)) / 3n);   // a chest and a platform share exist
  });

  describe("creator identity", () => {
    it("ADVERSARIAL creator spoofing: the creator is whoever called bring; nobody can name someone else or take the role later", async () => {
      const i = await S.hook.info(A.id);
      expect(i.creator).to.equal(alice.address);
      for (const who of [bob, eve, owner]) {
        await expect(S.hook.connect(who).setMode(A.key, false)).to.be.revertedWithCustomError(S.hook, "NotAllowed");
        await expect(S.hook.connect(who).burnChest(A.key, 0)).to.be.revertedWithCustomError(S.hook, "NotAllowed");
        await expect(S.hook.connect(who).claimCreator(A.key, who.address)).to.be.revertedWithCustomError(S.hook, "NotAllowed");
        await expect(S.pad.connect(who).collectFees(A.key, who.address)).to.be.revertedWithCustomError(S.pad, "NotCreator");
        await expect(S.hook.connect(who).register(A.key, who.address, await tokA.getAddress(), true, A.quoteIs0)).to.be.revertedWithCustomError(S.hook, "NotFactory");
      }
      expect(S.pad.interface.getFunction("bring").inputs.map((x) => x.name)).to.deep.equal(["token", "amount", "stagPerToken", "war"]);   // no "creator" argument exists
    });

    it("WHAT IS NOT PROTECTED on chain: a look-alike token registers just as well, and in open mode any holder of 1% can be first", async () => {
      const fake = await newToken(eve, { name: "Outside Token", symbol: "OUT" });           // same name and symbol as tokA, different contract
      const f = FAKE = await P.bring(eve, fake);
      expect(await fake.symbol()).to.equal(await tokA.symbol());
      expect((await S.hook.info(f.id)).creator).to.equal(eve.address);                      // only the contract address tells them apart: the website's verified list has to
      const real = await newToken(bob);                                                     // bob's project...
      await real.connect(bob).transfer(eve.address, E(10_000_001));                         // ...but eve holds 1% of it
      await real.connect(eve).approve(await S.pad.getAddress(), ethers.MaxUint256);
      REAL = await P.bring(eve, real, { amount: E(10_000_000), price: E("0.1") });
      expect((await S.hook.info(poolId(await predictKey(S, await real.getAddress())))).creator).to.equal(eve.address);   // eve, not the project, is "creator" for good
      await real.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await expect(S.pad.connect(bob).bring(await real.getAddress(), E(900_000_000), E("0.01"), true)).to.be.revertedWithCustomError(S.pad, "AlreadyBrought");
    });
  });

  describe("platform owner: limited powers", () => {
    it("only the hook owner can use the switches; ownership follows the hook's two-step hand-over", async () => {
      const t = await newToken(bob);
      for (const who of [alice, eve]) {
        await expect(S.pad.connect(who).setCurated(true)).to.be.revertedWithCustomError(S.pad, "NotOwner");
        await expect(S.pad.connect(who).allow(await t.getAddress(), who.address)).to.be.revertedWithCustomError(S.pad, "NotOwner");
        await expect(S.pad.connect(who).deny(await t.getAddress(), true)).to.be.revertedWithCustomError(S.pad, "NotOwner");
        await expect(S.hook.connect(who).setBarred(A.id, true)).to.be.revertedWithCustomError(S.hook, "NotOwner");
      }
      await S.hook.connect(owner).setOwner(dave.address);
      await expect(S.pad.connect(dave).deny(await t.getAddress(), true)).to.be.revertedWithCustomError(S.pad, "NotOwner");   // not until accepted
      await S.hook.connect(dave).acceptOwner();
      await expect(S.pad.connect(owner).deny(await t.getAddress(), true)).to.be.revertedWithCustomError(S.pad, "NotOwner");
      await S.pad.connect(dave).deny(await t.getAddress(), true);
      await S.hook.connect(dave).setOwner(owner.address); await S.hook.connect(owner).acceptOwner();
    });

    it("deny stops a registration and nothing else: a pool that already exists keeps trading, burning and paying", async () => {
      const t = await newToken(bob);
      await t.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await S.pad.connect(owner).deny(await t.getAddress(), true);
      await expect(S.pad.connect(bob).bring(await t.getAddress(), E(900_000_000), E("0.01"), true)).to.be.revertedWithCustomError(S.pad, "Denied");
      await S.pad.connect(owner).deny(await t.getAddress(), false);
      const p = DEN = await P.bring(bob, t);
      await S.pad.connect(owner).deny(await t.getAddress(), true);                          // denied AFTER it exists
      await S.pad.connect(owner).setCurated(true);                                          // and the pad closed to new tokens
      await S.hook.connect(owner).setBarred(p.id, true);                                    // and barred from battles
      const liq = await P.posLiq(p);
      await P.buy(p, carol, E(1_000_000)); await P.sell(p, carol, (await t.balanceOf(carol.address)) / 2n);
      await S.hook.connect(bob).burnChest(p.key, 0);
      await S.hook.connect(bob).setMode(p.key, false); await P.buy(p, carol, E(100_000));
      await S.hook.connect(bob).claimCreator(p.key, bob.address);
      await S.pad.connect(bob).collectFees(p.key, bob.address);
      expect(await P.posLiq(p)).to.equal(liq);
      expect(await P.balanced()).to.equal(true);
      await S.pad.connect(owner).setCurated(false);
    });

    it("the platform share is the only money the owner can take", async () => {
      const owed = await S.hook.platformOwed(), s0 = await S.stag.balanceOf(eve.address), c0 = await P.claims();
      expect(owed).to.be.gt(0n);
      await expect(S.hook.connect(alice).claimPlatform(alice.address)).to.be.revertedWithCustomError(S.hook, "NotOwner");
      await S.hook.connect(owner).claimPlatform(eve.address);
      expect((await S.stag.balanceOf(eve.address)) - s0).to.equal(owed);
      expect(c0 - (await P.claims())).to.equal(owed);                                       // chests and creator shares untouched
      expect(await S.hook.platformOwed()).to.equal(0n);
    });
  });

  describe("curated mode (owner lists tokens, optionally for one wallet)", () => {
    let C, PC;
    before(async () => { C = await deployOpen(owner, { curated: true }); PC = mkOpen(C, [owner, alice, bob, carol, dave, eve]); });

    it("an unlisted token cannot be brought; a listed one can, by the named wallet only", async () => {
      const t = await newToken(bob);
      await t.connect(bob).transfer(eve.address, E(100_000_000));
      for (const w of [bob, eve]) await t.connect(w).approve(await C.pad.getAddress(), ethers.MaxUint256);
      expect(await C.pad.curated()).to.equal(true);
      await expect(C.pad.connect(bob).bring(await t.getAddress(), E(800_000_000), E("0.01"), true)).to.be.revertedWithCustomError(C.pad, "NotListed");
      await C.pad.connect(owner).allow(await t.getAddress(), bob.address);
      await expect(C.pad.connect(eve).bring(await t.getAddress(), E(100_000_000), E("0.01"), true)).to.be.revertedWithCustomError(C.pad, "NotListed");   // eve holds 10% and still cannot squat it
      await C.pad.connect(owner).allow(await t.getAddress(), ethers.ZeroAddress);
      await expect(C.pad.connect(bob).bring(await t.getAddress(), E(800_000_000), E("0.01"), true)).to.be.revertedWithCustomError(C.pad, "NotListed");   // unlisted again
      await C.pad.connect(owner).allow(await t.getAddress(), bob.address);
      const p = await PC.bring(bob, t, { amount: E(800_000_000) });
      expect((await C.hook.info(p.id)).creator).to.equal(bob.address);
    });

    it("a token listed for ANYONE can be brought by any wallet; deny still wins over the list", async () => {
      const t = await newToken(bob);
      await t.connect(bob).transfer(eve.address, E(100_000_001));
      await t.connect(eve).approve(await C.pad.getAddress(), ethers.MaxUint256);
      await C.pad.connect(owner).allow(await t.getAddress(), ANYONE);
      await C.pad.connect(owner).deny(await t.getAddress(), true);
      await expect(C.pad.connect(eve).bring(await t.getAddress(), E(100_000_000), E("0.01"), true)).to.be.revertedWithCustomError(C.pad, "Denied");
      await C.pad.connect(owner).deny(await t.getAddress(), false);
      await C.pad.connect(eve).bring(await t.getAddress(), E(100_000_000), E("0.01"), true);
      expect(await C.pad.isBrought(await t.getAddress())).to.equal(true);
    });

    it("wiring is one-time and only accepts a pad and a battle contract that point back at this hook", async () => {
      const U = await deployOpen(owner, { doWire: false });
      const t = await newToken(bob);
      await t.connect(bob).approve(await U.pad.getAddress(), ethers.MaxUint256);
      await expect(U.pad.connect(bob).bring(await t.getAddress(), E(900_000_000), E("0.01"), true)).to.be.revertedWithCustomError(U.hook, "NotFactory");   // unwired: nothing registers
      await expect(U.hook.connect(owner).wire(await C.pad.getAddress(), await U.battle.getAddress())).to.be.revertedWithCustomError(U.hook, "BadPool");   // another hook's pad
      await expect(U.hook.connect(owner).wire(await U.pad.getAddress(), await C.battle.getAddress())).to.be.revertedWithCustomError(U.hook, "BadPool");   // another hook's battle
      await expect(U.hook.connect(eve).wire(await U.pad.getAddress(), await U.battle.getAddress())).to.be.revertedWithCustomError(U.hook, "NotOwner");
      await U.hook.connect(owner).wire(await U.pad.getAddress(), await U.battle.getAddress());
      await expect(U.hook.connect(owner).wire(await U.pad.getAddress(), await U.battle.getAddress())).to.be.revertedWithCustomError(U.hook, "NotAllowed");
      expect(await U.hook.factory()).to.equal(await U.pad.getAddress()); expect(await U.hook.battle()).to.equal(await U.battle.getAddress());
    });
  });

  describe("tokens that turn hostile AFTER registration (cannot be detected up front): the $STAG books still balance", () => {
    let t, p, other;
    before(async () => {
      p = DEN; t = p.tok; other = FAKE;                                                     // bob's token (he controls its switches) and an unrelated pool
      await S.hook.connect(bob).setMode(p.key, true);
      await P.buy(p, carol, E(3_000_000)); await P.buy(other, carol, E(1_000_000));
    });

    it("a fee switched on later breaks sells into the pool; buys, the chest and other pools carry on", async () => {
      await t.connect(bob).setFee(1000, PM);                                               // 10% on anything sent to the pool manager
      await expect(P.sell(p, carol, E(1_000_000))).to.be.reverted;                          // the pool manager sees it was short-paid
      await P.buy(p, carol, E(100_000));
      await P.buy(other, carol, E(100_000));
      expect(await P.balanced()).to.equal(true);
      await t.connect(bob).setFee(0, ethers.ZeroAddress);
    });

    it("a blacklist on the pool manager freezes that pool (buyers are stuck); it cannot touch the platform share or another pool", async () => {
      await t.connect(bob).setBlocked(PM, true);
      await expect(P.buy(p, carol, E(100_000))).to.be.reverted;
      await expect(P.sell(p, carol, E(1_000_000))).to.be.reverted;
      await time.increase(HOUR + 1);
      await expect(S.hook.connect(bob).burnChest(p.key, 0)).to.be.reverted;                 // the chest cannot burn either
      const c = (await P.inf(p)).chest; expect(c).to.be.gt(0n);                             // it just sits there; nobody can take it out
      await P.buy(other, carol, E(100_000)); await P.sell(other, carol, E(1_000_000));
      if ((await S.hook.platformOwed()) > 0n) await S.hook.connect(owner).claimPlatform(owner.address);
      expect(await P.balanced()).to.equal(true);
      await t.connect(bob).setBlocked(PM, false);
    });

    it("WHAT IS NOT PROTECTED: a token whose owner can mint sells fresh tokens into the pool and walks off with the buyers' $STAG", async () => {
      const s0 = await S.stag.balanceOf(bob.address), plat0 = await S.hook.platformOwed();
      await t.connect(bob).mint(bob.address, E(100_000_000_000));                           // 100x the supply, out of thin air
      await P.sell(p, bob, E(100_000_000_000));
      const took = (await S.stag.balanceOf(bob.address)) - s0;
      expect(took).to.be.gt(E(2_000_000));                                                  // most of what buyers had paid in
      expect((await S.hook.platformOwed()) - plat0).to.be.gt(0n);                           // it does pay the 3% sell tax
      expect(await P.balanced()).to.equal(true);                                // and the hook's own books are still exact
      expect(await P.posLiq(p)).to.be.gt(0n);                                               // "liquidity locked" did not help: the value was sold out of it
    });

    it("a rebase after registration breaks that pool's token side only", async () => {
      const q = REAL, u = q.tok;                                                            // bob controls this token; eve seeded its pool
      await P.buy(q, carol, E(500_000));
      await u.connect(bob).rebase(10n ** 12n);                                             // every balance, the pool manager's included, shrinks a million-fold
      await expect(P.buy(q, carol, E(500_000))).to.be.reverted;                             // the pool manager no longer holds what the pool thinks it has
      await P.buy(other, carol, E(100_000));
      expect(await P.balanced()).to.equal(true);
    });
  });

  describe("reentrancy from a hostile token that is its own pool's creator", () => {
    it("ADVERSARIAL calling back into the hook from inside a chest burn cannot burn twice or take anything", async () => {
      const t = await newToken(bob), ta = await t.getAddress(), hookA = await S.hook.getAddress(), padA = await S.pad.getAddress();
      await t.connect(bob).transfer(ta, E(950_000_000));                                    // the token contract holds its own supply...
      await t.connect(bob).exec(ta, t.interface.encodeFunctionData("approve", [padA, ethers.MaxUint256]));
      await t.connect(bob).exec(padA, S.pad.interface.encodeFunctionData("bring", [ta, E(900_000_000), E("0.01"), true]));   // ...and brings itself
      const key = await predictKey(S, ta), p = { key, tok: t, id: poolId(key), quoteIs0: key.currency0 === STAG };
      expect((await S.hook.info(p.id)).creator).to.equal(ta);
      await P.buy(p, carol, E(20_000_000));
      await t.connect(bob).exec(hookA, S.hook.interface.encodeFunctionData("setMode", [key, false]));
      await P.buy(p, carol, E(1_000_000));                                                  // peace: a creator share builds up for the token contract
      await t.connect(bob).exec(hookA, S.hook.interface.encodeFunctionData("setMode", [key, true]));
      const owed0 = (await P.inf(p)).creatorOwed; expect(owed0).to.be.gt(0n);
      const d0 = await t.balanceOf(DEAD);
      for (const inner of [
        S.hook.interface.encodeFunctionData("burnChest", [key, 0]),
        S.hook.interface.encodeFunctionData("claimCreator", [key, ta]),
        S.hook.interface.encodeFunctionData("claimPlatform", [ta]),
        S.pad.interface.encodeFunctionData("collectFees", [key, ta]),
      ]) {
        await time.increase(HOUR + 1);
        await P.buy(p, carol, E(2_000_000));                                                // keep the chest filled
        await t.connect(bob).setCallback(inner.startsWith(S.pad.interface.getFunction("collectFees").selector) ? padA : hookA, inner);
        const chest0 = (await P.inf(p)).chest, claims0 = await P.claims(), dead0 = await t.balanceOf(DEAD);
        const rc = await (await t.connect(bob).exec(hookA, S.hook.interface.encodeFunctionData("burnChest", [key, 0]))).wait();
        expect(await t.cbTried()).to.equal(true); expect(await t.cbOk()).to.equal(false);   // the inner call failed
        const ev = rc.logs.map((l) => { try { return S.hook.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === "ChestBurned");
        expect(ev.length).to.equal(1);                                                      // one burn, not two
        expect(chest0 - (await P.inf(p)).chest).to.equal(ev[0].args.quoteSpent);
        expect(claims0 - (await P.claims())).to.equal(ev[0].args.quoteSpent);               // claims fell by exactly what the chest spent
        expect((await t.balanceOf(DEAD)) - dead0).to.equal(ev[0].args.tokensBurned);
      }
      await t.connect(bob).setCallback(ethers.ZeroAddress, "0x");
      expect((await t.balanceOf(DEAD)) - d0).to.be.gt(0n);
      expect(await S.stag.balanceOf(ta)).to.equal(0n);
      expect((await P.inf(p)).creatorOwed).to.equal(owed0);                                 // the creator share was not taken from inside the burn
    });

    it("ADVERSARIAL a taxed swap fired from inside the burn (the token's transfer runs while the pool manager is unlocked) leaves the books exact", async () => {
      const t = await newToken(bob), p = await P.bring(bob, t);
      const sw = await (await ethers.getContractFactory("SwapInside")).deploy(PM);
      await S.stag.connect(carol).transfer(await sw.getAddress(), E(1_000_000));
      await P.buy(p, carol, E(10_000_000));
      const inner = E(400_000), MINP = 4295128740n, MAXP = 1461446703485210103287273052203988822378723970341n;
      await sw.arm(p.key, { zeroForOne: p.quoteIs0, amountSpecified: -inner, sqrtPriceLimitX96: p.quoteIs0 ? MINP + 1n : MAXP - 1n });   // a buy, exact-in
      await t.connect(bob).setCallback(await sw.getAddress(), sw.interface.encodeFunctionData("hit"));
      const i0 = await P.inf(p), claims0 = await P.claims(), dead0 = await t.balanceOf(DEAD);
      const rc = await (await S.hook.connect(bob).burnChest(p.key, 0)).wait();
      expect(await t.cbOk()).to.equal(true); expect(await sw.hits()).to.equal(1n);          // the inner swap really happened, mid-burn
      await t.connect(bob).setCallback(ethers.ZeroAddress, "0x");
      expect(await t.balanceOf(await sw.getAddress())).to.be.gt(0n);
      const ev = rc.logs.map((l) => { try { return S.hook.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === "ChestBurned");
      expect(ev.length).to.equal(1);
      const spent = ev[0].args.quoteSpent, fee = inner * 3n / 100n, i1 = await P.inf(p);
      expect(i1.chest).to.equal(i0.chest - spent + fee);                                    // the burn's spend and the inner swap's tax, each counted once
      expect(i1.volume - i0.volume).to.equal(inner - fee);                                  // the burn itself is not volume; the inner swap is
      expect((await P.claims()) - claims0).to.equal(fee - spent);
      expect((await t.balanceOf(DEAD)) - dead0).to.equal(ev[0].args.tokensBurned);
      expect(await P.balanced()).to.equal(true);
    });

    it("after everything above, the hook holds exactly the claims it owes, across every pool ever brought", async () => {
      const n = Number(await S.pad.count()); let owed = await S.hook.platformOwed();
      for (let i = 0; i < n; i++) {
        const k = await S.pad.keyAt(i);
        const inf = await S.hook.info(poolId({ currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] }));
        owed += inf.chest + inf.creatorOwed + inf.holderOwed;
        expect(inf.holderOwed).to.equal(0n);
      }
      expect(await P.claims()).to.equal(owed);
      expect(await S.stag.balanceOf(await S.hook.getAddress())).to.equal(0n);               // the hook never holds real $STAG
      expect(await S.stag.balanceOf(await S.pad.getAddress())).to.equal(0n);
    });
  });
});
