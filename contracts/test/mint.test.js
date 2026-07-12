const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
// tier of each id (from TIERS): 0=Common 1=Rare 2=Epic 3=Legendary 4=Mythic
const TIER = [4,3,0,1,1,3,2,1,2,2,1,0,2,3,0,0,1,3,2,4]; // id1..20
const idsOfTier = (t) => TIER.map((x,i)=>x===t?i+1:0).filter(Boolean);
const PRICE = ["0.010","0.015","0.020","0.025","0.030"]; // by tier

describe("HoodedTwenty + RevenueSplitter", function () {
  async function deploy() {
    const [owner, pool, backend, alice, bob] = await ethers.getSigners();
    const Splitter = await ethers.getContractFactory("RevenueSplitter");
    const splitter = await Splitter.deploy(pool.address, backend.address, 9000); // 90/10
    const Hooded = await ethers.getContractFactory("HoodedTwenty");
    const hood = await Hooded.deploy("https://stagwifhood.fun/assets/nft/stagwifhood/metadata/", await splitter.getAddress(), 500);
    await hood.setMintActive(true);
    return { owner, pool, backend, alice, bob, splitter, hood };
  }

  it("pick mode charges the tier price and rejects underpayment", async () => {
    const { hood, alice } = await loadFixture(deploy);
    const commonId = idsOfTier(0)[0]; // Common → 0.010
    await expect(hood.connect(alice).mintPick(commonId, { value: E("0.009") })).to.be.revertedWith("fee too low");
    await expect(hood.connect(alice).mintPick(commonId, { value: E("0.010") })).to.emit(hood, "Minted");
    expect(await hood.ownerOf(commonId)).to.equal(alice.address);
    expect(await hood.isAvailable(commonId)).to.equal(false);
  });

  it("pick price scales by tier and priceOf() matches", async () => {
    const { hood } = await loadFixture(deploy);
    for (let t = 0; t < 5; t++) {
      const id = idsOfTier(t)[0];
      expect(await hood.priceOf(id)).to.equal(E(PRICE[t]));
    }
  });

  it("cannot pick an already-minted token", async () => {
    const { hood, alice, bob } = await loadFixture(deploy);
    const id = idsOfTier(2)[0];
    await hood.connect(alice).mintPick(id, { value: E(PRICE[2]) });
    await expect(hood.connect(bob).mintPick(id, { value: E(PRICE[2]) })).to.be.revertedWith("unavailable");
  });

  it("enforces max per wallet", async () => {
    const { hood, alice } = await loadFixture(deploy);
    const [a,b,c] = idsOfTier(0);
    await hood.connect(alice).mintPick(a, { value: E("0.010") });
    await hood.connect(alice).mintPick(b, { value: E("0.010") });
    await expect(hood.connect(alice).mintPick(c, { value: E("0.010") })).to.be.revertedWith("wallet limit");
  });

  it("gamble mode mints unique tokens with no duplicates", async () => {
    const { hood } = await loadFixture(deploy);
    const signers = await ethers.getSigners();
    const seen = new Set();
    // 6 different wallets each gamble once (maxPerWallet=2 but keep it simple)
    for (let i = 4; i < 10; i++) {
      await hood.connect(signers[i]).mintRandom({ value: E("0.010") });
      const bal = await hood.balanceOf(signers[i].address);
      const id = await hood.tokenOfOwnerByIndex(signers[i].address, bal - 1n);
      expect(seen.has(id.toString())).to.equal(false);
      seen.add(id.toString());
    }
    expect(await hood.minted()).to.equal(6);
  });

  it("free-mint allowlist bypasses payment and decrements", async () => {
    const { hood, alice } = await loadFixture(deploy);
    await hood.grantFreeMints(alice.address, 1);
    const id = idsOfTier(4)[0]; // a Mythic, normally 0.030
    await expect(hood.connect(alice).mintPick(id, { value: 0 })).to.emit(hood, "Minted");
    expect(await hood.freeMints(alice.address)).to.equal(0);
    expect(await hood.ownerOf(id)).to.equal(alice.address);
  });

  it("forwards proceeds through the splitter 90/10", async () => {
    const { hood, pool, backend, alice } = await loadFixture(deploy);
    const p0 = await ethers.provider.getBalance(pool.address);
    const b0 = await ethers.provider.getBalance(backend.address);
    await hood.connect(alice).mintPick(idsOfTier(4)[0], { value: E("0.030") }); // Mythic 0.03
    expect(await ethers.provider.getBalance(pool.address) - p0).to.equal(E("0.027")); // 90%
    expect(await ethers.provider.getBalance(backend.address) - b0).to.equal(E("0.003")); // 10%
  });

  it("tokenURI is baseURI + id + .json", async () => {
    const { hood, alice } = await loadFixture(deploy);
    const id = idsOfTier(0)[0];
    await hood.connect(alice).mintPick(id, { value: E("0.010") });
    expect(await hood.tokenURI(id)).to.equal(`https://stagwifhood.fun/assets/nft/stagwifhood/metadata/${id}.json`);
  });

  it("lock-in-place blocks transfer while locked", async () => {
    const { hood, owner, alice, bob } = await loadFixture(deploy);
    const id = idsOfTier(0)[0];
    await hood.connect(alice).mintPick(id, { value: E("0.010") });
    await hood.setLocker(owner.address);        // pretend owner is the staking locker
    await hood.connect(owner).lock(id);
    await expect(hood.connect(alice).transferFrom(alice.address, bob.address, id)).to.be.revertedWith("locked (staked)");
    await hood.connect(owner).unlock(id);
    await hood.connect(alice).transferFrom(alice.address, bob.address, id);
    expect(await hood.ownerOf(id)).to.equal(bob.address);
  });

  it("free mints bypass the per-wallet cap", async () => {
    const { hood, alice } = await loadFixture(deploy);
    await hood.grantFreeMints(alice.address, 3); // more than maxPerWallet (2)
    const [a, b, c] = idsOfTier(0);
    await hood.connect(alice).mintPick(a, { value: 0 });
    await hood.connect(alice).mintPick(b, { value: 0 });
    await hood.connect(alice).mintPick(c, { value: 0 }); // 3rd would normally hit "wallet limit"
    expect(await hood.balanceOf(alice.address)).to.equal(3);
  });

  it("refunds overpayment on a pick", async () => {
    const { hood, alice } = await loadFixture(deploy);
    const id = idsOfTier(0)[0]; // 0.010
    const b0 = await ethers.provider.getBalance(alice.address);
    const tx = await hood.connect(alice).mintPick(id, { value: E("0.5") }); // overpay
    const rc = await tx.wait();
    expect(b0 - (await ethers.provider.getBalance(alice.address)) - rc.gasUsed * rc.gasPrice).to.equal(E("0.010"));
  });

  it("rejects setting a tier weight to zero", async () => {
    const { hood } = await loadFixture(deploy);
    await expect(hood.setTierWeight(0, 0)).to.be.revertedWith("weight=0");
  });

  it("only owner can flip settings", async () => {
    const { hood, alice } = await loadFixture(deploy);
    await expect(hood.connect(alice).setMintActive(false)).to.be.revertedWithCustomError(hood, "OwnableUnauthorizedAccount");
  });
});
