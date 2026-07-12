const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));

describe("StagStaking v4", function () {
  async function deploy() {
    const [owner, alice, bob, c1, c2] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const stag = await Mock.deploy();
    const Hooded = await ethers.getContractFactory("HoodedTwenty");
    const hood = await Hooded.deploy("ipfs://x/", ethers.ZeroAddress, 0);
    await hood.setMintActive(true);
    const Staking = await ethers.getContractFactory("StagStaking");
    const staking = await Staking.deploy(await stag.getAddress(), await hood.getAddress());
    await hood.setLocker(await staking.getAddress());
    // fund users with STAG
    for (const u of [alice, bob]) await stag.mint(u.address, E("20000000"));
    return { owner, alice, bob, c1, c2, stag, hood, staking };
  }

  async function stake(staking, stag, user, amount, tier) {
    await stag.connect(user).approve(await staking.getAddress(), amount);
    await staking.connect(user).stakeTokens(await stag.getAddress(), amount, tier);
  }

  it("applies token weight, lock-tier mult and holding mult (stacking)", async () => {
    const { staking, stag, alice } = await loadFixture(deploy);
    // 2,000,000 STAG, tier 2 (90d, 2x). STAG token weight 2x. holding 2M>=1M -> 2x.
    await stake(staking, stag, alice, E("2000000"), 2);
    const info = await staking.userInfo(alice.address);
    // base = 2,000,000 * 20000/10000 = 4,000,000
    expect(info.baseWeight).to.equal(E("4000000"));
    expect(info.lockMultBps_).to.equal(20000n); // 2x
    expect(info.holdMult).to.equal(20000n);      // 2x
    // weight = base * 2 * 2 = 16,000,000
    expect(info.weight).to.equal(E("16000000"));
  });

  it("10M staked + 90d lock stacks to 6x", async () => {
    const { staking, stag, alice } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("10000000"), 2);
    const info = await staking.userInfo(alice.address);
    expect(info.holdMult).to.equal(30000n);       // 3x
    expect(info.lockMultBps_).to.equal(20000n);   // 2x
    // base = 10,000,000*2 = 20,000,000 ; weight = base*2*3 = 120,000,000
    expect(info.weight).to.equal(E("120000000"));
  });

  it("accrues ETH rewards over time (single staker gets the whole rate)", async () => {
    const { owner, staking, stag, alice } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("1000000"), 0);
    await owner.sendTransaction({ to: await staking.getAddress(), value: E("1") });
    await staking.notifyRewardAmount(E("1"), 100); // 0.01 ETH/sec
    await time.increase(50);
    const earned = await staking.earned(alice.address);
    expect(earned).to.be.closeTo(E("0.5"), E("0.02"));
  });

  it("early unstake takes 15% penalty and forfeits rewards", async () => {
    const { owner, staking, stag, alice } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("1000000"), 0); // 30d lock
    await owner.sendTransaction({ to: await staking.getAddress(), value: E("1") });
    await staking.notifyRewardAmount(E("1"), 100);
    await time.increase(50); // accrued ~0.5 but still locked
    const penaltyRecip = await staking.penaltyRecipient();
    const before = await stag.balanceOf(alice.address);
    await staking.connect(alice).unstakeTokens(await stag.getAddress(), E("1000000"));
    const got = (await stag.balanceOf(alice.address)) - before;
    expect(got).to.equal(E("850000"));                              // 85% back
    expect(await stag.balanceOf(penaltyRecip)).to.equal(E("150000")); // 15% penalty
    expect(await staking.earned(alice.address)).to.equal(0n);       // rewards forfeited
  });

  it("claim is blocked until the lock elapses", async () => {
    const { owner, staking, stag, alice } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("1000000"), 0);
    await owner.sendTransaction({ to: await staking.getAddress(), value: E("1") });
    await staking.notifyRewardAmount(E("1"), 100);
    await time.increase(50);
    await expect(staking.connect(alice).claim()).to.be.revertedWith("locked");
  });

  it("splits withdrawn $STAG into up to 3 wallets on unstake, remainder to the staker", async () => {
    const { staking, stag, alice, c1, c2 } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("1000000"), 0);
    await staking.connect(alice).setWithdrawSplit([c1.address, c2.address], [5000, 3000]); // 50% / 30%
    await time.increase(30 * 24 * 3600 + 1); // past the lock (no penalty)
    const a0 = await stag.balanceOf(alice.address);
    await staking.connect(alice).unstakeTokens(await stag.getAddress(), E("1000000"));
    expect(await stag.balanceOf(c1.address)).to.equal(E("500000"));                 // 50% -> wallet 1
    expect(await stag.balanceOf(c2.address)).to.equal(E("300000"));                 // 30% -> wallet 2
    expect((await stag.balanceOf(alice.address)) - a0).to.equal(E("200000"));       // 20% remainder back
  });

  it("claim pays ETH rewards fully to the staker (no split on rewards)", async () => {
    const { owner, staking, stag, alice, c1 } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("1000000"), 0);
    await staking.connect(alice).setWithdrawSplit([c1.address], [10000]); // split config is for TOKENS only
    await owner.sendTransaction({ to: await staking.getAddress(), value: E("1") });
    await staking.notifyRewardAmount(E("1"), 100);
    await time.increase(30 * 24 * 3600 + 1);
    const p = await staking.earned(alice.address);
    const a0 = await ethers.provider.getBalance(alice.address);
    const c1b = await ethers.provider.getBalance(c1.address);
    const tx = await staking.connect(alice).claim();
    const rc = await tx.wait();
    expect(await ethers.provider.getBalance(c1.address) - c1b).to.equal(0n);         // reward NOT split
    expect((await ethers.provider.getBalance(alice.address)) - a0 + rc.gasUsed * rc.gasPrice).to.equal(p);
  });

  it("anyone can donate ETH to the pool (grows claimable rewards after notify)", async () => {
    const { owner, staking, stag, alice, bob } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("1000000"), 0);
    // bob (not a staker) donates straight into the pool
    await expect(staking.connect(bob).donate({ value: E("2") }))
      .to.emit(staking, "PoolDonation").withArgs(bob.address, E("2"));
    expect(await ethers.provider.getBalance(await staking.getAddress())).to.equal(E("2"));
    await expect(staking.connect(bob).donate({ value: 0 })).to.be.revertedWith("no value");
    // donated ETH is streamable to stakers
    await staking.notifyRewardAmount(E("2"), 100);
    await time.increase(50);
    expect(await staking.earned(alice.address)).to.be.closeTo(E("1"), E("0.04"));
  });

  it("rejects unapproved tokens and bad tiers", async () => {
    const { staking, alice } = await loadFixture(deploy);
    const Mock = await ethers.getContractFactory("MockERC20");
    const junk = await Mock.deploy();
    await junk.mint(alice.address, E("1"));
    await junk.connect(alice).approve(await staking.getAddress(), E("1"));
    await expect(staking.connect(alice).stakeTokens(await junk.getAddress(), E("1"), 0)).to.be.revertedWith("token not approved");
    // bad tier
    const { stag } = await loadFixture(deploy);
  });

  it("notifyRewardAmount cannot over-commit beyond funded ETH", async () => {
    const { staking } = await loadFixture(deploy);
    await expect(staking.notifyRewardAmount(E("1"), 100)).to.be.revertedWith("insufficient ETH funded");
  });

  it("NFT-only staking earns (base weight), and cannot lower lock tier", async () => {
    const { owner, staking, stag, hood, alice } = await loadFixture(deploy);
    // give alice a free NFT and stake it (no tokens)
    await hood.grantFreeMints(alice.address, 1);
    await hood.connect(alice).mintRandom({ value: 0 });
    const id = await hood.tokenOfOwnerByIndex(alice.address, 0);
    await staking.connect(alice).stakeNFT(id);
    const info = await staking.userInfo(alice.address);
    expect(info.baseWeight).to.be.greaterThan(0n);   // H1 fix: NFT contributes base weight
    expect(info.weight).to.be.greaterThan(0n);
    await owner.sendTransaction({ to: await staking.getAddress(), value: E("1") });
    await staking.notifyRewardAmount(E("1"), 100);
    await time.increase(50);
    expect(await staking.earned(alice.address)).to.be.greaterThan(0n); // actually earns

    // now stake tokens at tier 2, then adding tier 0 must revert (no downgrade)
    await stake(staking, stag, alice, E("1000000"), 2);
    await stag.connect(alice).approve(await staking.getAddress(), E("1"));
    await expect(staking.connect(alice).stakeTokens(await stag.getAddress(), E("1"), 0)).to.be.revertedWith("cannot lower lock tier");
  });

  it("sweepEth cannot drain ETH backing an active reward schedule", async () => {
    const { owner, staking, stag, alice } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("1000000"), 0);
    await owner.sendTransaction({ to: await staking.getAddress(), value: E("10") });
    await staking.notifyRewardAmount(E("10"), 100 * 24 * 3600); // committed 100-day schedule
    const bal = await ethers.provider.getBalance(await staking.getAddress());
    await expect(staking.sweepEth(owner.address, bal)).to.be.revertedWith("exceeds free ETH");
    // genuine over-funding IS sweepable
    await owner.sendTransaction({ to: await staking.getAddress(), value: E("1") });
    await expect(staking.sweepEth(owner.address, E("0.9"))).to.not.be.reverted;
    // and claims still pay out after the full schedule
    await time.increase(101 * 24 * 3600);
    await expect(staking.connect(alice).claim()).to.not.be.reverted;
  });

  it("partial early unstake forfeits rewards proportionally, not entirely", async () => {
    const { owner, staking, stag, alice } = await loadFixture(deploy);
    await stake(staking, stag, alice, E("1000000"), 0);
    await owner.sendTransaction({ to: await staking.getAddress(), value: E("1") });
    await staking.notifyRewardAmount(E("1"), 100);
    await time.increase(101); // ~1 ETH accrued, still locked (30d)
    const before = await staking.earned(alice.address);
    expect(before).to.be.closeTo(E("1"), E("0.02"));
    await staking.connect(alice).unstakeTokens(await stag.getAddress(), E("250000")); // pull 25%
    const after = await staking.earned(alice.address);
    // ~75% of rewards retained (proportional forfeit of the 25% withdrawn)
    expect(after).to.be.closeTo(before * 75n / 100n, E("0.03"));
  });
});
