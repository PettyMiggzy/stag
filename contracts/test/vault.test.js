const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const W = E("10000"); // weight per NFT

async function deploy() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const vault = await (await ethers.getContractFactory("SherwoodVault")).deploy(owner.address);
  const nft = await (await ethers.getContractFactory("MockNFT")).deploy();       // custody
  const lockNft = await (await ethers.getContractFactory("MockLockableNFT")).deploy(); // lock-in-place
  await lockNft.setLocker(await vault.getAddress());
  return { owner, alice, bob, carol, vault, nft, lockNft };
}

describe("SherwoodVault — collection-agnostic NFT staking", () => {
  it("owner registers collections; non-owner cannot", async () => {
    const { vault, nft, alice } = await deploy();
    await expect(vault.connect(alice).addCollection(await nft.getAddress(), W, false)).to.be.reverted;
    await vault.addCollection(await nft.getAddress(), W, false);
    const c = await vault.collections(await nft.getAddress());
    expect(c.enabled).to.equal(true); expect(c.weight).to.equal(W);
    expect(await vault.collectionsCount()).to.equal(1n);
  });

  it("CUSTODY stake: NFT moves into vault, weight added, enumerable; unstake returns it", async () => {
    const { vault, nft, alice } = await deploy();
    const V = await vault.getAddress(), NA = await nft.getAddress();
    await vault.addCollection(NA, W, false);
    await nft.mint(alice.address, 1);
    await nft.connect(alice).approve(V, 1);
    await vault.connect(alice).stake(NA, 1);
    expect(await nft.ownerOf(1)).to.equal(V);           // custody
    expect(await vault.weightOf(alice.address)).to.equal(W);
    expect(await vault.totalWeight()).to.equal(W);
    const list = await vault.stakedByUser(alice.address);
    expect(list.length).to.equal(1); expect(Number(list[0].tokenId)).to.equal(1);
    await vault.connect(alice).unstake(NA, 1);
    expect(await nft.ownerOf(1)).to.equal(alice.address); // returned
    expect(await vault.weightOf(alice.address)).to.equal(0n);
    expect(await vault.stakedCountOf(alice.address)).to.equal(0n);
  });

  it("LOCK-IN-PLACE stake: NFT stays in wallet but is locked; unstake unlocks it", async () => {
    const { vault, lockNft, alice, bob } = await deploy();
    const NA = await lockNft.getAddress();
    await vault.addCollection(NA, W, true);
    await lockNft.mint(alice.address, 7);
    await vault.connect(alice).stake(NA, 7);
    expect(await lockNft.ownerOf(7)).to.equal(alice.address); // never leaves wallet
    expect(await lockNft.locked(7)).to.equal(true);
    await expect(lockNft.connect(alice).transferFrom(alice.address, bob.address, 7)).to.be.revertedWith("locked");
    await vault.connect(alice).unstake(NA, 7);
    expect(await lockNft.locked(7)).to.equal(false);
    await lockNft.connect(alice).transferFrom(alice.address, bob.address, 7); // now transferable
    expect(await lockNft.ownerOf(7)).to.equal(bob.address);
  });

  it("guards: disabled collection, not-owner, double-stake, unstake-not-yours", async () => {
    const { vault, nft, alice, bob } = await deploy();
    const V = await vault.getAddress(), NA = await nft.getAddress();
    await nft.mint(alice.address, 1);
    await nft.connect(alice).approve(V, 1);
    await expect(vault.connect(alice).stake(NA, 1)).to.be.revertedWith("collection not enabled");
    await vault.addCollection(NA, W, false);
    await nft.mint(bob.address, 2);
    await expect(vault.connect(alice).stake(NA, 2)).to.be.revertedWith("not owner");
    await vault.connect(alice).stake(NA, 1);
    await expect(vault.connect(alice).stake(NA, 1)).to.be.revertedWith("already staked");
    await expect(vault.connect(bob).unstake(NA, 1)).to.be.revertedWith("not staker");
  });

  it("stray safeTransferFrom to the vault reverts (no stranding)", async () => {
    const { vault, nft, alice } = await deploy();
    const V = await vault.getAddress(), NA = await nft.getAddress();
    await nft.mint(alice.address, 1);
    await expect(
      nft.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, V, 1)
    ).to.be.reverted; // vault does not implement IERC721Receiver
  });

  it("ETH rewards stream by weight; two stakers split proportionally; claim pays out", async () => {
    const { vault, nft, owner, alice, bob } = await deploy();
    const V = await vault.getAddress(), NA = await nft.getAddress();
    await vault.addCollection(NA, W, false);
    // alice stakes 1 NFT (weight W), bob stakes 3 (weight 3W) → 25% / 75%
    await nft.mint(alice.address, 1); await nft.connect(alice).approve(V, 1); await vault.connect(alice).stake(NA, 1);
    for (const id of [2, 3, 4]) { await nft.mint(bob.address, id); await nft.connect(bob).approve(V, id); await vault.connect(bob).stake(NA, id); }
    // fund + stream 4 ETH over 100s
    await vault.donate({ value: E("4") });
    await vault.notifyRewardAmount(E("4"), 100);
    await ethers.provider.send("evm_increaseTime", [100]); await ethers.provider.send("evm_mine", []);
    const aE = await vault.earned(alice.address), bE = await vault.earned(bob.address);
    // alice ~1 ETH, bob ~3 ETH (allow 1 wei/sec rounding)
    expect(aE).to.be.closeTo(E("1"), E("0.001"));
    expect(bE).to.be.closeTo(E("3"), E("0.001"));
    const before = await ethers.provider.getBalance(bob.address);
    const tx = await vault.connect(bob).claim(); const rc = await tx.wait();
    const after = await ethers.provider.getBalance(bob.address);
    expect(after - before + rc.gasUsed * rc.gasPrice).to.be.closeTo(E("3"), E("0.001"));
  });

  it("weight change applies to FUTURE stakes only; existing keep their snapshot", async () => {
    const { vault, nft, alice } = await deploy();
    const V = await vault.getAddress(), NA = await nft.getAddress();
    await vault.addCollection(NA, W, false);
    await nft.mint(alice.address, 1); await nft.connect(alice).approve(V, 1); await vault.connect(alice).stake(NA, 1);
    await vault.addCollection(NA, W * 2n, false); // bump weight
    await nft.mint(alice.address, 2); await nft.connect(alice).approve(V, 2); await vault.connect(alice).stake(NA, 2);
    // token1 keeps W, token2 gets 2W → total 3W
    expect(await vault.weightOf(alice.address)).to.equal(W * 3n);
    expect((await vault.stakeOf(NA, 1)).weight).to.equal(W);
    expect((await vault.stakeOf(NA, 2)).weight).to.equal(W * 2n);
  });
});
