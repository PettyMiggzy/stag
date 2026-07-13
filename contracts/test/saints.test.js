const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const BASE = "https://stagwifhood.fun/assets/nft/saints/metadata/";

async function deploy() {
  const [owner, burnSink, pool, team, alice, bob] = await ethers.getSigners();
  const saints = await (await ethers.getContractFactory("SherwoodSaints"))
    .deploy(BASE, owner.address, 500); // 5% royalty
  const splitter = await (await ethers.getContractFactory("SaintsSplitter"))
    .deploy(burnSink.address, pool.address, team.address, 6000, 3000); // 60/30/10
  await saints.setSplitter(await splitter.getAddress());
  await saints.setMintActive(true);
  return { owner, burnSink, pool, team, alice, bob, saints, splitter };
}

describe("SherwoodSaints — 5-piece 1/1 mint", () => {
  it("mints a picked Saint at 0.03 ETH and exposes metadata", async () => {
    const { saints, alice } = await deploy();
    expect(await saints.mintPrice()).to.equal(E("0.03"));
    await saints.connect(alice).mintPick(3, { value: E("0.03") });
    expect(await saints.ownerOf(3)).to.equal(alice.address);
    expect(await saints.tokenURI(3)).to.equal(BASE + "3");
    expect(await saints.isAvailable(3)).to.equal(false);
    expect(await saints.totalSupply()).to.equal(1n);
  });

  it("rejects wrong price, unavailable ids, and re-mint", async () => {
    const { saints, alice, bob } = await deploy();
    await expect(saints.connect(alice).mintPick(1, { value: E("0.02") })).to.be.revertedWith("wrong price");
    await expect(saints.connect(alice).mintPick(0, { value: E("0.03") })).to.be.revertedWith("unavailable");
    await expect(saints.connect(alice).mintPick(6, { value: E("0.03") })).to.be.revertedWith("unavailable");
    await saints.connect(alice).mintPick(1, { value: E("0.03") });
    await expect(saints.connect(bob).mintPick(1, { value: E("0.03") })).to.be.revertedWith("unavailable");
  });

  it("enforces the per-wallet cap but free mints bypass it", async () => {
    const { saints, owner, alice } = await deploy();
    await saints.connect(alice).mintPick(1, { value: E("0.03") });
    await saints.connect(alice).mintPick(2, { value: E("0.03") });
    await expect(saints.connect(alice).mintPick(3, { value: E("0.03") })).to.be.revertedWith("wallet limit");
    // grant a free mint → bypasses cap AND price
    await saints.connect(owner).grantFreeMints(alice.address, 1);
    await saints.connect(alice).mintPick(3, { value: 0 });
    expect(await saints.ownerOf(3)).to.equal(alice.address);
  });

  it("proceeds stay in the contract until forwardProceeds (scanner-safe)", async () => {
    const { saints, splitter, alice } = await deploy();
    const addr = await saints.getAddress();
    await saints.connect(alice).mintPick(1, { value: E("0.03") });
    await saints.connect(alice).mintPick(2, { value: E("0.03") });
    expect(await ethers.provider.getBalance(addr)).to.equal(E("0.06"));
    await saints.forwardProceeds();
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);
  });

  it("mintActive gate + availableIds view", async () => {
    const { saints, owner, alice } = await deploy();
    await saints.connect(owner).setMintActive(false);
    await expect(saints.connect(alice).mintPick(1, { value: E("0.03") })).to.be.revertedWith("mint not active");
    await saints.connect(owner).setMintActive(true);
    await saints.connect(alice).mintPick(1, { value: E("0.03") });
    const ids = (await saints.availableIds()).map(Number);
    expect(ids).to.deep.equal([2, 3, 4, 5]);
  });

  it("only owner can change policy; reports ERC-2981 royalty", async () => {
    const { saints, alice, owner } = await deploy();
    await expect(saints.connect(alice).setMintPrice(E("1"))).to.be.reverted;
    await expect(saints.connect(alice).setSplitter(alice.address)).to.be.reverted;
    const [receiver, amount] = await saints.royaltyInfo(1, E("1"));
    expect(receiver).to.equal(owner.address);
    expect(amount).to.equal(E("0.05")); // 5%
  });
});

describe("SaintsSplitter — 60/30/10 immutable split", () => {
  it("splits ETH exactly on arrival with no dust", async () => {
    const { splitter, burnSink, pool, team } = await deploy();
    const b0 = await ethers.provider.getBalance(burnSink.address);
    const p0 = await ethers.provider.getBalance(pool.address);
    const t0 = await ethers.provider.getBalance(team.address);
    const [payer] = await ethers.getSigners();
    await payer.sendTransaction({ to: await splitter.getAddress(), value: E("1") });
    expect((await ethers.provider.getBalance(burnSink.address)) - b0).to.equal(E("0.6"));
    expect((await ethers.provider.getBalance(pool.address)) - p0).to.equal(E("0.3"));
    expect((await ethers.provider.getBalance(team.address)) - t0).to.equal(E("0.1"));
    expect(await ethers.provider.getBalance(await splitter.getAddress())).to.equal(0n); // nothing pools
  });

  it("full mint → forward → split lands exactly (0.03 → 0.018/0.009/0.003)", async () => {
    const { saints, splitter, burnSink, pool, team, alice } = await deploy();
    const b0 = await ethers.provider.getBalance(burnSink.address);
    const p0 = await ethers.provider.getBalance(pool.address);
    const t0 = await ethers.provider.getBalance(team.address);
    await saints.connect(alice).mintPick(1, { value: E("0.03") });
    await saints.forwardProceeds();
    expect((await ethers.provider.getBalance(burnSink.address)) - b0).to.equal(E("0.018"));
    expect((await ethers.provider.getBalance(pool.address)) - p0).to.equal(E("0.009"));
    expect((await ethers.provider.getBalance(team.address)) - t0).to.equal(E("0.003"));
  });

  it("rejects a bad split config (>100%)", async () => {
    const [_, burnSink, pool, team] = await ethers.getSigners();
    const F = await ethers.getContractFactory("SaintsSplitter");
    await expect(F.deploy(burnSink.address, pool.address, team.address, 7000, 4000)).to.be.revertedWith("bps > 100%");
    await expect(F.deploy(ethers.ZeroAddress, pool.address, team.address, 6000, 3000)).to.be.revertedWith("zero addr");
  });
});
