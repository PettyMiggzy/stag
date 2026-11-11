const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const DAY = 86400;

describe("RecordStake", function () {
  async function deploy() {
    const [owner, alice, bob, eve] = await ethers.getSigners();
    const stag = await (await ethers.getContractFactory("MockERC20")).deploy();
    const rs = await (await ethers.getContractFactory("RecordStake")).deploy(await stag.getAddress(), owner.address);
    for (const u of [alice, bob, eve]) { await stag.mint(u.address, E(1_000_000)); await stag.connect(u).approve(await rs.getAddress(), ethers.MaxUint256); }
    await rs.setRecord(10, true);
    return { owner, alice, bob, eve, stag, rs };
  }

  it("stakes on an open record only, and tracks totals and staker counts", async () => {
    const { alice, bob, rs, stag } = await loadFixture(deploy);
    await expect(rs.connect(alice).stake(11, E(100))).to.be.revertedWithCustomError(rs, "RecordClosed");
    await expect(rs.connect(alice).stake(10, 0)).to.be.revertedWithCustomError(rs, "ZeroAmount");
    await rs.connect(alice).stake(10, E(100)); await rs.connect(bob).stake(10, E(50)); await rs.connect(alice).stake(10, E(25));
    expect(await rs.recordTotal(10)).to.equal(E(175)); expect(await rs.recordStakers(10)).to.equal(2n); expect(await rs.totalStaked()).to.equal(E(175));
    expect(await stag.balanceOf(await rs.getAddress())).to.equal(E(175));
    expect((await rs.positions(alice.address, 10)).amount).to.equal(E(125));
  });

  it("gives everything back at any time, with no fee, even after the record is closed", async () => {
    const { owner, alice, rs, stag } = await loadFixture(deploy);
    await rs.connect(alice).stake(10, E(1000)); await rs.connect(owner).setRecord(10, false);
    await expect(rs.connect(alice).stake(10, E(1))).to.be.revertedWithCustomError(rs, "RecordClosed");
    await rs.connect(alice).unstake(10, E(400)); await rs.connect(alice).unstake(10, E(600));
    expect(await stag.balanceOf(alice.address)).to.equal(E(1_000_000)); expect(await rs.recordStakers(10)).to.equal(0n); expect(await rs.totalStaked()).to.equal(0n);
    await expect(rs.connect(alice).unstake(10, 1)).to.be.revertedWithCustomError(rs, "TooMuch");
  });

  it("nobody can take out more than they put in, or someone else's stake", async () => {
    const { alice, eve, rs } = await loadFixture(deploy);
    await rs.connect(alice).stake(10, E(1000));
    await expect(rs.connect(eve).unstake(10, E(1))).to.be.revertedWithCustomError(rs, "TooMuch");
    await expect(rs.connect(alice).unstake(10, E(1001))).to.be.revertedWithCustomError(rs, "TooMuch");
    await expect(rs.connect(alice).unstake(10, 0)).to.be.revertedWithCustomError(rs, "ZeroAmount");
  });

  it("points grow with time, survive a top-up as a weighted average, and reset on any unstake", async () => {
    const { alice, rs } = await loadFixture(deploy);
    await rs.connect(alice).stake(10, E(1000)); await time.increase(10 * DAY);
    expect(await rs.points(alice.address, 10)).to.be.closeTo(10_000n, 2n);
    await rs.connect(alice).stake(10, E(1000)); // 2000 tokens, average age about 5 days
    expect(await rs.points(alice.address, 10)).to.be.closeTo(10_000n, 3n);
    await time.increase(5 * DAY); expect(await rs.points(alice.address, 10)).to.be.closeTo(20_000n, 3n);
    await rs.connect(alice).unstake(10, E(1)); expect(await rs.points(alice.address, 10)).to.equal(0n);
    await time.increase(DAY); expect(await rs.points(alice.address, 10)).to.be.closeTo(1999n, 1n);
  });

  it("the owner cannot take staked tokens, only spare ones sent by mistake", async () => {
    const { owner, alice, eve, rs, stag } = await loadFixture(deploy);
    await rs.connect(alice).stake(10, E(1000));
    await expect(rs.connect(owner).rescue(await stag.getAddress(), owner.address, 1)).to.be.revertedWithCustomError(rs, "NotSpare");
    await stag.connect(eve).transfer(await rs.getAddress(), E(7)); // a mistaken direct transfer
    await expect(rs.connect(owner).rescue(await stag.getAddress(), owner.address, E(8))).to.be.revertedWithCustomError(rs, "NotSpare");
    await rs.connect(owner).rescue(await stag.getAddress(), eve.address, E(7));
    await rs.connect(alice).unstake(10, E(1000)); expect(await stag.balanceOf(alice.address)).to.equal(E(1_000_000));
    await expect(rs.connect(eve).rescue(await stag.getAddress(), eve.address, 1)).to.be.revertedWithCustomError(rs, "OwnableUnauthorizedAccount");
    await expect(rs.connect(eve).setRecord(12, true)).to.be.revertedWithCustomError(rs, "OwnableUnauthorizedAccount");
  });

  it("a token that takes a cut on transfer cannot leave the contract short", async () => {
    const [owner, alice] = await ethers.getSigners();
    const fee = await (await ethers.getContractFactory("MockFeeToken")).deploy(500);
    const rs = await (await ethers.getContractFactory("RecordStake")).deploy(await fee.getAddress(), owner.address);
    await fee.mint(alice.address, E(1000)); await fee.connect(alice).approve(await rs.getAddress(), ethers.MaxUint256); await rs.setRecord(1, true);
    await rs.connect(alice).stake(1, E(1000));
    const got = (await rs.positions(alice.address, 1)).amount; expect(got).to.equal(await fee.balanceOf(await rs.getAddress())); expect(await rs.totalStaked()).to.equal(got);
    await rs.connect(alice).unstake(1, got); expect(await rs.totalStaked()).to.equal(0n);
  });
});
