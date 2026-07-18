const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const ZERO = "0x0000000000000000000000000000000000000000";

async function fresh() {
  const [owner, feeWallet, maker, taker, other] = await ethers.getSigners();
  const market = await (await ethers.getContractFactory("SherwoodMarket")).deploy(feeWallet.address);
  const A = await (await ethers.getContractFactory("MockERC20")).deploy(); // sell token
  const B = await (await ethers.getContractFactory("MockERC20")).deploy(); // erc20 pay token
  await A.mint(maker.address, E(10_000_000));
  await B.mint(taker.address, E(10_000_000));
  return { owner, feeWallet, maker, taker, other, market, A, B, mAddr: await market.getAddress() };
}

describe("SherwoodMarket — ADVERSARIAL", () => {

  it("H1: fee snapshot — owner raising fees AFTER a post does NOT re-tax the open order", async () => {
    const { market, A, maker, taker, feeWallet, owner } = await fresh();
    const mAddr = await market.getAddress();
    await A.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await A.getAddress(), E(1000), ZERO, E(1)); // posted at 1%/1%

    // owner cranks fees to the 3% cap AFTER the order exists
    await market.connect(owner).setFees(300, 300);

    const makerEthBefore = await ethers.provider.getBalance(maker.address);
    await market.connect(taker).fillOrder(0, { value: E(1) });

    // still settled at the SNAPSHOT 1% — not the new 3%
    expect(await A.balanceOf(taker.address)).to.equal(E(990));       // 1% sell fee, not 3%
    expect(await A.balanceOf(feeWallet.address)).to.equal(E(10));
    expect(await ethers.provider.getBalance(maker.address)).to.equal(makerEthBefore + E("0.99")); // 1% buy fee
  });

  it("H2: fee snapshot — a NEW order after setFees uses the NEW rate", async () => {
    const { market, A, maker, taker, feeWallet, owner } = await fresh();
    const mAddr = await market.getAddress();
    await market.connect(owner).setFees(200, 50); // 2% buy / 0.5% sell
    await A.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await A.getAddress(), E(1000), ZERO, E(1));
    const o = await market.getOrder(0);
    expect(o.buyFeeBps).to.equal(200n);
    expect(o.sellFeeBps).to.equal(50n);
    const makerEthBefore = await ethers.provider.getBalance(maker.address);
    await market.connect(taker).fillOrder(0, { value: E(1) });
    expect(await A.balanceOf(taker.address)).to.equal(E("995"));            // 0.5% sell fee
    expect(await ethers.provider.getBalance(maker.address)).to.equal(makerEthBefore + E("0.98")); // 2% buy fee
  });

  it("H3: fee-on-transfer SELL token — escrow measures actual received; fill never over-transfers", async () => {
    const { market, maker, taker, feeWallet } = await fresh();
    const mAddr = await market.getAddress();
    const TAX = await (await ethers.getContractFactory("MockFeeToken")).deploy(200); // 2% burn on transfer
    await TAX.mint(maker.address, E(1000));
    await TAX.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await TAX.getAddress(), E(1000), ZERO, E(1));

    // maker sent 1000 but 2% burned -> only 980 actually escrowed; order records 980
    const o = await market.getOrder(0);
    expect(o.sellAmount).to.equal(E(980));
    expect(await TAX.balanceOf(mAddr)).to.equal(E(980));

    await market.connect(taker).fillOrder(0, { value: E(1) });
    // contract fully drained, never tried to move more than it held
    expect(await TAX.balanceOf(mAddr)).to.equal(0);
    // taker got 99% of the 980 escrow, minus the token's own 2% transfer tax on the way out
    // sellFee = 9.8 -> toTaker = 970.2, then 2% burn -> taker nets 950.796
    expect(await TAX.balanceOf(taker.address)).to.equal(E("950.796"));
  });

  it("H4: fee-on-transfer BUY token — maker + feeWallet receive net, no revert, no stuck funds", async () => {
    const { market, A, maker, taker, feeWallet } = await fresh();
    const mAddr = await market.getAddress();
    const TAX = await (await ethers.getContractFactory("MockFeeToken")).deploy(100); // 1% burn
    await TAX.mint(taker.address, E(1000));
    await A.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await A.getAddress(), E(1000), await TAX.getAddress(), E(500));
    await TAX.connect(taker).approve(mAddr, E(500));

    await market.connect(taker).fillOrder(0);
    expect(await A.balanceOf(taker.address)).to.equal(E(990)); // sell side unaffected
    // buy side: toMaker=495 (1% market fee) then 1% token tax -> maker nets 490.05
    expect(await TAX.balanceOf(maker.address)).to.equal(E("490.05"));
    // buyFee=5 then 1% tax -> feeWallet nets 4.95
    expect(await TAX.balanceOf(feeWallet.address)).to.equal(E("4.95"));
    expect(await TAX.balanceOf(mAddr)).to.equal(0); // nothing stuck
  });

  it("H5: reentrancy — a hostile buy token trying to re-enter fillOrder reverts the whole tx", async () => {
    const { market, A, maker, taker } = await fresh();
    const mAddr = await market.getAddress();
    const REE = await (await ethers.getContractFactory("ReentrantToken")).deploy();
    await REE.mint(taker.address, E(1000));
    await A.connect(maker).approve(mAddr, E(2000));
    await market.connect(maker).createOrder(await A.getAddress(), E(1000), await REE.getAddress(), E(500)); // id0
    await market.connect(maker).createOrder(await A.getAddress(), E(1000), await REE.getAddress(), E(500)); // id1
    await REE.connect(taker).approve(mAddr, E(500));
    await REE.arm(mAddr, 1); // when REE.transferFrom fires during fill(0), it re-enters fill(1)

    await expect(market.connect(taker).fillOrder(0)).to.be.reverted; // guard trips -> entire tx reverts
    // both orders still open & escrow intact
    expect((await market.getOrder(0)).active).to.equal(true);
    expect((await market.getOrder(1)).active).to.equal(true);
    expect(await A.balanceOf(mAddr)).to.equal(E(2000));
  });

  it("H6: hostile maker that rejects ETH — fill reverts, escrow untouched, maker can still cancel", async () => {
    const { market, A, taker } = await fresh();
    const mAddr = await market.getAddress();
    const HM = await (await ethers.getContractFactory("HostileMaker")).deploy();
    const hmAddr = await HM.getAddress();
    await A.mint(hmAddr, E(1000));
    await HM.post(mAddr, await A.getAddress(), E(1000), ZERO, E(1)); // hostile maker posts ETH-priced order

    // taker's ETH fill can't pay the maker (it reverts on receive) -> whole fill reverts, taker refunded
    await expect(market.connect(taker).fillOrder(0, { value: E(1) })).to.be.revertedWith("pay maker failed");
    expect((await market.getOrder(0)).active).to.equal(true);
    expect(await A.balanceOf(mAddr)).to.equal(E(1000));
    // maker can still recover its escrow via cancel
    await HM.cancel(mAddr, 0);
    expect(await A.balanceOf(hmAddr)).to.equal(E(1000));
    expect(await A.balanceOf(mAddr)).to.equal(0);
  });

  it("H7: hostile feeWallet that rejects ETH bricks only ETH fills — owner can hot-swap it to recover", async () => {
    const [owner, , maker, taker, other] = await ethers.getSigners();
    const REV = await (await ethers.getContractFactory("Reverter")).deploy();
    const market = await (await ethers.getContractFactory("SherwoodMarket")).deploy(await REV.getAddress());
    const mAddr = await market.getAddress();
    const A = await (await ethers.getContractFactory("MockERC20")).deploy();
    await A.mint(maker.address, E(1000));
    await A.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await A.getAddress(), E(1000), ZERO, E(1));

    await expect(market.connect(taker).fillOrder(0, { value: E(1) })).to.be.revertedWith("pay fee failed");
    // owner repoints feeWallet to a good address; fill now works
    await market.connect(owner).setFeeWallet(other.address);
    await market.connect(taker).fillOrder(0, { value: E(1) });
    expect(await A.balanceOf(taker.address)).to.equal(E(990));
    expect(await A.balanceOf(other.address)).to.equal(E(10));
  });

  it("H8: cancel racing a fill — cancel wins, the fill reverts and the taker's ETH is refunded", async () => {
    const { market, A, maker, taker } = await fresh();
    const mAddr = await market.getAddress();
    await A.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(await A.getAddress(), E(1000), ZERO, E(1));
    await market.connect(maker).cancelOrder(0); // maker pulls the rug first
    const ethBefore = await ethers.provider.getBalance(taker.address);
    await expect(market.connect(taker).fillOrder(0, { value: E(1) })).to.be.revertedWith("not open");
    // taker only spent gas — the 1 ETH never left (revert refunds it)
    const ethAfter = await ethers.provider.getBalance(taker.address);
    expect(ethBefore - ethAfter).to.be.lessThan(E("0.01"));
    expect(await A.balanceOf(maker.address)).to.equal(E(10_000_000)); // full escrow back
  });

  it("H9: no cross-order draining — filling one order can't touch another order's escrow", async () => {
    const { market, A, maker, taker } = await fresh();
    const mAddr = await market.getAddress();
    await A.connect(maker).approve(mAddr, E(3000));
    await market.connect(maker).createOrder(await A.getAddress(), E(1000), ZERO, E(1)); // id0
    await market.connect(maker).createOrder(await A.getAddress(), E(2000), ZERO, E(2)); // id1
    expect(await A.balanceOf(mAddr)).to.equal(E(3000));
    await market.connect(taker).fillOrder(0, { value: E(1) });
    // exactly id0's 1000 left; id1's 2000 still escrowed
    expect(await A.balanceOf(mAddr)).to.equal(E(2000));
    expect((await market.getOrder(1)).sellAmount).to.equal(E(2000));
    expect((await market.getOrder(1)).active).to.equal(true);
  });

  it("H10: dust order where fees round to zero still settles cleanly", async () => {
    const { market, A, maker, taker, feeWallet } = await fresh();
    const mAddr = await market.getAddress();
    await A.connect(maker).approve(mAddr, 50n); // 50 wei-tokens; 1% -> 0 fee (rounds down)
    await market.connect(maker).createOrder(await A.getAddress(), 50n, ZERO, 50n);
    await market.connect(taker).fillOrder(0, { value: 50n });
    expect(await A.balanceOf(taker.address)).to.equal(50n); // taker gets all 50, fee rounded to 0
    expect(await A.balanceOf(feeWallet.address)).to.equal(0n);
  });

  it("H11: escrowedOf tracks live escrow exactly through create/fill/cancel", async () => {
    const { market, A, maker, taker } = await fresh();
    const mAddr = await market.getAddress();
    const aAddr = await A.getAddress();
    await A.connect(maker).approve(mAddr, E(3000));
    await market.connect(maker).createOrder(aAddr, E(1000), ZERO, E(1)); // id0
    await market.connect(maker).createOrder(aAddr, E(2000), ZERO, E(2)); // id1
    expect(await market.escrowedOf(aAddr)).to.equal(E(3000));
    await market.connect(taker).fillOrder(0, { value: E(1) });
    expect(await market.escrowedOf(aAddr)).to.equal(E(2000)); // id0 released
    await market.connect(maker).cancelOrder(1);
    expect(await market.escrowedOf(aAddr)).to.equal(0);       // id1 released
  });

  it("H12: rescueSurplus recovers ONLY donated tokens, never live escrow", async () => {
    const { market, A, maker, owner, other } = await fresh();
    const mAddr = await market.getAddress();
    const aAddr = await A.getAddress();
    await A.connect(maker).approve(mAddr, E(1000));
    await market.connect(maker).createOrder(aAddr, E(1000), ZERO, E(1)); // 1000 escrowed
    await A.mint(mAddr, E(250)); // someone donates/misfires 250 directly to the contract

    await market.connect(owner).rescueSurplus(aAddr, other.address);
    expect(await A.balanceOf(other.address)).to.equal(E(250)); // only the surplus
    expect(await A.balanceOf(mAddr)).to.equal(E(1000));        // live escrow untouched
    // no surplus left -> reverts
    await expect(market.connect(owner).rescueSurplus(aAddr, other.address)).to.be.revertedWith("no surplus");
    // maker can still cancel and get the FULL escrow back
    await market.connect(maker).cancelOrder(0);
    expect(await A.balanceOf(mAddr)).to.equal(0);
  });

  it("H13: input validation — codeless buyToken and same-token orders are rejected at post", async () => {
    const { market, A, maker } = await fresh();
    const mAddr = await market.getAddress();
    const aAddr = await A.getAddress();
    await A.connect(maker).approve(mAddr, E(2000));
    // codeless buyToken (an EOA address) -> rejected
    await expect(
      market.connect(maker).createOrder(aAddr, E(1000), maker.address, E(1))
    ).to.be.revertedWith("bad buyToken");
    // sell == buy -> rejected
    await expect(
      market.connect(maker).createOrder(aAddr, E(1000), aAddr, E(1))
    ).to.be.revertedWith("same token");
  });

  it("H14: rescueSurplus is owner-only", async () => {
    const { market, A, other } = await fresh();
    await expect(market.connect(other).rescueSurplus(await A.getAddress(), other.address)).to.be.reverted;
  });

  // ---------- randomized invariant fuzzer ----------
  it("FUZZ: 200 random create/fill/cancel ops — escrow invariant + no stuck ETH always hold", async () => {
    const signers = await ethers.getSigners();
    const feeWallet = signers[1];
    const market = await (await ethers.getContractFactory("SherwoodMarket")).deploy(feeWallet.address);
    const mAddr = await market.getAddress();
    const A = await (await ethers.getContractFactory("MockERC20")).deploy();
    const aAddr = await A.getAddress();
    const actors = signers.slice(2, 8); // 6 traders
    for (const s of actors) { await A.mint(s.address, E(1_000_000)); await A.connect(s).approve(mAddr, ethers.MaxUint256); }

    // deterministic PRNG (no Math.random in this env anyway)
    let seed = 1337;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    const live = []; // {id, maker, sellAmount, buyAmount}
    let created = 0;

    for (let step = 0; step < 200; step++) {
      const roll = rnd(100);
      if (roll < 55 || live.length === 0) {
        // CREATE
        const maker = actors[rnd(actors.length)];
        const sell = BigInt(1 + rnd(5000)) * 10n ** 15n;
        const buy = BigInt(1 + rnd(3)) * 10n ** 18n;
        await market.connect(maker).createOrder(aAddr, sell, ZERO, buy);
        // record ACTUAL escrowed amount from the order (plain token: equals sell)
        const o = await market.getOrder(created);
        live.push({ id: created, maker: maker.address, sellAmount: o.sellAmount, buyAmount: o.buyAmount });
        created++;
      } else if (roll < 85) {
        // FILL a random live order by a non-maker
        const idx = rnd(live.length);
        const ord = live[idx];
        const taker = actors.find((s) => s.address !== ord.maker);
        await market.connect(taker).fillOrder(ord.id, { value: ord.buyAmount });
        live.splice(idx, 1);
      } else {
        // CANCEL a random live order by its maker
        const idx = rnd(live.length);
        const ord = live[idx];
        const maker = actors.find((s) => s.address === ord.maker);
        await market.connect(maker).cancelOrder(ord.id);
        live.splice(idx, 1);
      }

      // INVARIANT 1: contract token balance == sum of active escrows == escrowedOf accounting
      const expected = live.reduce((acc, o) => acc + o.sellAmount, 0n);
      expect(await A.balanceOf(mAddr)).to.equal(expected);
      expect(await market.escrowedOf(aAddr)).to.equal(expected);
      // INVARIANT 2: the market never holds ETH between txs (all forwarded atomically)
      expect(await ethers.provider.getBalance(mAddr)).to.equal(0n);
    }
    // drain everything that's left and re-check the invariant lands at zero
    for (const o of [...live]) {
      const maker = actors.find((s) => s.address === o.maker);
      await market.connect(maker).cancelOrder(o.id);
    }
    expect(await A.balanceOf(mAddr)).to.equal(0n);
    expect(await ethers.provider.getBalance(mAddr)).to.equal(0n);
  });
});
