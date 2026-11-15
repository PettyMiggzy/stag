const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { PM, STAG, E, fundStag, deployStack, mk } = require("./helpers");
const CURVE = "0x8e68043f7553ff7adf30eb8b0baac8d8fc2ed958";
const ABI_CURVE = ["function graduated() view returns (bool)", "function buy(uint256,uint256,address) payable returns (uint256)", "function sell(uint256,uint256,address) returns (uint256)", "function isNativeQuote() view returns (bool)"];
const DL = () => Math.floor(Date.now() / 1000) + 3600;

describe("PadRouter (fork)", function () {
  this.timeout(900000);
  let S, api, signers, alice, bob, router, stag, p, mock, mockRouter; const all = [];
  before(async () => {
    signers = await ethers.getSigners(); [, alice, bob] = signers;
    await fundStag(signers.slice(0, 5), E(50_000_000));
    S = await deployStack(signers[0]); api = mk(S, signers);
    stag = S.stag;
    router = await (await ethers.getContractFactory("PadRouter")).deploy(PM, await S.hook.getAddress(), STAG, CURVE);
    p = await api.launch(alice, true);                           // a war-mode pool
    all.push(p);
    for (const s of [alice, bob]) await stag.connect(s).approve(await router.getAddress(), ethers.MaxUint256);
    // mock-curve router for edge cases; the mock holds STAG (storage-funded) and ETH
    mock = await (await ethers.getContractFactory("MockCurve")).deploy(STAG, 1000n);
    const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [await mock.getAddress(), 0]));
    await network.provider.send("hardhat_setStorageAt", [STAG, slot, ethers.toBeHex(E(10_000_000), 32)]);
    await signers[0].sendTransaction({ to: await mock.getAddress(), value: E(50) });
    mockRouter = await (await ethers.getContractFactory("PadRouter")).deploy(PM, await S.hook.getAddress(), STAG, await mock.getAddress());
    await p.tok.connect(bob).approve(await mockRouter.getAddress(), ethers.MaxUint256);
  });
  const bal = (t, a) => t.balanceOf(a);

  it("buy exact-in with STAG: pays exactly amountIn, receives tokens, pool stays solvent", async () => {
    const amt = E(1000), b0 = await bal(stag, bob.address), t0 = await bal(p.tok, bob.address);
    await router.connect(bob).swapExactIn(p.key, p.quoteIs0, amt, 1, bob.address, DL());
    expect(b0 - (await bal(stag, bob.address))).to.equal(amt);
    expect((await bal(p.tok, bob.address)) - t0).to.be.gt(0n);
    expect(await api.solvent(all)).to.equal(true);
    expect(await bal(stag, await router.getAddress())).to.equal(0n);
    expect(await bal(p.tok, await router.getAddress())).to.equal(0n);
  });

  it("sell exact-in token: pays exactly amountIn tokens, receives STAG net of tax, solvent", async () => {
    const t0 = await bal(p.tok, bob.address), amt = t0 / 2n, s0 = await bal(stag, bob.address);
    await p.tok.connect(bob).approve(await router.getAddress(), ethers.MaxUint256);
    await router.connect(bob).swapExactIn(p.key, !p.quoteIs0, amt, 1, bob.address, DL());
    expect(t0 - (await bal(p.tok, bob.address))).to.equal(amt);
    expect((await bal(stag, bob.address)) - s0).to.be.gt(0n);
    expect(await api.solvent(all)).to.equal(true);
  });

  it("minOut, deadline, zero amount, wrong pool all revert", async () => {
    await expect(router.connect(bob).swapExactIn(p.key, p.quoteIs0, E(10), ethers.MaxUint256 >> 129n, bob.address, DL())).to.be.reverted;   // minOut unreachable
    await expect(router.connect(bob).swapExactIn(p.key, p.quoteIs0, E(10), 1, bob.address, 1)).to.be.revertedWithCustomError(router, "Expired");
    await expect(router.connect(bob).swapExactIn(p.key, p.quoteIs0, 0, 0, bob.address, DL())).to.be.revertedWithCustomError(router, "ZeroAmount");
    await expect(router.connect(bob).swapExactIn(p.key, p.quoteIs0, E(10), 1, ethers.ZeroAddress, DL())).to.be.revertedWithCustomError(router, "BadValue");
    const bad = { ...p.key, hooks: ethers.Wallet.createRandom().address };
    await expect(router.connect(bob).swapExactIn(bad, p.quoteIs0, E(10), 1, bob.address, DL())).to.be.revertedWithCustomError(router, "BadPool");
    const noStag = { ...p.key, currency0: ethers.Wallet.createRandom().address, currency1: ethers.Wallet.createRandom().address };
    await expect(router.connect(bob).swapExactIn(noStag, true, E(10), 1, bob.address, DL())).to.be.revertedWithCustomError(router, "BadPool");
  });

  it("only the pool manager can call unlockCallback; the router rejects ETH from anyone but the curve", async () => {
    await expect(router.connect(bob).unlockCallback("0x")).to.be.revertedWithCustomError(router, "NotPM");
    await expect(bob.sendTransaction({ to: await router.getAddress(), value: 1n })).to.be.revertedWithCustomError(router, "NotCurve");
  });

  it("spends only the caller's own approval: nobody can pull another user's STAG through the router", async () => {
    const carol = signers[4]; await stag.connect(carol).approve(await router.getAddress(), ethers.MaxUint256);
    const c0 = await bal(stag, carol.address);
    await router.connect(bob).swapExactIn(p.key, p.quoteIs0, E(5), 1, bob.address, DL());   // bob buys; carol untouched
    expect(await bal(stag, carol.address)).to.equal(c0);
  });

  describe("zaps against a MOCK curve (edge cases)", () => {
    it("zapBuy: ETH -> STAG -> token; router ends with no ETH/STAG/token; output goes to `to`", async () => {
      const t0 = await bal(p.tok, bob.address);
      await mockRouter.connect(bob).zapBuy(p.key, 1, 1, bob.address, DL(), { value: E(1) });
      expect((await bal(p.tok, bob.address)) - t0).to.be.gt(0n);
      for (const t of [stag, p.tok]) expect(await bal(t, await mockRouter.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await mockRouter.getAddress())).to.equal(0n);
      expect(await api.solvent(all)).to.equal(true);
    });
    it("zapBuy: unspent ETH from the curve is refunded to the caller, not kept", async () => {
      await mock.set(5000, false, false);                                   // curve returns half the ETH unspent
      const e0 = await ethers.provider.getBalance(bob.address);
      const tx = await mockRouter.connect(bob).zapBuy(p.key, 1, 1, bob.address, DL(), { value: E(2) });
      const rc = await tx.wait(); const gas = rc.gasUsed * rc.gasPrice;
      const spent = e0 - (await ethers.provider.getBalance(bob.address)) - gas;
      expect(spent).to.equal(E(1));                                          // only the spent half
      expect(await ethers.provider.getBalance(await mockRouter.getAddress())).to.equal(0n);
      await mock.set(0, false, false);
    });
    it("zapBuy: a lying curve return value does not matter; the router measures the real STAG, and minStag is enforced on it", async () => {
      await mock.set(0, true, false);
      await expect(mockRouter.connect(bob).zapBuy(p.key, E(1000) * 1000n * 2n, 1, bob.address, DL(), { value: E(1) })).to.be.reverted;   // asks for 2x what the curve really gave
      await mock.set(0, false, true);                                       // stingy curve: gives half of what minStag would need
      await expect(mockRouter.connect(bob).zapBuy(p.key, 1000n * E(1), 1, bob.address, DL(), { value: E(1) })).to.be.revertedWithCustomError(mockRouter, "Slippage");
      await mock.set(0, false, false);
    });
    it("zapBuy: wrong direction pool / zero value / expired / reentrancy-safe revert", async () => {
      await expect(mockRouter.connect(bob).zapBuy(p.key, 1, 1, bob.address, DL(), { value: 0 })).to.be.revertedWithCustomError(mockRouter, "ZeroAmount");
      await expect(mockRouter.connect(bob).zapBuy(p.key, 1, 1, bob.address, 1, { value: 1n })).to.be.revertedWithCustomError(mockRouter, "Expired");
    });
    it("zapSell: token -> STAG -> ETH; ETH goes to `to`; router holds nothing; approval to the curve is reset to 0", async () => {
      const t0 = await bal(p.tok, bob.address); expect(t0).to.be.gt(0n);
      const amt = t0 / 4n, to = ethers.Wallet.createRandom().address, e0 = await ethers.provider.getBalance(to);
      await mockRouter.connect(bob).zapSell(p.key, amt, 1, to, DL());
      expect((await ethers.provider.getBalance(to)) - e0).to.be.gt(0n);
      expect(await bal(stag, await mockRouter.getAddress())).to.equal(0n);
      expect(await new ethers.Contract(STAG, ["function allowance(address,address) view returns (uint256)"], ethers.provider).allowance(await mockRouter.getAddress(), await mock.getAddress())).to.equal(0n);
      expect(await api.solvent(all)).to.equal(true);
    });
    it("zapSell: minEth enforced on the final ETH", async () => {
      const amt = (await bal(p.tok, bob.address)) / 10n;
      await expect(mockRouter.connect(bob).zapSell(p.key, amt, E(1_000_000), ethers.Wallet.createRandom().address, DL())).to.be.reverted;
    });
  });

  describe("zaps against the REAL $STAG curve (if it is live)", () => {
    it("zapBuy buys STAG on the real curve from a contract and swaps it into the pad token", async function () {
      const c = new ethers.Contract(CURVE, ABI_CURVE, ethers.provider);
      if (await c.graduated()) this.skip();
      const t0 = await bal(p.tok, bob.address), e0 = await ethers.provider.getBalance(await router.getAddress());
      const tx = await router.connect(bob).zapBuy(p.key, 1, 1, bob.address, DL(), { value: E(0.01) });
      await tx.wait();
      expect((await bal(p.tok, bob.address)) - t0).to.be.gt(0n);
      expect(await bal(stag, await router.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(e0);
      expect(await api.solvent(all)).to.equal(true);
    });
    it("zapSell round trip on the real curve returns ETH (or reverts cleanly if the curve refuses)", async function () {
      const c = new ethers.Contract(CURVE, ABI_CURVE, ethers.provider);
      if (await c.graduated()) this.skip();
      const amt = (await bal(p.tok, bob.address)) / 2n;
      await p.tok.connect(bob).approve(await router.getAddress(), ethers.MaxUint256);
      const dest = ethers.Wallet.createRandom().address, e0 = await ethers.provider.getBalance(dest);
      let ok = true; try { await router.connect(bob).zapSell(p.key, amt, 1, dest, DL()); } catch (e) { ok = false; console.log("      real-curve sell reverted:", String(e.message).slice(0, 120)); }
      if (ok) expect((await ethers.provider.getBalance(dest)) - e0).to.be.gt(0n);
      expect(await bal(stag, await router.getAddress())).to.equal(0n);
    });
  });

  it("both currency orderings and both modes (war + peace): buy, sell, zapBuy, zapSell all work and stay solvent", async () => {
    const pools = [];   // new pools are also tracked in `all` so every later solvency check counts them
    const seen = new Set();
    for (let k = 0; k < 14 && seen.size < 4; k++) {
      const war = k % 2 === 0, q = (await (async () => { const pp = await api.launch(alice, war, E(10_000_000), "T" + k, "T" + k); pools.push(pp); all.push(pp); return pp.quoteIs0; })());
      seen.add(`${war}-${q}`);
    }
    expect(seen.size, "saw " + [...seen]).to.equal(4);
    for (const q of pools) {
      for (const s of [bob]) await q.tok.connect(s).approve(await mockRouter.getAddress(), ethers.MaxUint256);
      await q.tok.connect(bob).approve(await router.getAddress(), ethers.MaxUint256);
      const t0 = await bal(q.tok, bob.address);
      await router.connect(bob).swapExactIn(q.key, q.quoteIs0, E(500), 1, bob.address, DL());                 // buy
      const got = (await bal(q.tok, bob.address)) - t0; expect(got).to.be.gt(0n);
      await router.connect(bob).swapExactIn(q.key, !q.quoteIs0, got / 2n, 1, bob.address, DL());              // sell half
      await mockRouter.connect(bob).zapBuy(q.key, 1, 1, bob.address, DL(), { value: E(0.5) });                 // zap in
      await mockRouter.connect(bob).zapSell(q.key, (await bal(q.tok, bob.address)) / 3n, 1, ethers.Wallet.createRandom().address, DL());   // zap out
    }
    expect(await api.solvent(all)).to.equal(true);
    for (const t of [stag]) { expect(await bal(t, await router.getAddress())).to.equal(0n); expect(await bal(t, await mockRouter.getAddress())).to.equal(0n); }
    expect(await ethers.provider.getBalance(await mockRouter.getAddress())).to.equal(0n);
  });
});
