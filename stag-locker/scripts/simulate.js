// 300 randomized invariant simulations for StagLocker (v2: vesting + V3 collect + burn cap).
//   npx hardhat run scripts/simulate.js
// Random actors drive random actions (lock / lock-vesting / lock-V3 / topUp / extend /
// transferOwnership / withdraw(partial+full) / collectV3Fees / setFee / setBurnConfig /
// withdrawFees / time-jump) against a shadow model; core invariants asserted after every step.
const { ethers } = require("hardhat");

const N = parseInt(process.env.SIM_RUNS || "300", 10);
const DAY = 86400;
let _s = (0x9e3779b9 ^ (parseInt(process.env.SIM_SEED || "4660"))) >>> 0;
const rnd = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 0x100000000; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const bn = (n) => BigInt(Math.floor(n));
async function nowTs() { return (await ethers.provider.getBlock("latest")).timestamp; }
async function jump(s) { await ethers.provider.send("evm_increaseTime", [s]); await ethers.provider.send("evm_mine", []); }

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0], treasury = signers[1];
  const actors = signers.slice(2, 7);

  const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
  const FEE0 = 6700000000000000n;
  const locker = await (await ethers.getContractFactory("StagLocker"))
    .deploy(await PM.getAddress(), FEE0, treasury.address, admin.address);
  const LADDR = await locker.getAddress();

  const T1 = await (await ethers.getContractFactory("MockERC20")).deploy();
  const T2 = await (await ethers.getContractFactory("MockERC20")).deploy();
  const FOT = await (await ethers.getContractFactory("MockFeeToken")).deploy(300n);
  const tokens = [T1, T2, FOT];
  const plain = [T1, T2]; // vesting sim uses non-FoT tokens for clean expected math

  const STAG = await (await ethers.getContractFactory("MockERC20")).deploy();
  const MIN = 10_000_000n * 10n ** 18n;
  await locker.connect(admin).setFeeExemption(await STAG.getAddress(), MIN);
  await locker.connect(admin).setBurnConfig(2_000_000n * 10n ** 18n, BigInt(30 * DAY));
  await locker.connect(admin).setBurnCap(2_000_000n * 10n ** 18n); // v2: cap the burn

  for (let i = 0; i < actors.length; i++) {
    for (const t of tokens) await t.mint(actors[i].address, 10n ** 24n);
    await STAG.mint(actors[i].address, i % 2 === 0 ? MIN + bn(rnd() * 1e6) : 9_000_000n * 10n ** 18n);
    await STAG.connect(actors[i]).approve(LADDR, ethers.MaxUint256);
  }

  const locks = []; // {id, kind, asset, owner, unlock, withdrawn, vesting}
  const counts = {};
  const tally = (k) => counts[k] = (counts[k] || 0) + 1;

  const assertInvariants = async (step) => {
    // 1) per-token solvency using the CONTRACT'S OWN accounting: balance >= Σ(amountOrId - released)
    for (const t of tokens) {
      const addr = await t.getAddress();
      let owed = 0n;
      for (const l of locks) if (!l.withdrawn && l.kind === "erc20" && l.asset === addr) {
        const on = await locker.getLock(l.id);
        if (on.released > on.amountOrId) throw new Error(`[step ${step}] released > amount on lock ${l.id}`);
        owed += (on.amountOrId - on.released);
      }
      const bal = await t.balanceOf(LADDR);
      if (bal < owed) throw new Error(`[step ${step}] INSOLVENT ${addr}: bal ${bal} < owed ${owed}`);
    }
    // 2) V3 custody: locker still owns every active V3 tokenId (collect must NOT move it)
    for (const l of locks) if (!l.withdrawn && l.kind === "v3") {
      const o = await PM.ownerOf(l.amount);
      if (o.toLowerCase() !== LADDR.toLowerCase()) throw new Error(`[step ${step}] V3 #${l.amount} not held by locker`);
    }
    // 3) ETH: contract balance == accruedFees
    const ethBal = await ethers.provider.getBalance(LADDR);
    const accrued = await locker.accruedFees();
    if (ethBal !== accrued) throw new Error(`[step ${step}] ETH mismatch: ${ethBal} != ${accrued}`);
  };

  for (let step = 0; step < N; step++) {
    const actor = pick(actors);
    const action = pick(["lock", "vest", "vest", "lockv3", "topup", "extend", "xfer",
                         "withdraw", "withdraw", "collect", "fee", "burncfg", "sweep", "time"]);
    try {
      if (action === "lock") {
        const t = pick(tokens), addr = await t.getAddress();
        const amt = bn(rnd() * 1e21) + 1000n, unlock = (await nowTs()) + pick([60, 90, 180, 365, 1095]) * DAY;
        await t.connect(actor).approve(LADDR, amt);
        const fee = await locker.feeFor(actor.address), before = await t.balanceOf(LADDR);
        await (await locker.connect(actor).lockTokens(addr, amt, unlock, { value: fee })).wait();
        const rec = (await t.balanceOf(LADDR)) - before, id = Number(await locker.nextLockId()) - 1;
        locks.push({ id, kind: "erc20", asset: addr, amount: rec, owner: actor.address, unlock, withdrawn: false, vesting: false });
        tally("lock");
      } else if (action === "vest") {
        const t = pick(plain), addr = await t.getAddress();
        const amt = bn(rnd() * 1e21) + 1000n;
        const start = (await nowTs()) + pick([0, 1, 7]) * DAY;
        const end = start + pick([30, 90, 180, 365]) * DAY;
        await t.connect(actor).approve(LADDR, amt);
        const fee = await locker.feeFor(actor.address), before = await t.balanceOf(LADDR);
        await (await locker.connect(actor).lockTokensVesting(addr, amt, start, end, { value: fee })).wait();
        const rec = (await t.balanceOf(LADDR)) - before, id = Number(await locker.nextLockId()) - 1;
        locks.push({ id, kind: "erc20", asset: addr, amount: rec, owner: actor.address, unlock: end, withdrawn: false, vesting: true });
        tally("vest");
      } else if (action === "lockv3") {
        await (await PM.connect(actor).mint(actor.address)).wait();
        const tokenId = Number(await PM.nextId()) - 1, unlock = (await nowTs()) + pick([60, 365]) * DAY;
        await PM.connect(actor).approve(LADDR, tokenId);
        const fee = await locker.feeFor(actor.address);
        await (await locker.connect(actor).lockV3Position(tokenId, unlock, { value: fee })).wait();
        const id = Number(await locker.nextLockId()) - 1;
        locks.push({ id, kind: "v3", asset: await PM.getAddress(), amount: BigInt(tokenId), owner: actor.address, unlock, withdrawn: false, vesting: false });
        tally("lockv3");
      } else if (action === "topup") {
        const c = locks.filter((l) => !l.withdrawn && l.kind === "erc20" && l.owner === actor.address);
        if (!c.length) { tally("topup-skip"); continue; }
        const l = pick(c), tok = await ethers.getContractAt("MockERC20", l.asset), amt = bn(rnd() * 1e20) + 1n;
        await tok.connect(actor).approve(LADDR, amt);
        await (await locker.connect(actor).topUp(l.id, amt)).wait();
        tally("topup");
      } else if (action === "extend") {
        const c = locks.filter((l) => !l.withdrawn && l.owner === actor.address);
        if (!c.length) { tally("extend-skip"); continue; }
        const l = pick(c), nu = l.unlock + pick([1, 30, 365]) * DAY;
        await (await locker.connect(actor).extendLock(l.id, nu)).wait();
        l.unlock = nu; tally("extend");
      } else if (action === "xfer") {
        const c = locks.filter((l) => !l.withdrawn && l.owner === actor.address);
        if (!c.length) { tally("xfer-skip"); continue; }
        const l = pick(c), to = pick(actors);
        if (to.address === actor.address) { tally("xfer-skip"); continue; }
        await (await locker.connect(actor).transferLockOwnership(l.id, to.address)).wait();
        l.owner = to.address; tally("xfer");
      } else if (action === "withdraw") {
        const c = locks.filter((l) => !l.withdrawn && l.owner === actor.address);
        if (!c.length) { tally("wd-skip"); continue; }
        const l = pick(c), on0 = await locker.getLock(l.id);
        const cliffOrV3 = l.kind === "v3" || BigInt(on0.start) === BigInt(on0.unlockTime);
        const matured = (await nowTs()) >= Number(l.unlock);
        if (cliffOrV3 && !matured) {
          let reverted = false;
          try { await locker.connect(actor).withdraw.staticCall(l.id); } catch { reverted = true; }
          if (!reverted) throw new Error(`[step ${step}] EARLY WITHDRAW allowed on lock ${l.id}`);
          tally("wd-early-blocked"); continue;
        }
        try {
          await (await locker.connect(actor).withdraw(l.id)).wait();
          const on1 = await locker.getLock(l.id);
          l.withdrawn = on1.withdrawn;
          tally(l.withdrawn ? "withdraw" : "withdraw-partial");
        } catch { tally("wd-nothing-vested"); } // vesting lock, nothing vested yet — legit
      } else if (action === "collect") {
        const c = locks.filter((l) => !l.withdrawn && l.kind === "v3" && l.owner === actor.address);
        if (!c.length) { tally("collect-skip"); continue; }
        const l = pick(c);
        await (await locker.connect(actor).collectV3Fees(l.id)).wait();
        tally("collect");
      } else if (action === "fee") {
        await (await locker.connect(admin).setFee(bn(rnd() * 2e16), treasury.address)).wait();
        tally("fee");
      } else if (action === "burncfg") {
        await (await locker.connect(admin).setBurnCap(bn(rnd() * 3e24))).wait();
        tally("burncfg");
      } else if (action === "sweep") {
        if ((await locker.accruedFees()) > 0n) { await (await locker.connect(pick(actors)).withdrawFees()).wait(); tally("sweep"); }
        else tally("sweep-skip");
      } else if (action === "time") {
        await jump(pick([1, 15, 60, 200, 400]) * DAY); tally("time");
      }
    } catch (e) {
      const m = String(e.message);
      if (/EARLY WITHDRAW|INSOLVENT|not held|mismatch|released > amount/.test(m)) throw e;
      tally("revert");
    }
    await assertInvariants(step);
  }

  console.log(`\n✅ ${N} simulation steps — ALL INVARIANTS HELD`);
  console.log("active locks:", locks.filter((l) => !l.withdrawn).length, "/ total", locks.length,
    "| vesting:", locks.filter((l) => l.vesting).length);
  console.log("action tally:", JSON.stringify(counts));
}
main().then(() => process.exit(0)).catch((e) => { console.error("\n❌ SIM FAILED:", e.message); process.exit(1); });
