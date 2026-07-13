// Hardhat + ethers v6 test suite for StagLocker.
// Drop this into the $STAG contracts repo (C:\Users\samah\stag\contracts):
//   contracts/StagLocker.sol, contracts/mocks/Mocks.sol, test/StagLocker.test.js
// then:  npx hardhat test test/StagLocker.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const DAY = 24 * 60 * 60;
const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
const jump = async (secs) => { await ethers.provider.send("evm_increaseTime", [secs]); await ethers.provider.send("evm_mine", []); };

async function deploy(feeWei = 0n) {
  const [admin, treasury, alice, bob] = await ethers.getSigners();
  const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
  const Locker = await ethers.getContractFactory("StagLocker");
  const locker = await Locker.deploy(await PM.getAddress(), feeWei, treasury.address, admin.address);
  const Tok = await (await ethers.getContractFactory("MockERC20")).deploy();
  return { admin, treasury, alice, bob, PM, locker, tok: Tok };
}

describe("StagLocker", () => {
  describe("constructor", () => {
    it("reverts on zero fee recipient or admin", async () => {
      const Locker = await ethers.getContractFactory("StagLocker");
      const z = ethers.ZeroAddress;
      const me = (await ethers.getSigners())[0].address;
      // zero feeRecipient -> our own guard
      await expect(Locker.deploy(z, 0, z, me)).to.be.revertedWithCustomError(Locker, "ZeroAddress");
      // zero admin -> caught earlier by the Ownable base constructor
      await expect(Locker.deploy(z, 0, me, z)).to.be.revertedWithCustomError(Locker, "OwnableInvalidOwner");
    });
    it("allows zero positionManager (V3 locks disabled)", async () => {
      const [admin, t] = await ethers.getSigners();
      const Locker = await ethers.getContractFactory("StagLocker");
      const l = await Locker.deploy(ethers.ZeroAddress, 0, t.address, admin.address);
      await expect(l.lockV3Position(0, (await now()) + DAY)).to.be.revertedWithCustomError(l, "WrongKind");
    });
  });

  describe("lockTokens", () => {
    it("locks tokens and exposes them via views", async () => {
      const { locker, tok, alice } = await deploy();
      await tok.mint(alice.address, 1000n);
      await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      const unlock = (await now()) + DAY;
      await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, unlock))
        .to.emit(locker, "TokenLocked").withArgs(0, alice.address, await tok.getAddress(), 1000n, unlock);
      const lk = await locker.getLock(0);
      expect(lk.owner).to.equal(alice.address);
      expect(lk.amountOrId).to.equal(1000n);
      expect(lk.kind).to.equal(0n);
      expect(await locker.ownerLockIds(alice.address)).to.deep.equal([0n]);
      expect(await locker.assetLockIds(await tok.getAddress())).to.deep.equal([0n]);
      expect(await locker.totalLocks()).to.equal(1n);
    });
    it("records the amount RECEIVED for fee-on-transfer tokens", async () => {
      const { locker, alice } = await deploy();
      const fee = await (await ethers.getContractFactory("MockFeeToken")).deploy(500); // 5%
      await fee.mint(alice.address, 1000n);
      await fee.connect(alice).approve(await locker.getAddress(), 1000n);
      await locker.connect(alice).lockTokens(await fee.getAddress(), 1000n, (await now()) + DAY);
      expect((await locker.getLock(0)).amountOrId).to.equal(950n); // 1000 - 5%
    });
    it("reverts on zero address, zero amount, past unlock", async () => {
      const { locker, tok, alice } = await deploy();
      const u = (await now()) + DAY;
      await expect(locker.lockTokens(ethers.ZeroAddress, 1n, u)).to.be.revertedWithCustomError(locker, "ZeroAddress");
      await expect(locker.lockTokens(await tok.getAddress(), 0n, u)).to.be.revertedWithCustomError(locker, "ZeroAmount");
      await tok.mint(alice.address, 1n); await tok.connect(alice).approve(await locker.getAddress(), 1n);
      await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1n, await now())).to.be.revertedWithCustomError(locker, "BadUnlockTime");
    });
  });

  describe("fees (pull-payment)", () => {
    it("accrues the flat fee inside the contract and refunds overpayment", async () => {
      const feeWei = ethers.parseEther("0.01");
      const { locker, tok, alice, treasury } = await deploy(feeWei);
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY, { value: ethers.parseEther("0.05") });
      // Fee is NOT pushed to treasury on lock anymore; it accrues in the contract.
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore);
      expect(await locker.accruedFees()).to.equal(feeWei);
      // Only the fee is retained; overpayment (0.04) was refunded to alice.
      expect(await ethers.provider.getBalance(await locker.getAddress())).to.equal(feeWei);
    });
    it("withdrawFees sends accrued fees to the CURRENT feeRecipient (callable by anyone)", async () => {
      const feeWei = ethers.parseEther("0.01");
      const { locker, tok, alice, bob, treasury } = await deploy(feeWei);
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY, { value: feeWei });
      expect(await locker.accruedFees()).to.equal(feeWei);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      // bob (a stranger) triggers withdrawal; funds still go only to feeRecipient.
      await expect(locker.connect(bob).withdrawFees())
        .to.emit(locker, "FeesWithdrawn").withArgs(treasury.address, feeWei);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + feeWei);
      expect(await locker.accruedFees()).to.equal(0n);
      // Nothing left to withdraw.
      await expect(locker.connect(bob).withdrawFees()).to.be.revertedWithCustomError(locker, "NothingToWithdraw");
    });
    it("a reverting feeRecipient does NOT block lock creation (fees just accrue)", async () => {
      const feeWei = ethers.parseEther("0.01");
      const [admin, , alice] = await ethers.getSigners();
      const bad = await (await ethers.getContractFactory("RevertingReceiver")).deploy();
      const Locker = await ethers.getContractFactory("StagLocker");
      const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
      const locker = await Locker.deploy(await PM.getAddress(), feeWei, await bad.getAddress(), admin.address);
      const tok = await (await ethers.getContractFactory("MockERC20")).deploy();
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      // Would have reverted under the old push model; now it succeeds.
      await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY, { value: feeWei }))
        .to.emit(locker, "TokenLocked");
      expect(await locker.accruedFees()).to.equal(feeWei);
      // withdrawFees to a reverting recipient reverts and keeps the fee accrued (not lost).
      await expect(locker.withdrawFees()).to.be.revertedWithCustomError(locker, "FeeWithdrawFailed");
      expect(await locker.accruedFees()).to.equal(feeWei);
      // After redirecting the recipient, the fee is claimable.
      await locker.connect(admin).setFee(feeWei, alice.address);
      await expect(locker.withdrawFees()).to.emit(locker, "FeesWithdrawn").withArgs(alice.address, feeWei);
      expect(await locker.accruedFees()).to.equal(0n);
    });
    it("reverts when fee underpaid", async () => {
      const feeWei = ethers.parseEther("0.01");
      const { locker, tok, alice } = await deploy(feeWei);
      await tok.mint(alice.address, 1n); await tok.connect(alice).approve(await locker.getAddress(), 1n);
      await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1n, (await now()) + DAY, { value: ethers.parseEther("0.005") }))
        .to.be.revertedWithCustomError(locker, "FeeTooLow");
    });
  });

  describe("withdraw", () => {
    it("blocks early withdraw, allows after unlock, only by owner", async () => {
      const { locker, tok, alice, bob } = await deploy();
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY);
      await expect(locker.connect(alice).withdraw(0)).to.be.revertedWithCustomError(locker, "StillLocked");
      await jump(DAY + 1);
      await expect(locker.connect(bob).withdraw(0)).to.be.revertedWithCustomError(locker, "NotLockOwner");
      await expect(locker.connect(alice).withdraw(0)).to.emit(locker, "Withdrawn").withArgs(0, alice.address);
      expect(await tok.balanceOf(alice.address)).to.equal(1000n);
      await expect(locker.connect(alice).withdraw(0)).to.be.revertedWithCustomError(locker, "AlreadyWithdrawn");
    });
  });

  describe("manage (only strengthens the lock)", () => {
    it("extendLock only later, owner only", async () => {
      const { locker, tok, alice, bob } = await deploy();
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      const u = (await now()) + DAY;
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, u);
      await expect(locker.connect(alice).extendLock(0, u - 1)).to.be.revertedWithCustomError(locker, "BadUnlockTime");
      await expect(locker.connect(bob).extendLock(0, u + DAY)).to.be.revertedWithCustomError(locker, "NotLockOwner");
      await expect(locker.connect(alice).extendLock(0, u + DAY)).to.emit(locker, "LockExtended").withArgs(0, u + DAY);
    });
    it("topUp adds received amount, ERC20 only", async () => {
      const { locker, tok, alice } = await deploy();
      await tok.mint(alice.address, 1500n); await tok.connect(alice).approve(await locker.getAddress(), 1500n);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY);
      await expect(locker.connect(alice).topUp(0, 500n)).to.emit(locker, "LockToppedUp").withArgs(0, 500n, 1500n);
      expect((await locker.getLock(0)).amountOrId).to.equal(1500n);
    });
    it("transferLockOwnership moves control and re-indexes owner arrays", async () => {
      const { locker, tok, alice, bob } = await deploy();
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY);
      expect(await locker.ownerLockIds(alice.address)).to.deep.equal([0n]);
      await expect(locker.connect(alice).transferLockOwnership(0, bob.address))
        .to.emit(locker, "LockOwnerChanged").withArgs(0, alice.address, bob.address);
      expect((await locker.getLock(0)).owner).to.equal(bob.address);
      // id removed from the OLD owner's array (swap-and-pop) and added to the new one.
      expect(await locker.ownerLockIds(alice.address)).to.deep.equal([]);
      expect(await locker.ownerLockCount(alice.address)).to.equal(0n);
      expect(await locker.ownerLockIds(bob.address)).to.deep.equal([0n]);
      expect(await locker.ownerLockCount(bob.address)).to.equal(1n);
      await jump(DAY + 1);
      await expect(locker.connect(alice).withdraw(0)).to.be.revertedWithCustomError(locker, "NotLockOwner");
      await locker.connect(bob).withdraw(0);
      expect(await tok.balanceOf(bob.address)).to.equal(1000n);
    });
    it("rejects a no-op self-transfer and keeps the index clean on A->B->A", async () => {
      const { locker, tok, alice, bob } = await deploy();
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY);
      await expect(locker.connect(alice).transferLockOwnership(0, alice.address))
        .to.be.revertedWithCustomError(locker, "SameOwner");
      await expect(locker.connect(alice).transferLockOwnership(0, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(locker, "ZeroAddress");
      // A -> B -> A must not leave duplicate/stale entries (no unbounded growth).
      await locker.connect(alice).transferLockOwnership(0, bob.address);
      await locker.connect(bob).transferLockOwnership(0, alice.address);
      expect(await locker.ownerLockIds(alice.address)).to.deep.equal([0n]);
      expect(await locker.ownerLockIds(bob.address)).to.deep.equal([]);
    });
  });

  describe("views (counts, pagination, isUnlocked)", () => {
    async function seed(n) {
      const ctx = await deploy();
      const { locker, tok, alice } = ctx;
      await tok.mint(alice.address, BigInt(n) * 100n);
      await tok.connect(alice).approve(await locker.getAddress(), BigInt(n) * 100n);
      const u = (await now()) + DAY;
      for (let i = 0; i < n; i++) await locker.connect(alice).lockTokens(await tok.getAddress(), 100n, u);
      return { ...ctx, u };
    }
    it("count views match the number of locks", async () => {
      const { locker, tok, alice } = await seed(5);
      expect(await locker.ownerLockCount(alice.address)).to.equal(5n);
      expect(await locker.assetLockCount(await tok.getAddress())).to.equal(5n);
    });
    it("paged views return the correct clamped slice", async () => {
      const { locker, tok, alice } = await seed(5);
      const asset = await tok.getAddress();
      expect(await locker.ownerLockIdsPaged(alice.address, 1, 2)).to.deep.equal([1n, 2n]);
      // count overruns the end -> clamp to length
      expect(await locker.ownerLockIdsPaged(alice.address, 3, 100)).to.deep.equal([3n, 4n]);
      // start at/after end -> empty
      expect(await locker.ownerLockIdsPaged(alice.address, 5, 10)).to.deep.equal([]);
      expect(await locker.ownerLockIdsPaged(alice.address, 99, 10)).to.deep.equal([]);
      // asset variant paginates the same underlying ids
      expect(await locker.assetLockIdsPaged(asset, 0, 3)).to.deep.equal([0n, 1n, 2n]);
      expect(await locker.assetLockIdsPaged(asset, 4, 10)).to.deep.equal([4n]);
    });
    it("isUnlocked returns false for a nonexistent lock id", async () => {
      const { locker } = await seed(1);
      expect(await locker.isUnlocked(0)).to.equal(false); // still locked
      expect(await locker.isUnlocked(999)).to.equal(false); // nonexistent, not "unlocked"
      await jump(DAY + 1);
      expect(await locker.isUnlocked(0)).to.equal(true);
      expect(await locker.isUnlocked(999)).to.equal(false); // still nonexistent
    });
  });

  describe("V3 LP locks", () => {
    it("locks via lockV3Position (approve path)", async () => {
      const { locker, PM, alice } = await deploy();
      const id = 0; await PM.mint(alice.address);
      await PM.connect(alice).approve(await locker.getAddress(), id);
      const u = (await now()) + DAY;
      await expect(locker.connect(alice).lockV3Position(id, u)).to.emit(locker, "V3Locked").withArgs(anyValue, alice.address, id, u);
      expect(await PM.ownerOf(id)).to.equal(await locker.getAddress());
      await jump(DAY + 1);
      await locker.connect(alice).withdraw(0);
      expect(await PM.ownerOf(id)).to.equal(alice.address);
    });
    it("locks via safeTransferFrom with encoded unlockTime", async () => {
      const { locker, PM, alice } = await deploy();
      await PM.mint(alice.address); // id 0
      const u = (await now()) + DAY;
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [u]);
      await PM.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, await locker.getAddress(), 0, data);
      const lk = await locker.getLock(0);
      expect(lk.kind).to.equal(1n);
      expect(lk.owner).to.equal(alice.address);
    });
    it("REVERTS a safeTransfer with bad data instead of stranding the NFT", async () => {
      const { locker, PM, alice } = await deploy();
      await PM.mint(alice.address); // id 0
      await expect(
        PM.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, await locker.getAddress(), 0, "0x")
      ).to.be.reverted; // no lock, NFT stays with alice
      expect(await PM.ownerOf(0)).to.equal(alice.address);
    });
  });

  describe("admin can NEVER touch locked assets", () => {
    it("only exposes setFee; no drain path exists", async () => {
      const { locker, admin } = await deploy();
      expect(typeof locker.setFee).to.equal("function");
      // sanity: the contract ABI has no owner-only asset-moving function
      const fns = locker.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const bad of ["sweep", "rescue", "emergencyWithdraw", "adminWithdraw", "recover"]) {
        expect(fns).to.not.include(bad);
      }
    });
    it("setFee is owner-only and updates fee + recipient", async () => {
      const { locker, admin, alice, bob } = await deploy();
      await expect(locker.connect(alice).setFee(1n, bob.address)).to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
      await expect(locker.connect(admin).setFee(1n, bob.address)).to.emit(locker, "FeeChanged").withArgs(1n, bob.address);
      await expect(locker.connect(admin).setFee(1n, ethers.ZeroAddress)).to.be.revertedWithCustomError(locker, "ZeroAddress");
    });
  });
});

describe("StagLocker — $STAG fee waiver", () => {
  const FEE = 6700000000000000n;           // ~0.0067 ETH (~$20)
  const MIN = 5_000_000n * 10n ** 18n;      // 5M $STAG

  async function setup() {
    const { admin, treasury, alice, bob, locker, tok } = await deploy(FEE);
    await locker.connect(admin).setFeeExemption(await tok.getAddress(), MIN);
    return { admin, treasury, alice, bob, locker, tok };
  }

  it("non-holders pay the flat fee; feeFor reports it", async () => {
    const { alice, locker, tok } = await setup();
    expect(await locker.feeFor(alice.address)).to.equal(FEE);
    // lock reverts if underpaid, succeeds when the fee is sent
    await tok.mint(alice.address, 1000n);
    await tok.connect(alice).approve(await locker.getAddress(), 1000n);
    const unlock = (await now()) + DAY;
    await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, unlock, { value: 0 }))
      .to.be.revertedWithCustomError(locker, "FeeTooLow");
    await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, unlock, { value: FEE }))
      .to.emit(locker, "TokenLocked");
    expect(await locker.accruedFees()).to.equal(FEE);
  });

  it("holders of >= 5M $STAG lock for FREE (feeFor == 0, value 0 works)", async () => {
    const { bob, locker, tok } = await setup();
    await tok.mint(bob.address, MIN);        // exactly the threshold
    expect(await locker.feeFor(bob.address)).to.equal(0n);
    await tok.connect(bob).approve(await locker.getAddress(), 1000n);
    const unlock = (await now()) + DAY;
    await expect(locker.connect(bob).lockTokens(await tok.getAddress(), 1000n, unlock, { value: 0 }))
      .to.emit(locker, "TokenLocked");
    expect(await locker.accruedFees()).to.equal(0n); // nothing charged
  });

  it("just under the threshold still pays", async () => {
    const { bob, locker, tok } = await setup();
    await tok.mint(bob.address, MIN - 1n);
    expect(await locker.feeFor(bob.address)).to.equal(FEE);
  });

  it("only owner can set the exemption; address(0) disables it", async () => {
    const { admin, alice, locker, tok } = await setup();
    await expect(locker.connect(alice).setFeeExemption(await tok.getAddress(), MIN))
      .to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
    await locker.connect(admin).setFeeExemption(ethers.ZeroAddress, 0);
    await tok.mint(alice.address, MIN);
    expect(await locker.feeFor(alice.address)).to.equal(FEE); // waiver disabled -> everyone pays
  });
});

describe("StagLocker — fee-waiver fail-closed (hostile exempt token)", () => {
  const FEE = 6700000000000000n;
  it("a reverting exempt token forfeits the waiver but does NOT brick lock creation", async () => {
    const [own, treasury, a] = await ethers.getSigners();
    const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
    const L = await (await ethers.getContractFactory("StagLocker")).deploy(await PM.getAddress(), FEE, treasury.address, own.address);
    const T = await (await ethers.getContractFactory("MockERC20")).deploy();
    const Bad = await (await ethers.getContractFactory("RevertingBalanceToken")).deploy();
    await L.connect(own).setFeeExemption(await Bad.getAddress(), 1n);
    // feeFor must NOT revert; it falls back to the flat fee
    expect(await L.feeFor(a.address)).to.equal(FEE);
    // and lock creation still works when the fee is paid
    await T.mint(a.address, 1000n);
    await T.connect(a).approve(await L.getAddress(), 1000n);
    const unlock = (await now()) + DAY;
    await expect(L.connect(a).lockTokens(await T.getAddress(), 1000n, unlock, { value: FEE }))
      .to.emit(L, "TokenLocked");
  });
});

describe("StagLocker — $STAG burn per 30-day lock (free at 10M)", () => {
  const MIN = 10_000_000n * 10n ** 18n;     // free threshold
  const PER = 2_000_000n * 10n ** 18n;      // 2M...
  const PERIOD = BigInt(30 * DAY);          // ...per 30 days
  const DEAD = "0x000000000000000000000000000000000000dEaD";

  async function setup() {
    const [own, treasury, whale, small] = await ethers.getSigners();
    const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
    const L = await (await ethers.getContractFactory("StagLocker")).deploy(await PM.getAddress(), 0, treasury.address, own.address);
    const STAG = await (await ethers.getContractFactory("MockERC20")).deploy();
    const TOK = await (await ethers.getContractFactory("MockERC20")).deploy();
    await L.connect(own).setFeeExemption(await STAG.getAddress(), MIN);
    await L.connect(own).setBurnConfig(PER, PERIOD);
    await STAG.mint(whale.address, MIN);              // exactly 10M -> free
    await STAG.mint(small.address, 9_000_000n * 10n ** 18n); // < 10M: non-exempt, enough to burn short locks
    await STAG.connect(whale).approve(await L.getAddress(), ethers.MaxUint256);
    await STAG.connect(small).approve(await L.getAddress(), ethers.MaxUint256);
    await TOK.mint(whale.address, 10n ** 24n); await TOK.mint(small.address, 10n ** 24n);
    await TOK.connect(whale).approve(await L.getAddress(), ethers.MaxUint256);
    await TOK.connect(small).approve(await L.getAddress(), ethers.MaxUint256);
    return { own, whale, small, L, STAG, TOK };
  }

  it("burnFor scales 2M per 30 days; free for >=10M holders", async () => {
    const { whale, small, L } = await setup();
    expect(await L.burnFor(small.address, 30 * DAY)).to.equal(PER);       // 30d -> 2M
    expect(await L.burnFor(small.address, 90 * DAY)).to.equal(PER * 3n);  // 90d -> 6M
    expect(await L.burnFor(small.address, 365 * DAY)).to.equal((PER * BigInt(365 * DAY)) / PERIOD);
    expect(await L.burnFor(whale.address, 365 * DAY)).to.equal(0n);       // whale exempt -> free
  });

  it("non-holder locking 90 days burns 6M $STAG to dead; whale burns nothing", async () => {
    const { whale, small, L, STAG, TOK } = await setup();
    const unlock = (await now()) + 90 * DAY;
    const before = await STAG.balanceOf(small.address);
    await expect(L.connect(small).lockTokens(await TOK.getAddress(), 1000n, unlock, { value: 0 }))
      .to.emit(L, "LockBurned");
    // burn is prorated per-second, so a ~90d lock burns just under 6M (tx mines 1-2s later)
    const burned = before - (await STAG.balanceOf(small.address));
    const target = PER * 3n, tol = 10n ** 20n; // within 100 $STAG, and never OVER target
    expect(burned <= target && burned >= target - tol).to.equal(true);
    expect(await STAG.balanceOf(DEAD)).to.equal(burned);
    // whale: no burn
    const wbUnlock = (await now()) + 60 * DAY; const wb = await STAG.balanceOf(whale.address);
    await L.connect(whale).lockTokens(await TOK.getAddress(), 1000n, wbUnlock, { value: 0 });
    expect(await STAG.balanceOf(whale.address)).to.equal(wb); // unchanged
  });

  it("extendLock burns for the added term only", async () => {
    const { small, L, STAG, TOK } = await setup();
    const unlock = (await now()) + 30 * DAY;
    await L.connect(small).lockTokens(await TOK.getAddress(), 1000n, unlock, { value: 0 }); // burns 2M
    const id = Number(await L.nextLockId()) - 1;
    const bal = await STAG.balanceOf(small.address);
    await L.connect(small).extendLock(id, unlock + 60 * DAY); // +60d -> burn 4M
    expect(bal - (await STAG.balanceOf(small.address))).to.equal(PER * 2n);
  });

  it("reverts if the non-holder can't cover the burn (no free ride)", async () => {
    const { small, L, STAG, TOK } = await setup();
    // drain small's $STAG below the 90-day burn (6M)
    const bal = await STAG.balanceOf(small.address);
    await STAG.connect(small).transfer("0x000000000000000000000000000000000000bEEF", bal - (PER)); // leave 2M
    const unlock = (await now()) + 90 * DAY; // needs 6M, has 2M
    await expect(L.connect(small).lockTokens(await TOK.getAddress(), 1000n, unlock, { value: 0 }))
      .to.be.reverted; // ERC20 insufficient balance
  });
});

describe("StagLocker — V3 safeTransferFrom path ALSO burns (L-1 fix)", () => {
  const MIN = 10_000_000n * 10n ** 18n;
  const PER = 2_000_000n * 10n ** 18n;
  const PERIOD = BigInt(30 * DAY);
  const DEAD = "0x000000000000000000000000000000000000dEaD";
  it("burns $STAG when a non-holder locks a V3 NFT via safeTransferFrom", async () => {
    const [own, treasury, small] = await ethers.getSigners();
    const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
    const L = await (await ethers.getContractFactory("StagLocker")).deploy(await PM.getAddress(), 0, treasury.address, own.address);
    const STAG = await (await ethers.getContractFactory("MockERC20")).deploy();
    await L.connect(own).setFeeExemption(await STAG.getAddress(), MIN);
    await L.connect(own).setBurnConfig(PER, PERIOD);
    await STAG.mint(small.address, 9_000_000n * 10n ** 18n);
    await STAG.connect(small).approve(await L.getAddress(), ethers.MaxUint256); // must approve $STAG
    await PM.connect(small).mint(small.address); // id 0
    const u = (await now()) + 30 * DAY;
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [u]);
    const before = await STAG.balanceOf(small.address);
    await PM.connect(small)["safeTransferFrom(address,address,uint256,bytes)"](small.address, await L.getAddress(), 0, data);
    const burned = before - (await STAG.balanceOf(small.address));
    // ~2M for 30 days (a hair under, prorated per-second)
    expect(burned <= PER && burned >= PER - 10n ** 20n).to.equal(true);
    expect(await STAG.balanceOf(DEAD)).to.equal(burned);
  });
});
