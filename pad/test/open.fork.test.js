// Open pad ("bring your token"): registration checks, the liquidity lock, tax and chest behaviour. NEW, UNAUDITED code under test.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { fundStag, deployStack, mk } = require("./helpers");
const { PM, STAG, DEAD, E, deployOpen, mkOpen, newToken, predictKey, poolId } = require("./open.helpers");
const HOUR = 3600;
const LP_SIG = "modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)";
const writes = (c) => c.interface.fragments.filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map((f) => f.name).sort();

describe("open pad: bring an existing token (mainnet fork)", function () {
  this.timeout(900000);
  let owner, alice, bob, carol, dave, eve, S, P, V, PV, pmc;
  let tokA, A;   // the main brought-in pool (alice is its creator)
  let FR;        // bob's pool from the front-running test, reused later (fewer pools = fewer RPC round trips)

  before(async () => {
    [owner, alice, bob, carol, dave, eve] = await ethers.getSigners();
    await fundStag([owner, alice, bob, carol, dave, eve], E(400_000_000));
    S = await deployOpen(owner);
    P = mkOpen(S, [owner, alice, bob, carol, dave, eve]);
    V = await deployStack(owner);                       // the existing, audited stack, side by side
    PV = mk(V, [owner, alice, bob, carol, dave, eve]);
    pmc = new ethers.Contract(PM, ["function initialize((address,address,uint24,int24,address),uint160) returns (int24)", "function balanceOf(address,uint256) view returns (uint256)"], owner);
    tokA = await newToken(alice);
  });

  describe("registration", () => {
    it("brings a plain token: pool opened, seed locked in, the seeder is the creator, nothing left in the pad", async () => {
      const amount = E(900_000_000), price = E("0.01");
      const supply = await tokA.totalSupply(), pm0 = await tokA.balanceOf(PM), a0 = await tokA.balanceOf(alice.address);
      await tokA.connect(alice).approve(await S.pad.getAddress(), amount + 2_000_000n);
      await expect(S.pad.connect(alice).bring(await tokA.getAddress(), amount, price, true)).to.emit(S.pad, "Brought");
      A = { tok: tokA }; A.key = await predictKey(S, await tokA.getAddress()); A.id = poolId(A.key); A.quoteIs0 = A.key.currency0 === STAG;
      const k = await S.pad.keyOf(await tokA.getAddress());
      expect(poolId({ currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] })).to.equal(A.id);   // the key is fully determined by the token
      for (const s of [owner, alice, bob, carol, dave, eve]) await S.stag.connect(s).approve(await S.router.getAddress(), ethers.MaxUint256);

      const i = await S.hook.info(A.id);
      expect(i.creator).to.equal(alice.address); expect(i.token).to.equal(await tokA.getAddress());
      expect(i.registered).to.equal(true); expect(i.war).to.equal(true); expect(i.locked).to.equal(false);
      expect((await S.pad.pools(A.id)).creator).to.equal(alice.address);
      expect(await S.pad.isBrought(await tokA.getAddress())).to.equal(true);
      expect(await S.pad.count()).to.equal(1n);

      const used = (await tokA.balanceOf(PM)) - pm0;
      expect(used).to.be.lte(amount); expect(amount - used).to.be.lt(1000n);                 // all but rounding dust went into the pool
      expect(await tokA.balanceOf(await S.pad.getAddress())).to.equal(0n);                  // the pad keeps nothing
      expect(await tokA.balanceOf(DEAD)).to.equal(1_000_000n);                              // the burn-path probe (1e-12 of a token)
      expect(await tokA.balanceOf(alice.address)).to.equal(a0 - used - 1_000_000n);         // seed + the dead-address probe; the other probe and the dust came back
      expect(await tokA.totalSupply()).to.equal(supply);
      expect(await P.posLiq(A)).to.be.gt(0n);                                               // the position is the pad's

      const tick = await P.tick(A);
      const px = A.quoteIs0 ? Math.pow(1.0001, -tick) : Math.pow(1.0001, tick);              // $STAG per token
      expect(px).to.be.gte(0.01 * (1 - 1e-9)); expect(px).to.be.lte(0.01 * 1.0061);          // never below the request, at most one 60-tick step above
    });

    it("the same token can never be registered twice, by anyone, at any price", async () => {
      await tokA.connect(alice).transfer(bob.address, E(50_000_000));
      await tokA.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await expect(S.pad.connect(bob).bring(await tokA.getAddress(), E(20_000_000), E("5"), true)).to.be.revertedWithCustomError(S.pad, "AlreadyBrought");
      await tokA.connect(alice).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await expect(S.pad.connect(alice).bring(await tokA.getAddress(), E(20_000_000), E("1"), false)).to.be.revertedWithCustomError(S.pad, "AlreadyBrought");
      expect(await S.pad.count()).to.equal(1n);
    });

    it("rejects what is not a plain 18-decimal token contract", async () => {
      const amt = E(900_000_000), px = E("0.01");
      await expect(S.pad.connect(alice).bring(dave.address, amt, px, true)).to.be.revertedWithCustomError(S.pad, "BadToken");           // a wallet, not a contract
      await expect(S.pad.connect(alice).bring(ethers.ZeroAddress, amt, px, true)).to.be.revertedWithCustomError(S.pad, "BadToken");
      await expect(S.pad.connect(alice).bring(STAG, amt, px, true)).to.be.revertedWithCustomError(S.pad, "BadToken");                   // $STAG against itself
      await expect(S.pad.connect(alice).bring(PM, amt, px, true)).to.be.revertedWithCustomError(S.pad, "BadToken");
      await expect(S.pad.connect(alice).bring(await S.hook.getAddress(), amt, px, true)).to.be.revertedWithCustomError(S.pad, "BadToken");
      await expect(S.pad.connect(alice).bring(await S.pad.getAddress(), amt, px, true)).to.be.revertedWithCustomError(S.pad, "BadToken");
      const six = await newToken(alice, { decimals: 6 });
      await six.connect(alice).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await expect(S.pad.connect(alice).bring(await six.getAddress(), amt, px, true)).to.be.revertedWithCustomError(S.pad, "BadDecimals");
      const nod = await (await ethers.getContractFactory("NoDecimalsToken", alice)).deploy(E(1_000_000_000));
      await nod.connect(alice).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await expect(S.pad.connect(alice).bring(await nod.getAddress(), amt, px, true)).to.be.revertedWithCustomError(S.pad, "BadDecimals");
    });

    it("rejects a seed that is too small or a price out of bounds", async () => {
      const t = await newToken(bob);
      await t.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
      const pad = S.pad.connect(bob), ta = await t.getAddress();
      await expect(pad.bring(ta, E(9_999_999), E("1"), true)).to.be.revertedWithCustomError(S.pad, "SeedTooSmall");      // under 1% of supply, whatever the price says
      await expect(pad.bring(ta, 1000n, E("1000000000000"), true)).to.be.revertedWithCustomError(S.pad, "SeedTooSmall"); // dust at an absurd price
      await expect(pad.bring(ta, E(50_000_000), E("0.019"), true)).to.be.revertedWithCustomError(S.pad, "SeedTooSmall"); // 1% of supply but worth under 1,000,000 $STAG
      await expect(pad.bring(ta, E(2_000_000_000), E("1"), true)).to.be.revertedWithCustomError(S.pad, "SeedTooSmall");  // more than exists
      await expect(pad.bring(ta, E(900_000_000), 999_999n, true)).to.be.revertedWithCustomError(S.pad, "BadPrice");
      await expect(pad.bring(ta, E(900_000_000), 10n ** 30n + 1n, true)).to.be.revertedWithCustomError(S.pad, "BadPrice");
      expect(await S.pad.isBrought(ta)).to.equal(false);
      // both ends of the allowed price range really work (one fresh token each)
      for (const px of [10n ** 30n, 2n * 10n ** 9n]) {                                      // top of the range; and the lowest price a maximum-supply token can meet the minimum value at
        const u = await newToken(bob, { supply: px < 10n ** 18n ? 10n ** 33n : E(1_000_000_000) });
        await u.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
        await pad.bring(await u.getAddress(), (await u.totalSupply()) / 2n, px, true);
        expect(await S.pad.isBrought(await u.getAddress())).to.equal(true);
      }
    });

    it("ADVERSARIAL fee-on-transfer tokens are rejected, whichever transfer carries the fee", async () => {
      for (const onlyTo of [ethers.ZeroAddress, await S.pad.getAddress(), PM, DEAD, bob.address]) {
        const t = await newToken(bob);
        await t.connect(bob).setFee(100, onlyTo);                                          // 1%, on every transfer or only towards one address
        await t.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
        await expect(S.pad.connect(bob).bring(await t.getAddress(), E(900_000_000), E("0.01"), true), onlyTo).to.be.revertedWithCustomError(S.pad, "TokenMisbehaved");
        expect(await S.pad.isBrought(await t.getAddress())).to.equal(false);
        expect((await S.hook.info(poolId(await predictKey(S, await t.getAddress())))).registered).to.equal(false);   // nothing half-done
      }
    });

    it("ADVERSARIAL a token that rebases (up or down) while it is being registered is rejected", async () => {
      const t = await newToken(bob);
      await t.connect(bob).setRebasePerTransfer(1);                                        // +0.01% on every transfer
      await t.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await expect(S.pad.connect(bob).bring(await t.getAddress(), E(900_000_000), E("0.01"), true)).to.be.revertedWithCustomError(S.pad, "TokenMisbehaved");
      expect(await S.pad.isBrought(await t.getAddress())).to.equal(false);
    });

    it("ADVERSARIAL a token that refuses transfers to the pool manager, or to the dead address, cannot be registered", async () => {
      const t = await newToken(bob);
      await t.connect(bob).setBlocked(PM, true);
      await t.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await expect(S.pad.connect(bob).bring(await t.getAddress(), E(900_000_000), E("0.01"), true)).to.be.revertedWith("blocked");
      expect((await S.hook.info(poolId(await predictKey(S, await t.getAddress())))).registered).to.equal(false);
      await t.connect(bob).setBlocked(PM, false); await t.connect(bob).setBlocked(DEAD, true);    // chest burns could never land
      await expect(S.pad.connect(bob).bring(await t.getAddress(), E(900_000_000), E("0.01"), true)).to.be.revertedWith("blocked");
      expect(await t.balanceOf(bob.address)).to.equal(E(1_000_000_000));                   // the failed attempts cost the seeder nothing
    });

    it("ADVERSARIAL front-running: nobody can open the pool first at a skewed price, and nobody can register around the pad", async () => {
      const t = await newToken(bob);
      const key = await predictKey(S, await t.getAddress()), arr = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
      const skew = 79228162514264337593543950336n * 1000n;                                 // sqrt price far from anything sane
      await expect(pmc.connect(eve).initialize(arr(key), skew)).to.be.reverted;                  // the hook refuses pools the pad has not registered
      await expect(S.hook.connect(eve).register(key, eve.address, await t.getAddress(), true, key.currency0 === STAG)).to.be.revertedWithCustomError(S.hook, "NotFactory");
      // a pool with the same pair but other fee settings is a different pool the hook also refuses
      await expect(pmc.connect(eve).initialize(arr({ ...key, fee: 500, tickSpacing: 10 }), skew)).to.be.reverted;
      const p = FR = await P.bring(bob, t, { price: E("0.02") });
      const tick = await P.tick(p), px = p.quoteIs0 ? Math.pow(1.0001, -tick) : Math.pow(1.0001, tick);
      expect(px).to.be.gte(0.02 * (1 - 1e-9)); expect(px).to.be.lte(0.02 * 1.0061);          // the seeder's price, not the attacker's
      await expect(pmc.connect(eve).initialize(arr(key), skew)).to.be.reverted;                  // and it cannot be re-initialised
      expect((await S.hook.info(p.id)).creator).to.equal(bob.address);
    });

    it("ADVERSARIAL a token that calls back into the pad from inside its transfers cannot re-enter", async () => {
      const t = await newToken(bob);
      const ta = await t.getAddress();
      await t.connect(bob).approve(await S.pad.getAddress(), ethers.MaxUint256);
      await t.connect(bob).setCallback(await S.pad.getAddress(), S.pad.interface.encodeFunctionData("bring", [ta, E(900_000_000), E("0.01"), false]));
      await S.pad.connect(bob).bring(ta, E(900_000_000), E("0.01"), true);                  // the outer call is honest and goes through
      expect(await t.cbTried()).to.equal(true); expect(await t.cbOk()).to.equal(false);
      expect((await t.cbRet()).slice(0, 10)).to.equal(S.pad.interface.getError("Reentrancy").selector);
      const id = poolId(await predictKey(S, ta));
      expect((await S.hook.info(id)).creator).to.equal(bob.address); expect((await S.hook.info(id)).war).to.equal(true);
      // the same from inside a fee collection
      const key = await predictKey(S, ta);
      const p = { key, tok: t, id, quoteIs0: key.currency0 === STAG };
      await P.buy(p, carol, E(500_000)); await P.sell(p, carol, (await t.balanceOf(carol.address)) / 2n);
      await t.connect(bob).setCallback(await S.pad.getAddress(), S.pad.interface.encodeFunctionData("collectFees", [key, eve.address]));
      await S.pad.connect(bob).collectFees(key, bob.address);
      expect(await t.cbOk()).to.equal(false);
      expect((await t.cbRet()).slice(0, 10)).to.equal(S.pad.interface.getError("Reentrancy").selector);
      expect(await t.balanceOf(eve.address)).to.equal(0n);
    });
  });

  describe("liquidity is locked", () => {
    it("the pad has no way to move liquidity: its whole write surface is bring, collectFees and three registration switches", async () => {
      expect(writes(S.pad)).to.deep.equal(["allow", "bring", "collectFees", "deny", "setCurated", "unlockCallback"]);
      await expect(S.pad.connect(owner).unlockCallback("0x")).to.be.revertedWithCustomError(S.pad, "NotPM");    // only the pool manager may call back
      // the hook: PadHook's surface minus pushHolders, plus setBarred
      expect(writes(S.hook).filter((n) => !/^(before|after)/.test(n))).to.deep.equal(
        ["acceptOwner", "burnChest", "burnForced", "claimCreator", "claimPlatform", "register", "setBarred", "setLocked", "setMode", "setOwner", "settleChests", "unlockCallback", "wire"]);
    });

    it("nobody else can add liquidity, nobody can remove any, and trading and fee collection leave it unchanged", async () => {
      const lp = await (await ethers.getContractFactory("PoolModifyLiquidityTest")).deploy(PM);
      const liq0 = await P.posLiq(A); expect(liq0).to.be.gt(0n);
      const pl = await S.pad.pools(A.id);
      for (const who of [alice, eve, owner]) {
        await tokA.connect(alice).transfer(who.address, E(1000)).catch(() => {});
        await tokA.connect(who).approve(await lp.getAddress(), ethers.MaxUint256); await S.stag.connect(who).approve(await lp.getAddress(), ethers.MaxUint256);
        await expect(lp.connect(who)[LP_SIG](A.key, { tickLower: pl.tickLower, tickUpper: pl.tickUpper, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash }, "0x")).to.be.reverted;   // add: hook says no
        await expect(lp.connect(who)[LP_SIG](A.key, { tickLower: pl.tickLower, tickUpper: pl.tickUpper, liquidityDelta: -(10n ** 18n), salt: ethers.ZeroHash }, "0x")).to.be.reverted; // remove: they own no position
      }
      await P.buy(A, carol, E(2_000_000)); await P.sell(A, carol, (await tokA.balanceOf(carol.address)) / 3n);
      const s0 = await S.stag.balanceOf(alice.address), t0 = await tokA.balanceOf(alice.address);
      await expect(S.pad.connect(eve).collectFees(A.key, eve.address)).to.be.revertedWithCustomError(S.pad, "NotCreator");
      await expect(S.pad.connect(owner).collectFees(A.key, owner.address)).to.be.revertedWithCustomError(S.pad, "NotCreator");   // not even the platform owner
      await S.pad.connect(alice).collectFees(A.key, alice.address);
      expect((await S.stag.balanceOf(alice.address)) - s0).to.be.gt(0n); expect((await tokA.balanceOf(alice.address)) - t0).to.be.gt(0n);   // 0.30% LP fee, both sides
      expect(await P.posLiq(A)).to.equal(liq0);
      expect(await tokA.balanceOf(await S.pad.getAddress())).to.equal(0n);
      expect(await P.balanced()).to.equal(true);
    });
  });

  describe("tax and chest", () => {
    let L;   // a pool launched the old way, for side-by-side numbers
    it("the 3% tax books exactly as on a launched pool: same chest, same volume, same platform share", async () => {
      L = await PV.launch(dave, true);
      const B = FR;
      const amt = E(1_000_000);
      await PV.buy(L, carol, amt); await P.buy(B, carol, amt);
      const l1 = await PV.inf(L), b1 = await P.inf(B);
      expect(b1.chest).to.equal(amt * 3n / 100n); expect(b1.chest).to.equal(l1.chest);
      expect(b1.volume).to.equal(amt - amt * 3n / 100n); expect(b1.volume).to.equal(l1.volume);
      const pl0 = await V.hook.platformOwed(), pb0 = await S.hook.platformOwed();
      await PV.sellOut(L, carol, E(1000)); await P.sellOut(B, carol, E(1000));              // receive exactly 1000 $STAG each
      expect((await S.hook.platformOwed()) - pb0).to.equal((await V.hook.platformOwed()) - pl0);
      expect((await S.hook.platformOwed()) - pb0).to.be.gt(0n);
      expect((await P.inf(B)).volume - b1.volume).to.equal((await PV.inf(L)).volume - l1.volume);
      await P.buyOut(B, carol, E(1000)); await P.sell(B, carol, E(500));                    // the other two swap shapes
      expect((await P.inf(B)).holderOwed).to.equal(0n);
      expect(await P.balanced()).to.equal(true); expect(await PV.solvent([L])).to.equal(true);
    });

    it("partial fills and empty swaps are refused, as on a launched pool", async () => {
      const sq = (await S.stateView.getSlot0(A.id))[0];
      const near = A.quoteIs0 ? sq - sq / 100000n : sq + sq / 100000n;                      // a price limit the buy will hit long before it fills
      await expect(S.router.connect(carol).swap(A.key, { zeroForOne: A.quoteIs0, amountSpecified: -E(5_000_000), sqrtPriceLimitX96: near }, { takeClaims: false, settleUsingBurn: false }, "0x")).to.be.reverted;
      const v0 = (await P.inf(A)).volume;
      await P.buy(A, carol, E(10_000));                                                     // the same pool does take a buy that fills
      expect((await P.inf(A)).volume).to.be.gt(v0);
    });

    it("peace mode: 1/3 of the buy tax to the creator, 2/3 to the chest, nothing is ever sent to the token contract", async () => {
      await expect(S.hook.connect(bob).setMode(A.key, false)).to.be.revertedWithCustomError(S.hook, "NotAllowed");
      await S.hook.connect(alice).setMode(A.key, false);
      const i0 = await P.inf(A), tokStag0 = await S.stag.balanceOf(await tokA.getAddress());
      const amt = E(300_000), fee = amt * 3n / 100n;
      await P.buy(A, carol, amt);
      const i1 = await P.inf(A);
      expect(i1.creatorOwed - i0.creatorOwed).to.equal(fee / 3n);
      expect(i1.chest - i0.chest).to.equal(fee - fee / 3n);
      expect(i1.holderOwed).to.equal(0n);
      expect(await S.stag.balanceOf(await tokA.getAddress())).to.equal(tokStag0);           // the foreign token contract receives no $STAG
      await expect(S.hook.connect(bob).claimCreator(A.key, bob.address)).to.be.revertedWithCustomError(S.hook, "NotAllowed");
      const s0 = await S.stag.balanceOf(alice.address);
      await S.hook.connect(alice).claimCreator(A.key, alice.address);
      expect((await S.stag.balanceOf(alice.address)) - s0).to.equal(i1.creatorOwed);
      await S.hook.connect(alice).setMode(A.key, true);
      expect(await P.balanced()).to.equal(true);
    });

    it("burning the chest buys the token and sends it to the dead address; creator only, once an hour, capped per call", async () => {
      const i0 = await P.inf(A), d0 = await tokA.balanceOf(DEAD), sup = await tokA.totalSupply(), tick0 = await P.tick(A);
      expect(i0.chest).to.be.gt(0n);
      await expect(S.hook.connect(bob).burnChest(A.key, 0)).to.be.revertedWithCustomError(S.hook, "NotAllowed");
      await expect(S.hook.connect(owner).burnChest(A.key, 0)).to.be.revertedWithCustomError(S.hook, "NotAllowed");   // the platform owner cannot spend a chest either
      await expect(S.hook.connect(alice).burnChest(A.key, ethers.MaxUint256)).to.be.reverted;                        // minimum-out is honoured
      await S.hook.connect(alice).burnChest(A.key, 0);
      const i1 = await P.inf(A), got = (await tokA.balanceOf(DEAD)) - d0;
      expect(got).to.be.gt(0n); expect(i1.chest).to.be.lt(i0.chest);
      expect(await tokA.totalSupply()).to.equal(sup);                                       // sent to the dead address: supply itself does not fall
      expect(await tokA.balanceOf(await S.hook.getAddress())).to.equal(0n);                 // the hook never holds the token
      expect(Math.abs((await P.tick(A)) - tick0)).to.be.lte(151);                           // ~1.5% price cap per burn
      await P.buy(A, carol, E(500_000));                                                    // the chest fills again
      await expect(S.hook.connect(alice).burnChest(A.key, 0)).to.be.revertedWithCustomError(S.hook, "BurnTooSoon");
      await time.increase(HOUR + 1);
      await S.hook.connect(alice).burnChest(A.key, 0);
      expect(await P.balanced()).to.equal(true);
    });

    it("the unchanged PadRouter, pointed at the open hook, trades a brought-in pool", async () => {
      const R = await (await ethers.getContractFactory("PadRouter")).deploy(PM, await S.hook.getAddress(), STAG, "0x8e68043f7553ff7adf30eb8b0baac8d8fc2ed958");
      const dl = (await time.latest()) + 1000;
      await S.stag.connect(dave).approve(await R.getAddress(), ethers.MaxUint256);
      const t0 = await tokA.balanceOf(dave.address);
      await R.connect(dave).swapExactIn(A.key, A.quoteIs0, E(100_000), 1, dave.address, dl);
      const got = (await tokA.balanceOf(dave.address)) - t0;
      expect(got).to.be.gt(0n);
      await tokA.connect(dave).approve(await R.getAddress(), ethers.MaxUint256);
      const s0 = await S.stag.balanceOf(dave.address);
      await R.connect(dave).swapExactIn(A.key, !A.quoteIs0, got, 1, dave.address, dl);
      expect((await S.stag.balanceOf(dave.address)) - s0).to.be.gt(0n);
      const VR = await (await ethers.getContractFactory("PadRouter")).deploy(PM, await V.hook.getAddress(), STAG, "0x8e68043f7553ff7adf30eb8b0baac8d8fc2ed958");
      await S.stag.connect(dave).approve(await VR.getAddress(), ethers.MaxUint256);
      await expect(VR.connect(dave).swapExactIn(A.key, A.quoteIs0, E(1000), 1, dave.address, dl)).to.be.revertedWithCustomError(VR, "BadPool");   // the old router keeps refusing pools of another hook
      expect(await P.balanced()).to.equal(true);
    });
  });
});
