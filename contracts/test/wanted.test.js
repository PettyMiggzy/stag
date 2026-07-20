const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const BASE = "https://stagwifhood.fun/assets/nft/wanted/metadata/";

// canonical tiers (matches deploy-wanted.js): Mythic 1-7, Legendary 8-11, Epic 12-16, Rare 17-21
const P_RARE = E("0.01072"), P_EPIC = E("0.01340"), P_LEGN = E("0.01608"), P_MYTH = E("0.01876");
const BOUNTY = {}; // whole $STAG
for (let i = 1; i <= 7; i++) BOUNTY[i] = 6000;
for (let i = 8; i <= 11; i++) BOUNTY[i] = 5000;
for (let i = 12; i <= 16; i++) BOUNTY[i] = 3000;
for (let i = 17; i <= 21; i++) BOUNTY[i] = 2000;
const TOTAL = Object.values(BOUNTY).reduce((a, b) => a + b, 0); // 87000

function priceOf(id) {
  if (id <= 7) return P_MYTH;
  if (id <= 11) return P_LEGN;
  if (id <= 16) return P_EPIC;
  return P_RARE;
}

async function deploy() {
  const [owner, pool, alice, bob, carol] = await ethers.getSigners();
  const wanted = await (await ethers.getContractFactory("SherwoodWanted")).deploy(BASE, owner.address, 500);
  // splitter stand-in = pool EOA (receives forwarded proceeds)
  await wanted.setSplitter(pool.address);
  // tiered prices: base = Rare, overrides for the higher tiers
  await wanted.setMintPrice(P_RARE);
  const ids = [], prices = [];
  for (let i = 1; i <= 7; i++) { ids.push(i); prices.push(P_MYTH); }
  for (let i = 8; i <= 11; i++) { ids.push(i); prices.push(P_LEGN); }
  for (let i = 12; i <= 16; i++) { ids.push(i); prices.push(P_EPIC); }
  await wanted.setTokenPrices(ids, prices);
  await wanted.setMintActive(true);

  const stag = await (await ethers.getContractFactory("MockERC20")).deploy();
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const expiry = now + 365 * 86400;
  const bounty = await (await ethers.getContractFactory("WantedBounty"))
    .deploy(await stag.getAddress(), await wanted.getAddress(), expiry);
  return { owner, pool, alice, bob, carol, wanted, stag, bounty, expiry };
}

describe("SherwoodWanted — 21-piece 1/1 tiered mint", () => {
  it("charges the correct tier price and rejects wrong price", async () => {
    const { wanted, alice } = await deploy();
    expect(await wanted.priceOf(1)).to.equal(P_MYTH);   // whale
    expect(await wanted.priceOf(8)).to.equal(P_LEGN);
    expect(await wanted.priceOf(12)).to.equal(P_EPIC);
    expect(await wanted.priceOf(21)).to.equal(P_RARE);  // falls back to flat
    await expect(wanted.connect(alice).mintPick(1, { value: P_RARE })).to.be.revertedWith("wrong price");
    await wanted.connect(alice).mintPick(1, { value: P_MYTH });
    expect(await wanted.ownerOf(1)).to.equal(alice.address);
    expect(await wanted.tokenURI(1)).to.equal(BASE + "1.json");
  });

  it("rejects unavailable ids (0, 22, already minted)", async () => {
    const { wanted, alice, bob } = await deploy();
    await expect(wanted.connect(alice).mintPick(0, { value: P_MYTH })).to.be.revertedWith("unavailable");
    await expect(wanted.connect(alice).mintPick(22, { value: P_MYTH })).to.be.revertedWith("unavailable");
    await wanted.connect(alice).mintPick(17, { value: P_RARE });
    await expect(wanted.connect(bob).mintPick(17, { value: P_RARE })).to.be.revertedWith("unavailable");
  });

  it("enforces per-wallet cap; free mints bypass cap + price", async () => {
    const { wanted, owner, alice } = await deploy();
    await wanted.connect(alice).mintPick(17, { value: P_RARE });
    await wanted.connect(alice).mintPick(18, { value: P_RARE });
    await wanted.connect(alice).mintPick(19, { value: P_RARE });
    await expect(wanted.connect(alice).mintPick(20, { value: P_RARE })).to.be.revertedWith("wallet limit");
    await wanted.connect(owner).grantFreeMints(alice.address, 1);
    await wanted.connect(alice).mintPick(1, { value: 0 }); // free even for a mythic
    expect(await wanted.ownerOf(1)).to.equal(alice.address);
  });

  it("proceeds stay in-contract until forwardProceeds (scanner-safe)", async () => {
    const { wanted, pool, alice } = await deploy();
    const wAddr = await wanted.getAddress();
    await wanted.connect(alice).mintPick(1, { value: P_MYTH });
    expect(await ethers.provider.getBalance(wAddr)).to.equal(P_MYTH);
    const before = await ethers.provider.getBalance(pool.address);
    await wanted.forwardProceeds();
    expect(await ethers.provider.getBalance(wAddr)).to.equal(0n);
    expect(await ethers.provider.getBalance(pool.address)).to.equal(before + P_MYTH);
  });

  it("availableIds shrinks as pieces mint", async () => {
    const { wanted, alice } = await deploy();
    expect((await wanted.availableIds()).length).to.equal(21);
    await wanted.connect(alice).mintPick(5, { value: P_MYTH });
    const av = (await wanted.availableIds()).map(Number);
    expect(av.length).to.equal(20);
    expect(av.includes(5)).to.equal(false);
  });
});

describe("WantedBounty — $STAG claim", () => {
  async function setup() {
    const d = await deploy();
    const { owner, wanted, stag, bounty } = d;
    // set all 21 bounties
    const ids = Object.keys(BOUNTY).map(Number);
    const amts = ids.map((i) => E(BOUNTY[i]));
    await bounty.setBounties(ids, amts);
    return d;
  }

  it("claims revert before lock", async () => {
    const { bounty, wanted, stag, owner, alice } = await setup();
    await wanted.connect(alice).mintPick(1, { value: P_MYTH });
    await stag.mint(await bounty.getAddress(), E(TOTAL));
    await expect(bounty.connect(alice).claim(1)).to.be.revertedWith("not live");
  });

  it("holder claims exactly their bounty; non-holders and double-claims revert", async () => {
    const { bounty, wanted, stag, owner, alice, bob } = await setup();
    await wanted.connect(alice).mintPick(1, { value: P_MYTH });  // 6000 bounty
    await wanted.connect(bob).mintPick(17, { value: P_RARE });   // 2000 bounty
    await stag.mint(await bounty.getAddress(), E(TOTAL));
    await bounty.lock();
    // non-holder can't claim alice's piece
    await expect(bounty.connect(bob).claim(1)).to.be.revertedWith("not holder");
    // holder claims exactly 6000
    await bounty.connect(alice).claim(1);
    expect(await stag.balanceOf(alice.address)).to.equal(E(6000));
    // double-claim reverts
    await expect(bounty.connect(alice).claim(1)).to.be.revertedWith("already claimed");
    // bob claims his 2000
    await bounty.connect(bob).claim(17);
    expect(await stag.balanceOf(bob.address)).to.equal(E(2000));
  });

  it("claimMany pays all owned, skips unowned/claimed", async () => {
    const { bounty, wanted, stag, alice } = await setup();
    await wanted.connect(alice).mintPick(1, { value: P_MYTH });   // 6000
    await wanted.connect(alice).mintPick(8, { value: P_LEGN });   // 5000
    await stag.mint(await bounty.getAddress(), E(TOTAL));
    await bounty.lock();
    await bounty.connect(alice).claimMany([1, 8]);
    expect(await stag.balanceOf(alice.address)).to.equal(E(11000));
    // re-running is a no-op (both already claimed) — no revert, no extra payout
    await bounty.connect(alice).claimMany([1, 8]);
    expect(await stag.balanceOf(alice.address)).to.equal(E(11000));
  });

  it("setBounties after lock reverts; sweep only after expiry", async () => {
    const { bounty, stag, owner, alice, expiry } = await setup();
    await stag.mint(await bounty.getAddress(), E(TOTAL)); // fund before lock (lock() now requires it)
    await bounty.lock();
    await expect(bounty.setBounties([1], [E(1)])).to.be.revertedWith("locked");
    await expect(bounty.sweep()).to.be.revertedWith("not expired");
    await ethers.provider.send("evm_setNextBlockTimestamp", [expiry + 1]);
    await ethers.provider.send("evm_mine", []);
    const before = await stag.balanceOf(owner.address);
    await bounty.sweep();
    expect(await stag.balanceOf(owner.address)).to.equal(before + E(TOTAL));
  });

  it("lock() reverts until fully funded, then succeeds (H-1 funding guard)", async () => {
    const { bounty, stag } = await setup(); // 87,000 in bounties set
    await expect(bounty.lock()).to.be.revertedWith("underfunded");
    await stag.mint(await bounty.getAddress(), E(TOTAL - 6000)); // 6,000 short (one Mythic)
    await expect(bounty.lock()).to.be.revertedWith("underfunded");
    await stag.mint(await bounty.getAddress(), E(6000)); // top up to the full total
    await bounty.lock();
    expect(await bounty.locked()).to.equal(true);
    expect(await bounty.totalBounty()).to.equal(E(TOTAL));
  });
});

describe("WantedBounty — hardening (audit fixes)", () => {
  it("constructor rejects an expiry inside the 30-day min claim window", async () => {
    const [owner] = await ethers.getSigners();
    const stag = await (await ethers.getContractFactory("MockERC20")).deploy();
    const wanted = await (await ethers.getContractFactory("SherwoodWanted")).deploy(BASE, owner.address, 500);
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const F = await ethers.getContractFactory("WantedBounty");
    await expect(F.deploy(await stag.getAddress(), await wanted.getAddress(), now + 10 * 86400))
      .to.be.revertedWith("expiry too soon");
    await (await F.deploy(await stag.getAddress(), await wanted.getAddress(), now + 31 * 86400)).waitForDeployment();
  });

  it("constructor rejects zero addresses", async () => {
    const [owner] = await ethers.getSigners();
    const stag = await (await ethers.getContractFactory("MockERC20")).deploy();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const F = await ethers.getContractFactory("WantedBounty");
    await expect(F.deploy(ethers.ZeroAddress, await stag.getAddress(), now + 365 * 86400)).to.be.revertedWith("zero addr");
    await expect(F.deploy(await stag.getAddress(), ethers.ZeroAddress, now + 365 * 86400)).to.be.revertedWith("zero addr");
  });

  it("setBounties rejects out-of-range ids and zero amounts; totalBounty tracks overwrites", async () => {
    const { bounty } = await deploy();
    await bounty.setBounties(Object.keys(BOUNTY).map(Number), Object.values(BOUNTY).map((v) => E(v)));
    await expect(bounty.setBounties([0], [E(1)])).to.be.revertedWith("bad id");
    await expect(bounty.setBounties([22], [E(1)])).to.be.revertedWith("bad id");
    await expect(bounty.setBounties([1], [0])).to.be.revertedWith("zero amount");
    // overwrite id 1 (was 6000) with 4000 → totalBounty drops by 2000
    const before = await bounty.totalBounty();
    await bounty.setBounties([1], [E(4000)]);
    expect(await bounty.totalBounty()).to.equal(before - E(2000));
  });
});

describe("WANTED — randomized invariant sim (200 rounds)", () => {
  it("total $STAG paid never exceeds funded; each holder gets exactly their bounty; no double-pay", async () => {
    const signers = await ethers.getSigners();
    const { wanted, stag, bounty, owner } = await deploy();
    const buyers = signers.slice(2, 8); // 6 buyers
    // set + fund + lock
    const ids = Object.keys(BOUNTY).map(Number);
    await bounty.setBounties(ids, ids.map((i) => E(BOUNTY[i])));
    await stag.mint(await bounty.getAddress(), E(TOTAL));
    await bounty.lock();
    await wanted.setMaxPerWallet(21);

    const holderOf = {};   // id -> buyer index
    const claimedExpected = {}; // id -> bool
    let paidTotal = 0n;
    // deterministic PRNG (no Math.random in a clean run, but fine in a test)
    let seed = 1234567;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    for (let round = 0; round < 200; round++) {
      const id = 1 + rnd(21);
      const bi = rnd(buyers.length);
      const buyer = buyers[bi];
      // MINT if available
      if (holderOf[id] === undefined) {
        await wanted.connect(buyer).mintPick(id, { value: priceOf(id) });
        holderOf[id] = bi;
      } else if (rnd(2) === 0) {
        // CLAIM attempt by a random buyer
        const claimer = buyers[rnd(buyers.length)];
        const isHolder = holderOf[id] === buyers.indexOf(claimer);
        if (isHolder && !claimedExpected[id]) {
          await bounty.connect(claimer).claim(id);
          claimedExpected[id] = true;
          paidTotal += E(BOUNTY[id]);
        } else {
          await expect(bounty.connect(claimer).claim(id)).to.be.reverted; // not holder OR already claimed
        }
      }
      // INVARIANT: contract balance == TOTAL funded - paid so far
      const bal = await stag.balanceOf(await bounty.getAddress());
      expect(bal).to.equal(E(TOTAL) - paidTotal);
    }
    // Final: every claimed holder holds exactly their bounty
    for (const id of Object.keys(claimedExpected)) {
      const holder = buyers[holderOf[id]];
      const bal = await stag.balanceOf(holder.address);
      expect(bal >= E(BOUNTY[id])).to.equal(true); // >= because a buyer may hold several
      expect(await bounty.claimed(id)).to.equal(true);
    }
    // paid can never exceed funded
    expect(paidTotal <= E(TOTAL)).to.equal(true);
  });
});

describe("WANTED — lock-in-place staking keeps the bounty claimable (vault integration, ship-blocker fix)", () => {
  async function full() {
    const d = await deploy();
    const { owner, wanted, stag, bounty } = d;
    const ids = Object.keys(BOUNTY).map(Number);
    await bounty.setBounties(ids, ids.map((i) => E(BOUNTY[i])));
    await stag.mint(await bounty.getAddress(), E(TOTAL));
    await bounty.lock();
    const vault = await (await ethers.getContractFactory("SherwoodVault")).deploy(owner.address);
    await vault.addCollection(await wanted.getAddress(), 10000n * 10n ** 18n, true); // true = LOCK-IN-PLACE
    await wanted.setLocker(await vault.getAddress());
    await wanted.setMaxPerWallet(21);
    return { ...d, vault };
  }

  it("stake → claim bounty WHILE staked → unstake; NFT never leaves the wallet", async () => {
    const { wanted, stag, bounty, vault, alice } = await full();
    const wAddr = await wanted.getAddress();
    await wanted.connect(alice).mintPick(1, { value: P_MYTH }); // id 1 = 6000 bounty
    await vault.connect(alice).stake(wAddr, 1);
    expect(await wanted.ownerOf(1)).to.equal(alice.address); // stayed in her wallet
    expect(await wanted.locked(1)).to.equal(true);
    // THE FIX: bounty still claimable while staked (ownerOf == alice)
    await bounty.connect(alice).claim(1);
    expect(await stag.balanceOf(alice.address)).to.equal(E(6000));
    // transfers blocked while staked
    const bob = (await ethers.getSigners())[9];
    await expect(wanted.connect(alice).transferFrom(alice.address, bob.address, 1))
      .to.be.revertedWith("locked (staked)");
    // unstake → unlocked → transferable again
    await vault.connect(alice).unstake(wAddr, 1);
    expect(await wanted.locked(1)).to.equal(false);
    await wanted.connect(alice).transferFrom(alice.address, bob.address, 1);
    expect(await wanted.ownerOf(1)).to.equal(bob.address);
  });

  it("only the vault can lock/unlock; owner adminUnlock is an escape hatch", async () => {
    const { wanted, vault, alice, owner } = await full();
    const wAddr = await wanted.getAddress();
    await wanted.connect(alice).mintPick(2, { value: P_MYTH });
    await expect(wanted.connect(alice).lock(2)).to.be.revertedWith("not locker");
    await vault.connect(alice).stake(wAddr, 2);
    await wanted.connect(owner).adminUnlock(2); // owner can free a stuck lock
    expect(await wanted.locked(2)).to.equal(false);
  });
});

describe("WANTED — expanded randomized sim: mint + stake + claim + transfer (150 rounds)", () => {
  it("bounty claimable while staked; funded invariant holds; no double-pay; locked can't transfer", async () => {
    const signers = await ethers.getSigners();
    const { owner, wanted, stag, bounty } = await deploy();
    const vault = await (await ethers.getContractFactory("SherwoodVault")).deploy(owner.address);
    const wAddr = await wanted.getAddress(), bAddr = await bounty.getAddress();
    await vault.addCollection(wAddr, 10000n * 10n ** 18n, true);
    await wanted.setLocker(await vault.getAddress());
    const ids = Object.keys(BOUNTY).map(Number);
    await bounty.setBounties(ids, ids.map((i) => E(BOUNTY[i])));
    await stag.mint(bAddr, E(TOTAL));
    await bounty.lock();
    await wanted.setMaxPerWallet(21);

    const buyers = signers.slice(2, 8);
    const holderOf = {}, staked = {}, claimedExp = {};
    let paid = 0n, seed = 424242;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    for (let r = 0; r < 150; r++) {
      const id = 1 + rnd(21);
      const actor = buyers[rnd(buyers.length)];
      const ai = buyers.indexOf(actor);
      const isHolder = holderOf[id] === ai;
      const pick = rnd(4);

      if (holderOf[id] === undefined) {
        await wanted.connect(actor).mintPick(id, { value: priceOf(id) });
        holderOf[id] = ai;
      } else if (pick === 0 && isHolder && !staked[id]) {
        await vault.connect(actor).stake(wAddr, id); staked[id] = true;
      } else if (pick === 1 && isHolder && staked[id]) {
        await vault.connect(actor).unstake(wAddr, id); staked[id] = false;
      } else if (pick === 2 && isHolder && !claimedExp[id]) {
        // claim works whether staked or not (ownerOf stays the holder under lock-in-place)
        await bounty.connect(actor).claim(id); claimedExp[id] = true; paid += E(BOUNTY[id]);
      } else if (pick === 3 && isHolder && !staked[id]) {
        const to = buyers[rnd(buyers.length)], ti = buyers.indexOf(to);
        if (ti !== ai) { await wanted.connect(actor).transferFrom(actor.address, to.address, id); holderOf[id] = ti; }
      } else if (isHolder && staked[id]) {
        // a staked token must reject transfers
        const to = buyers[(ai + 1) % buyers.length];
        await expect(wanted.connect(actor).transferFrom(actor.address, to.address, id)).to.be.revertedWith("locked (staked)");
      }
      // funded invariant every round
      expect(await stag.balanceOf(bAddr)).to.equal(E(TOTAL) - paid);
    }
    expect(paid <= E(TOTAL)).to.equal(true);
    for (const id of Object.keys(claimedExp)) expect(await bounty.claimed(id)).to.equal(true);
  });
});
