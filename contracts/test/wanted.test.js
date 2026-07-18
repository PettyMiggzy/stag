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
    await bounty.lock();
    await expect(bounty.setBounties([1], [E(1)])).to.be.revertedWith("locked");
    await stag.mint(await bounty.getAddress(), E(TOTAL));
    await expect(bounty.sweep()).to.be.revertedWith("not expired");
    await ethers.provider.send("evm_setNextBlockTimestamp", [expiry + 1]);
    await ethers.provider.send("evm_mine", []);
    const before = await stag.balanceOf(owner.address);
    await bounty.sweep();
    expect(await stag.balanceOf(owner.address)).to.equal(before + E(TOTAL));
  });

  it("underfunded claim reverts (funds must be deposited first)", async () => {
    const { bounty, wanted, alice } = await setup();
    await wanted.connect(alice).mintPick(1, { value: P_MYTH });
    await bounty.lock(); // locked but NOT funded
    await expect(bounty.connect(alice).claim(1)).to.be.reverted; // ERC20 insufficient balance
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
