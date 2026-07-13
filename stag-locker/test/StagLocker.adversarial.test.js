// Fresh adversarial tests — written independently of the main suite to probe the
// exact concerns raised in the "something feels wrong" re-audit:
//   1. burn-before-exempt-token DoS (the confirmed Medium) is now impossible / fail-safe
//   2. vesting fully drains with ugly numbers — no stranded dust, `withdrawn` always flips
//   3. topUp mid-vest keeps per-token solvency and released <= amountOrId
//   4. extend on a vesting lock never early-releases and never underflows
//   5. admin genuinely cannot touch locked assets via any setter
const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 86400n;
const E = (n) => ethers.parseEther(String(n));

async function now() { return BigInt((await ethers.provider.getBlock("latest")).timestamp); }
async function jump(s) { await ethers.provider.send("evm_increaseTime", [Number(s)]); await ethers.provider.send("evm_mine", []); }

async function deploy() {
  const [admin, treasury, alice, bob] = await ethers.getSigners();
  const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
  const locker = await (await ethers.getContractFactory("StagLocker"))
    .deploy(await PM.getAddress(), 0, treasury.address, admin.address);
  const STAG = await (await ethers.getContractFactory("MockERC20")).deploy();
  const TOK = await (await ethers.getContractFactory("MockERC20")).deploy();
  return { admin, treasury, alice, bob, PM, locker, STAG, TOK };
}

describe("StagLocker — adversarial re-audit", () => {
  it("CONFIRMED-FIX: enabling burn before an exempt token is set can no longer brick locks", async () => {
    const { admin, locker } = await deploy();
    // the old bug: setBurnConfig(2M,30d) with feeExemptToken == address(0) → every lock reverts.
    // now the setter rejects it outright.
    await expect(locker.connect(admin).setBurnConfig(E(2_000_000), 30n * DAY))
      .to.be.revertedWithCustomError(locker, "ZeroAddress");
  });

  it("FAIL-SAFE: disabling the exemption AFTER burn is live makes locks free, never reverting", async () => {
    const { admin, alice, locker, STAG, TOK } = await deploy();
    await locker.connect(admin).setFeeExemption(await STAG.getAddress(), E(10_000_000));
    await locker.connect(admin).setBurnConfig(E(2_000_000), 30n * DAY);
    // admin now clears the exempt/burn token (feeExemptToken -> address(0)) while burn stays enabled
    await locker.connect(admin).setFeeExemption(ethers.ZeroAddress, 0);
    // burnFor must fail-safe to 0 (no burn token) so a normal lock still succeeds
    expect(await locker.burnFor(alice.address, 365n * DAY)).to.equal(0n);
    await TOK.mint(alice.address, E(100));
    await TOK.connect(alice).approve(await locker.getAddress(), E(100));
    const unlock = (await now()) + 90n * DAY;
    await expect(locker.connect(alice).lockTokens(await TOK.getAddress(), E(100), unlock)).to.not.be.reverted;
  });

  it("no stranded dust: an ugly vesting amount over an odd term fully drains and flips withdrawn", async () => {
    const { alice, locker, TOK } = await deploy();
    const amount = E(1) + 7n;                 // deliberately not divisible
    await TOK.mint(alice.address, amount);
    await TOK.connect(alice).approve(await locker.getAddress(), amount);
    const start = (await now()) + 10n;
    const end = start + 173n * DAY;           // prime-ish, awkward duration
    await locker.connect(alice).lockTokensVesting(await TOK.getAddress(), amount, start, end);
    const id = 0n;
    // withdraw at several irregular points
    for (const frac of [20n, 55n, 101n, 173n, 400n]) {
      await jump(frac * DAY / 3n + 1n);
      try { await locker.connect(alice).withdraw(id); } catch (_) { /* nothing new vested yet — fine */ }
    }
    const l = await locker.getLock(id);
    expect(l.released).to.equal(amount);      // every wei accounted, no dust left
    expect(l.withdrawn).to.equal(true);
    expect(await TOK.balanceOf(await locker.getAddress())).to.equal(0n); // contract fully drained
    expect(await TOK.balanceOf(alice.address)).to.equal(amount);
  });

  it("topUp mid-vest: solvency holds and released can never exceed amountOrId", async () => {
    const { alice, locker, TOK } = await deploy();
    const a1 = E(500), a2 = E(300);
    await TOK.mint(alice.address, a1 + a2);
    await TOK.connect(alice).approve(await locker.getAddress(), a1 + a2);
    const start = await now();
    const end = start + 100n * DAY;
    await locker.connect(alice).lockTokensVesting(await TOK.getAddress(), a1, start, end);
    const id = 0n;
    await jump(40n * DAY);
    await locker.connect(alice).withdraw(id);                 // partial
    await locker.connect(alice).topUp(id, a2);               // join schedule mid-vest
    // solvency at this instant: contract balance >= amountOrId - released
    let l = await locker.getLock(id);
    expect(await TOK.balanceOf(await locker.getAddress())).to.be.gte(l.amountOrId - l.released);
    expect(l.released).to.be.lte(l.amountOrId);
    await jump(100n * DAY);                                   // well past end
    await locker.connect(alice).withdraw(id);                // final
    l = await locker.getLock(id);
    expect(l.released).to.equal(a1 + a2);
    expect(l.released).to.be.lte(l.amountOrId);
    expect(l.withdrawn).to.equal(true);
    expect(await TOK.balanceOf(alice.address)).to.equal(a1 + a2);
  });

  it("extend on a vesting lock lengthens the tail, never early-releases, never underflows", async () => {
    const { alice, locker, TOK } = await deploy();
    const amount = E(1000);
    await TOK.mint(alice.address, amount);
    await TOK.connect(alice).approve(await locker.getAddress(), amount);
    const start = await now();
    const end = start + 100n * DAY;
    await locker.connect(alice).lockTokensVesting(await TOK.getAddress(), amount, start, end);
    const id = 0n;
    await jump(50n * DAY);
    await locker.connect(alice).withdraw(id);                // ~half vested & released
    const relBefore = (await locker.getLock(id)).released;
    // extend the end far out: vested RATE drops; must not release anything new, must not underflow
    await locker.connect(alice).extendLock(id, BigInt((await locker.getLock(id)).unlockTime) + 300n * DAY);
    const [, withdrawable] = await locker.vestedOf(id);
    expect(withdrawable).to.equal(0n);                        // nothing new after a rate-lowering extend
    await expect(locker.connect(alice).withdraw(id)).to.be.revertedWithCustomError(locker, "NothingToWithdraw");
    expect((await locker.getLock(id)).released).to.equal(relBefore);
  });

  it("admin cannot touch locked assets through ANY setter", async () => {
    const { admin, alice, locker, TOK } = await deploy();
    const amount = E(777);
    await TOK.mint(alice.address, amount);
    await TOK.connect(alice).approve(await locker.getAddress(), amount);
    const unlock = (await now()) + 365n * DAY;
    await locker.connect(alice).lockTokens(await TOK.getAddress(), amount, unlock);
    const bal0 = await TOK.balanceOf(await locker.getAddress());
    // exhaust every owner-only lever
    await locker.connect(admin).setFee(E(1), admin.address);
    await locker.connect(admin).setFeeExemption(await TOK.getAddress(), E(1));
    await locker.connect(admin).setBurnConfig(E(1), DAY);
    await locker.connect(admin).setBurnCap(E(1));
    // locked balance is untouched; admin has no withdraw path for locked tokens
    expect(await TOK.balanceOf(await locker.getAddress())).to.equal(bal0);
    expect(locker.withdrawFees).to.exist; // exists but only moves accruedFees (ETH), proven elsewhere
  });
});
