const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const WEEK = 7 * 24 * 3600;

describe("SherwoodPact", function () {
  async function deploy() {
    const [owner, oracle, alice, bob] = await ethers.getSigners();
    const Pact = await ethers.getContractFactory("SherwoodPact");
    const pact = await Pact.deploy(ethers.ZeroAddress, E("0.01"), E("0.005")); // entry .01, refund .005
    await pact.setOracle(oracle.address);
    return { owner, oracle, alice, bob, pact };
  }

  it("opens a pact on paying the entry fee", async () => {
    const { pact, alice } = await loadFixture(deploy);
    await expect(pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.005") })).to.be.revertedWith("entry fee too low");
    await expect(pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") })).to.emit(pact, "PactCreated");
    expect(await pact.pactCount()).to.equal(1);
  });

  it("cannot verify before the hold window ends", async () => {
    const { pact, oracle, alice } = await loadFixture(deploy);
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    await expect(pact.connect(oracle).verify(0, true, 0)).to.be.revertedWith("window not ended");
  });

  it("held → refund + reward payable, and claimable by the holder", async () => {
    const { owner, pact, oracle, alice } = await loadFixture(deploy);
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    await pact.connect(owner).fund({ value: E("0.02") }); // fund rewards treasury
    await time.increase(WEEK + 1);
    await pact.connect(oracle).verify(0, true, E("0.01")); // reward 0.01
    // reserved = refund .005 + reward .01 = .015
    expect(await pact.reservedPayouts()).to.equal(E("0.015"));
    const b0 = await ethers.provider.getBalance(alice.address);
    const tx = await pact.connect(alice).claim(0);
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    expect((await ethers.provider.getBalance(alice.address)) - b0 + gas).to.equal(E("0.015"));
    expect(await pact.reservedPayouts()).to.equal(0n);
  });

  it("not held → forfeited, entry stays as backend funds", async () => {
    const { pact, oracle, alice } = await loadFixture(deploy);
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    await time.increase(WEEK + 1);
    await pact.connect(oracle).verify(0, false, 0);
    await expect(pact.connect(alice).claim(0)).to.be.revertedWith("not claimable");
    expect(await pact.freeTreasury()).to.equal(E("0.01")); // entry kept
  });

  it("verify reverts if treasury can't cover the payout", async () => {
    const { owner, pact, oracle, alice } = await loadFixture(deploy);
    await pact.connect(owner).setMaxReward(E("100")); // lift the cap so we hit the treasury check
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    await time.increase(WEEK + 1);
    // reward 1 ETH but treasury only has the 0.01 escrowed entry
    await expect(pact.connect(oracle).verify(0, true, E("1"))).to.be.revertedWith("treasury underfunded");
  });

  it("caps the oracle-supplied reward at maxReward", async () => {
    const { owner, pact, oracle, alice } = await loadFixture(deploy);
    await pact.connect(owner).fund({ value: E("100") });
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    await time.increase(WEEK + 1);
    // default maxReward = entryFee*10 = 0.1
    await expect(pact.connect(oracle).verify(0, true, E("0.2"))).to.be.revertedWith("reward > cap");
    await expect(pact.connect(oracle).verify(0, true, E("0.05"))).to.emit(pact, "PactVerified");
  });

  it("holder can reclaim the full entry if the oracle never resolves", async () => {
    const { pact, alice } = await loadFixture(deploy);
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    await expect(pact.connect(alice).reclaim(0)).to.be.revertedWith("not reclaimable yet");
    await time.increase(WEEK + 14 * 24 * 3600 + 1); // window + grace
    const b0 = await ethers.provider.getBalance(alice.address);
    const tx = await pact.connect(alice).reclaim(0);
    const rc = await tx.wait();
    expect((await ethers.provider.getBalance(alice.address)) - b0 + rc.gasUsed * rc.gasPrice).to.equal(E("0.01"));
    expect(await pact.reservedEntries()).to.equal(0n);
    expect(await pact.freeTreasury()).to.equal(0n);
  });

  it("escrowed entries are not withdrawable by the owner", async () => {
    const { owner, pact, alice } = await loadFixture(deploy);
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    expect(await pact.freeTreasury()).to.equal(0n); // the entry is escrowed
    await expect(pact.connect(owner).withdrawTreasury(owner.address, E("0.01"))).to.be.revertedWith("exceeds free treasury");
  });

  it("refunds overpayment on createPact", async () => {
    const { pact, alice } = await loadFixture(deploy);
    const b0 = await ethers.provider.getBalance(alice.address);
    const tx = await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.05") }); // overpay by 0.04
    const rc = await tx.wait();
    expect(b0 - (await ethers.provider.getBalance(alice.address)) - rc.gasUsed * rc.gasPrice).to.equal(E("0.01")); // only entryFee spent
  });

  it("owner cannot withdraw ETH reserved for a verified payout", async () => {
    const { owner, pact, oracle, alice } = await loadFixture(deploy);
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    await pact.connect(owner).fund({ value: E("0.02") });
    await time.increase(WEEK + 1);
    await pact.connect(oracle).verify(0, true, E("0.01")); // reserves 0.015 of the 0.03 balance
    expect(await pact.freeTreasury()).to.equal(E("0.015"));
    await expect(pact.connect(owner).withdrawTreasury(owner.address, E("0.02"))).to.be.revertedWith("exceeds free treasury");
    await expect(pact.connect(owner).withdrawTreasury(owner.address, E("0.015"))).to.not.be.reverted;
  });

  it("only the holder can claim, only oracle/owner can verify", async () => {
    const { pact, alice, bob, oracle } = await loadFixture(deploy);
    await pact.connect(alice).createPact(E("1000000"), WEEK, { value: E("0.01") });
    await time.increase(WEEK + 1);
    await expect(pact.connect(bob).verify(0, true, 0)).to.be.revertedWith("not oracle");
    await pact.connect(oracle).verify(0, true, 0);
    await expect(pact.connect(bob).claim(0)).to.be.revertedWith("not your pact");
  });
});
