const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { PM, STAG, E, fundStag, deployStack, mk } = require("./helpers");
const CURVE = "0x8e68043f7553ff7adf30eb8b0baac8d8fc2ed958";
const ABI_CURVE = ["function graduated() view returns (bool)", "function buy(uint256,uint256,address) payable returns (uint256)", "function sell(uint256,uint256,address) returns (uint256)", "function isNativeQuote() view returns (bool)"];
const DL = () => Number.MAX_SAFE_INTEGER;   // far future: other suites advance the simulated chain clock by days, so wall-clock deadlines would look expired

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
    await expect(router.connect(bob).swapExactIn(p.key, p.quoteIs0, E(10), E(1_000_000_000_000), bob.address, DL())).to.be.revertedWithCustomError(router, "Slippage");   // minOut unreachable
    await expect(router.connect(bob).swapExactIn(p.key, p.quoteIs0, E(10), ethers.MaxUint256, bob.address, DL())).to.be.revertedWithCustomError(router, "BadValue");   // out of range
    await expect(router.connect(bob).swapExactIn(p.key, p.quoteIs0, 2n ** 127n, 1, bob.address, DL())).to.be.revertedWithCustomError(router, "BadValue");      // does not fit an int128
    await expect(router.connect(bob).swapExactIn(p.key, p.quoteIs0, E(10), 1, await router.getAddress(), DL())).to.be.revertedWithCustomError(router, "BadValue");   // output may not be sent to the router itself
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
      await expect(mockRouter.connect(bob).zapBuy(p.key, E(1000) * 1000n * 2n, 1, bob.address, DL(), { value: E(1) })).to.be.revertedWith("slip");   // the curve itself refuses: asks for 2x what 1 ETH buys
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
      await expect(mockRouter.connect(bob).zapSell(p.key, amt, E(1_000_000), ethers.Wallet.createRandom().address, DL())).to.be.revertedWith("slip");
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
    it("zapSell round trip on the real curve returns ETH to the recipient", async function () {
      const c = new ethers.Contract(CURVE, ABI_CURVE, ethers.provider);
      if (await c.graduated()) this.skip();
      const amt = (await bal(p.tok, bob.address)) / 2n;
      await p.tok.connect(bob).approve(await router.getAddress(), ethers.MaxUint256);
      const dest = ethers.Wallet.createRandom().address, e0 = await ethers.provider.getBalance(dest);
      await router.connect(bob).zapSell(p.key, amt, 1, dest, DL());
      expect((await ethers.provider.getBalance(dest)) - e0).to.be.gt(0n);
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

  describe("router hardening (mock curve)", () => {
    it("zapSell: expired deadline, wrong pool, zero or router recipient all revert with the right error", async () => {
      const amt = (await bal(p.tok, bob.address)) / 20n, to = ethers.Wallet.createRandom().address;
      await expect(mockRouter.connect(bob).zapSell(p.key, amt, 1, to, 1)).to.be.revertedWithCustomError(mockRouter, "Expired");
      await expect(mockRouter.connect(bob).zapSell({ ...p.key, hooks: ethers.Wallet.createRandom().address }, amt, 1, to, DL())).to.be.revertedWithCustomError(mockRouter, "BadPool");
      await expect(mockRouter.connect(bob).zapSell(p.key, amt, 1, ethers.ZeroAddress, DL())).to.be.revertedWithCustomError(mockRouter, "BadValue");
      await expect(mockRouter.connect(bob).zapSell(p.key, amt, 1, await mockRouter.getAddress(), DL())).to.be.revertedWithCustomError(mockRouter, "BadValue");
      await expect(mockRouter.connect(bob).zapBuy(p.key, 1, 1, await mockRouter.getAddress(), DL(), { value: 1n })).to.be.revertedWithCustomError(mockRouter, "BadValue");
      await expect(mockRouter.connect(bob).zapBuy(p.key, 1, 1, ethers.ZeroAddress, DL(), { value: 1n })).to.be.revertedWithCustomError(mockRouter, "BadValue");
    });
    it("zapSell and zapBuy reject a pool whose currencies do not include $STAG", async () => {
      const noStag = { ...p.key, currency0: ethers.Wallet.createRandom().address, currency1: ethers.Wallet.createRandom().address };
      await expect(mockRouter.connect(bob).zapBuy(noStag, 1, 1, bob.address, DL(), { value: 1n })).to.be.revertedWithCustomError(mockRouter, "BadPool");
      await expect(mockRouter.connect(bob).zapSell(noStag, 1, 1, bob.address, DL())).to.be.revertedWithCustomError(mockRouter, "BadPool");
    });
    it("re-entering the router from inside the ETH payment of zapSell is blocked, and the outer call still completes", async () => {
      const A = await (await ethers.getContractFactory("ReenterOnReceive")).deploy(await mockRouter.getAddress());
      await A.setKey(p.key); await A.approveToken(await p.tok.getAddress());
      const amt = E(200_000);                                                                           // small: the mock curve holds limited ETH
      await p.tok.connect(bob).transfer(await A.getAddress(), amt);
      await A.sell(amt / 2n);
      expect(await A.tried()).to.equal(true);
      expect(await A.blocked(), "the nested call must be blocked").to.equal(true);
      expect(await A.reentered()).to.equal(false);
      expect(await ethers.provider.getBalance(await A.getAddress())).to.be.gt(0n);                  // the outer sale paid out
      // and a fresh call afterwards works (the lock was released)
      await mockRouter.connect(bob).zapBuy(p.key, 1, 1, bob.address, DL(), { value: E(0.1) });
    });
    it("re-entering from inside the ETH refund of zapBuy is blocked", async () => {
      await mock.set(5000, false, false);
      const A = await (await ethers.getContractFactory("ReenterOnReceive")).deploy(await mockRouter.getAddress());
      await A.setKey(p.key);
      await A.buy({ value: E(2) });
      expect(await A.blocked()).to.equal(true); expect(await A.reentered()).to.equal(false);
      await mock.set(0, false, false);
    });
    it("a caller that cannot receive ETH makes the refund fail with SendFailed (the whole zap reverts, nothing is lost)", async () => {
      await mock.set(5000, false, false);
      const R = await (await ethers.getContractFactory("RejectETH")).deploy(await mockRouter.getAddress());
      await R.setKey(p.key);
      await expect(R.buy({ value: E(1) })).to.be.revertedWithCustomError(mockRouter, "SendFailed");
      expect(await ethers.provider.getBalance(await mockRouter.getAddress())).to.equal(0n);
      await mock.set(0, false, false);
      // and zapSell to a recipient that rejects ETH fails cleanly
      await expect(mockRouter.connect(bob).zapSell(p.key, E(100_000), 1, await R.getAddress(), DL())).to.be.revertedWithCustomError(mockRouter, "SendFailed");
    });
    it("ETH already sitting in the router is never refunded to a caller and never counted as proceeds", async () => {
      await (await ethers.getContractFactory("ForceETH")).deploy(await mockRouter.getAddress(), { value: E(3) });
      expect(await ethers.provider.getBalance(await mockRouter.getAddress())).to.equal(E(3));
      await mock.set(5000, false, false);                                                              // curve refunds half
      const e0 = await ethers.provider.getBalance(bob.address);
      const tx = await mockRouter.connect(bob).zapBuy(p.key, 1, 1, bob.address, DL(), { value: E(2) });
      const rc = await tx.wait(); const spent = e0 - (await ethers.provider.getBalance(bob.address)) - rc.gasUsed * rc.gasPrice;
      expect(spent).to.equal(E(1));                                                                    // only the half the curve really used
      expect(await ethers.provider.getBalance(await mockRouter.getAddress())).to.equal(E(3));          // the donation stays untouched
      await mock.set(0, false, false);
      // a sell pays out only what the curve really delivered, not the forced balance
      const to = ethers.Wallet.createRandom().address;
      await mockRouter.connect(bob).zapSell(p.key, E(100_000), 1, to, DL());
      const got = await ethers.provider.getBalance(to);
      expect(got).to.be.gt(0n); expect(got).to.be.lt(E(3));
      expect(await ethers.provider.getBalance(await mockRouter.getAddress())).to.equal(E(3));
    });
    it("the curve allowance is reset to zero even when the curve pulls only part of what was offered", async () => {
      await mock.setHalf(true);
      await mockRouter.connect(bob).zapSell(p.key, E(100_000), 1, ethers.Wallet.createRandom().address, DL());
      expect(await new ethers.Contract(STAG, ["function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"], ethers.provider).allowance(await mockRouter.getAddress(), await mock.getAddress())).to.equal(0n);
      await mock.setHalf(false);
    });
    it("zapSell trusts only what actually arrives: a lying curve return value does not change the payout or the minEth check", async () => {
      await mock.set(0, true, false);                                                                  // sell() returns double the real ETH
      const amt = E(100_000), to = ethers.Wallet.createRandom().address;
      await expect(mockRouter.connect(bob).zapSell(p.key, amt, E(1_000_000), to, DL())).to.be.revertedWith("slip");
      await mockRouter.connect(bob).zapSell(p.key, amt, 1, to, DL());
      const real = await ethers.provider.getBalance(to);
      expect(real).to.be.gt(0n);
      await mock.set(0, false, false);
    });
    it("zapBuy sends the output to `to`, not to the caller", async () => {
      const to = ethers.Wallet.createRandom().address, t0 = await bal(p.tok, bob.address);
      await mockRouter.connect(bob).zapBuy(p.key, 1, 1, to, DL(), { value: E(0.2) });
      expect(await bal(p.tok, to)).to.be.gt(0n);
      expect(await bal(p.tok, bob.address)).to.equal(t0);
    });
    it("STAG sitting in the router is never swept into a caller's zapSell proceeds", async () => {
      const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [await mockRouter.getAddress(), 0]));
      await network.provider.send("hardhat_setStorageAt", [STAG, slot, ethers.toBeHex(E(5000), 32)]);   // donate 5,000 STAG to the router
      const erc = new ethers.Contract(STAG, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
      await mockRouter.connect(bob).zapSell(p.key, E(100_000), 1, ethers.Wallet.createRandom().address, DL());
      expect(await erc.balanceOf(await mockRouter.getAddress())).to.equal(E(5000));                       // untouched
      await network.provider.send("hardhat_setStorageAt", [STAG, slot, ethers.toBeHex(0, 32)]);
    });
    it("the router enforces minEth itself even when the curve does not (a curve that ignores minQuoteOut)", async () => {
      await mock.setLoose(true);
      await expect(mockRouter.connect(bob).zapSell(p.key, E(100_000), E(1_000_000), ethers.Wallet.createRandom().address, DL())).to.be.revertedWithCustomError(mockRouter, "Slippage");
      await mock.setLoose(false);
    });
    it("zapBuy measures the STAG it really received: a lying curve and STAG already in the router change nothing", async () => {
      const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [await mockRouter.getAddress(), 0]));
      await network.provider.send("hardhat_setStorageAt", [STAG, slot, ethers.toBeHex(E(777), 32)]);      // 777 STAG already sitting in the router
      await mock.set(0, true, false);                                                                       // the curve returns a doubled number
      const erc = new ethers.Contract(STAG, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
      const to = ethers.Wallet.createRandom().address;
      const [stagIn, out] = await mockRouter.connect(bob).zapBuy.staticCall(p.key, 1, 1, to, DL(), { value: E(1) });
      expect(stagIn).to.equal(E(1) * 1000n);                                                                // the real STAG from 1 ETH at the mock's rate, not 2x and not 777 more
      await mockRouter.connect(bob).zapBuy(p.key, 1, 1, to, DL(), { value: E(1) });
      expect(await bal(p.tok, to)).to.equal(out);                                                           // the returned `out` is what really arrived
      expect(await erc.balanceOf(await mockRouter.getAddress())).to.equal(E(777));                          // the donation was never touched
      await mock.set(0, false, false);
      await network.provider.send("hardhat_setStorageAt", [STAG, slot, ethers.toBeHex(0, 32)]);
    });
    it("zapBuy enforces minOut on the pool leg, separately from the curve's minStag", async () => {
      await expect(mockRouter.connect(bob).zapBuy(p.key, 1, E(1_000_000_000_000), bob.address, DL(), { value: E(1) })).to.be.revertedWithCustomError(mockRouter, "Slippage");
    });
    it("the values the router returns are what really moved (swapExactIn, zapBuy, zapSell)", async () => {
      const a = E(50), t0 = await bal(p.tok, bob.address);
      const out = await router.connect(bob).swapExactIn.staticCall(p.key, p.quoteIs0, a, 1, bob.address, DL());
      await router.connect(bob).swapExactIn(p.key, p.quoteIs0, a, 1, bob.address, DL());
      expect((await bal(p.tok, bob.address)) - t0).to.equal(out);
      const to = ethers.Wallet.createRandom().address, e0 = await ethers.provider.getBalance(to);
      const [stagMid, ethOut] = await mockRouter.connect(bob).zapSell.staticCall(p.key, E(100_000), 1, to, DL());
      await mockRouter.connect(bob).zapSell(p.key, E(100_000), 1, to, DL());
      expect((await ethers.provider.getBalance(to)) - e0).to.equal(ethOut);
      expect(stagMid / 1000n).to.equal(ethOut);                                                             // mock: wei out = STAG / rate
    });
    it("zapBuy refunds unspent ETH to the caller (not to `to`) while the tokens go to `to`", async () => {
      await mock.set(5000, false, false);
      const to = ethers.Wallet.createRandom().address, e0 = await ethers.provider.getBalance(bob.address);
      const tx = await mockRouter.connect(bob).zapBuy(p.key, 1, 1, to, DL(), { value: E(2) });
      const rc = await tx.wait();
      expect(e0 - (await ethers.provider.getBalance(bob.address)) - rc.gasUsed * rc.gasPrice).to.equal(E(1));   // caller keeps the refund
      expect(await ethers.provider.getBalance(to)).to.equal(0n);                                             // `to` got no ETH
      expect(await bal(p.tok, to)).to.be.gt(0n);
      await mock.set(0, false, false);
    });
    it("a sell larger than the pool can absorb reverts cleanly and moves nothing", async () => {
      const q = await api.launch(alice, true, E(10_000_000), "Big Sell", "BGS");                            // fresh pool, kept out of the shared solvency list
      await q.tok.connect(bob).approve(await router.getAddress(), ethers.MaxUint256);
      const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [bob.address, 0]));
      await network.provider.send("hardhat_setStorageAt", [await q.tok.getAddress(), slot, ethers.toBeHex(10n ** 30n, 32)]);
      const t0 = await bal(q.tok, bob.address), r0 = await bal(q.tok, await router.getAddress());
      await expect(router.connect(bob).swapExactIn(q.key, !q.quoteIs0, 10n ** 29n, 1, bob.address, DL())).to.be.reverted;   // the hook backstops it first; the router's own PartialFill check is defence in depth
      expect(await bal(q.tok, bob.address)).to.equal(t0);
      expect(await bal(q.tok, await router.getAddress())).to.equal(r0);
    });
    it("swapExactIn sends the output to `to`, not to the caller", async () => {
      const to = ethers.Wallet.createRandom().address, t0 = await bal(p.tok, bob.address);
      await router.connect(bob).swapExactIn(p.key, p.quoteIs0, E(20), 1, to, DL());
      expect(await bal(p.tok, to)).to.be.gt(0n);
      expect(await bal(p.tok, bob.address)).to.equal(t0);
    });
    it("the lock releases between two router calls inside ONE transaction", async () => {
      const C = await (await ethers.getContractFactory("CallTwice")).deploy(await router.getAddress());
      const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [await C.getAddress(), 0]));
      await network.provider.send("hardhat_setStorageAt", [STAG, slot, ethers.toBeHex(E(1000), 32)]);
      await C.twice(p.key, p.quoteIs0, STAG, E(100));
      expect(await bal(p.tok, await C.getAddress())).to.be.gt(0n);
    });
    it("a dust sell that would pay out nothing reverts even with minOut = 0 (no free zero-output trades)", async () => {
      await expect(router.connect(bob).swapExactIn(p.key, !p.quoteIs0, 5n, 0, bob.address, DL())).to.be.revertedWithCustomError(router, "Slippage");
    });
  });
});
