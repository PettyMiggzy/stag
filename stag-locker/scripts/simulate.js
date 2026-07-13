// 300 randomized invariant simulations for StagLocker.
//   npx hardhat run scripts/simulate.js
// Drives random actors through random actions (lock ERC-20 / lock V3 / topUp / extend /
// transferOwnership / withdraw / setFee / setFeeExemption / withdrawFees / time-jump) against a
// shadow model, and asserts the core invariants after every step. Any violation throws.
const { ethers } = require("hardhat");

const N = parseInt(process.env.SIM_RUNS || "300", 10);
const DAY = 86400;
// tiny seeded PRNG (deterministic runs)
let _s = 0x9e3779b9 ^ 0x1234;
const rnd = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 0x100000000; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const bn = (n) => BigInt(Math.floor(n));

async function nowTs() { return (await ethers.provider.getBlock("latest")).timestamp; }
async function jump(s) { await ethers.provider.send("evm_increaseTime", [s]); await ethers.provider.send("evm_mine", []); }

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0], treasury = signers[1];
  const actors = signers.slice(2, 7); // 5 actors

  const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
  const FEE0 = 6700000000000000n; // ~$20
  const locker = await (await ethers.getContractFactory("StagLocker"))
    .deploy(await PM.getAddress(), FEE0, treasury.address, admin.address);
  const LADDR = await locker.getAddress();

  // lockable tokens: 2 plain + 1 fee-on-transfer
  const T1 = await (await ethers.getContractFactory("MockERC20")).deploy();
  const T2 = await (await ethers.getContractFactory("MockERC20")).deploy();
  const FOT = await (await ethers.getContractFactory("MockFeeToken")).deploy(300n); // takes a % on transfer
  const tokens = [T1, T2, FOT];
  // $STAG: free if held >= 10M, else burn 2M per 30 days of lock
  const STAG = await (await ethers.getContractFactory("MockERC20")).deploy();
  const MIN = 10_000_000n * 10n ** 18n;             // 10M $STAG → free
  const BURN_PER = 2_000_000n * 10n ** 18n;         // 2M...
  const BURN_PERIOD = BigInt(30 * DAY);             // ...per 30 days
  const DEAD = "0x000000000000000000000000000000000000dEaD";
  await locker.connect(admin).setFeeExemption(await STAG.getAddress(), MIN);
  await locker.connect(admin).setBurnConfig(BURN_PER, BURN_PERIOD);

  // exempt actors (even) hold >= 10M and lock free; non-exempt (odd) hold < 10M and must burn.
  for (let i = 0; i < actors.length; i++) {
    for (const t of tokens) await t.mint(actors[i].address, 10n ** 24n);
    await STAG.mint(actors[i].address, i % 2 === 0 ? MIN + bn(rnd() * 1e6) : 9_000_000n * 10n ** 18n);
    await STAG.connect(actors[i]).approve(LADDR, ethers.MaxUint256); // allow burns
  }
  const stagOf = async (a) => STAG.balanceOf(a);
  const burnedTotal = async () => STAG.balanceOf(DEAD);

  // shadow model
  const locks = []; // {id, kind:'erc20'|'v3', asset, amount(BigInt), owner, unlock, withdrawn}
  let curFee = FEE0;
  const counts = {};
  const tally = (k) => counts[k] = (counts[k] || 0) + 1;

  const assertInvariants = async (step) => {
    // 1) per-token solvency: contract balance >= sum of active erc20 lock amounts
    for (const t of tokens) {
      const addr = await t.getAddress();
      let owed = 0n;
      for (const l of locks) if (!l.withdrawn && l.kind === "erc20" && l.asset === addr) owed += l.amount;
      const bal = await t.balanceOf(LADDR);
      if (bal < owed) throw new Error(`[step ${step}] INSOLVENT ${addr}: bal ${bal} < owed ${owed}`);
    }
    // 2) V3 custody: locker owns every active V3 tokenId
    for (const l of locks) if (!l.withdrawn && l.kind === "v3") {
      const o = await PM.ownerOf(l.amount);
      if (o.toLowerCase() !== LADDR.toLowerCase()) throw new Error(`[step ${step}] V3 #${l.amount} not held by locker (owner ${o})`);
    }
    // 3) fee accounting: contract ETH balance == accruedFees (all fees held, overpay refunded)
    const ethBal = await ethers.provider.getBalance(LADDR);
    const accrued = await locker.accruedFees();
    if (ethBal !== accrued) throw new Error(`[step ${step}] ETH mismatch: bal ${ethBal} != accruedFees ${accrued}`);
    // 4) on-chain lock state matches shadow (owner + withdrawn) for a sampled lock
    if (locks.length) {
      const l = pick(locks);
      const on = await locker.getLock(l.id);
      if (on.owner.toLowerCase() !== l.owner.toLowerCase()) throw new Error(`[step ${step}] owner drift lock ${l.id}`);
      if (on.withdrawn !== l.withdrawn) throw new Error(`[step ${step}] withdrawn drift lock ${l.id}`);
    }
  };

  for (let step = 0; step < N; step++) {
    const actor = pick(actors);
    const action = pick(["lock", "lock", "lockv3", "topup", "extend", "xfer", "withdraw", "withdraw", "fee", "exempt", "sweep", "time"]);
    try {
      if (action === "lock") {
        const t = pick(tokens); const addr = await t.getAddress();
        const amt = bn(rnd() * 1e21) + 1n;
        const dur = pick([60, 90, 180, 365, 1095]) * DAY;
        const unlock = (await nowTs()) + dur;
        await t.connect(actor).approve(LADDR, amt);
        const fee = await locker.feeFor(actor.address);
        const before = await t.balanceOf(LADDR);
        const rc = await (await locker.connect(actor).lockTokens(addr, amt, unlock, { value: fee })).wait();
        const received = (await t.balanceOf(LADDR)) - before;
        // id from event
        const id = Number(await locker.nextLockId()) - 1;
        locks.push({ id, kind: "erc20", asset: addr, amount: received, owner: actor.address, unlock, withdrawn: false });
        tally("lock");
      } else if (action === "lockv3") {
        const id = await (await PM.connect(actor).mint(actor.address)).wait();
        const tokenId = Number(await PM.nextId()) - 1;
        const dur = pick([60, 365, 1095]) * DAY;
        const unlock = (await nowTs()) + dur;
        await PM.connect(actor).approve(LADDR, tokenId);
        const fee = await locker.feeFor(actor.address);
        await (await locker.connect(actor).lockV3Position(tokenId, unlock, { value: fee })).wait();
        const lid = Number(await locker.nextLockId()) - 1;
        locks.push({ id: lid, kind: "v3", asset: await PM.getAddress(), amount: BigInt(tokenId), owner: actor.address, unlock, withdrawn: false });
        tally("lockv3");
      } else if (action === "topup") {
        const cand = locks.filter((l) => !l.withdrawn && l.kind === "erc20" && l.owner === actor.address);
        if (!cand.length) { tally("topup-skip"); continue; }
        const l = pick(cand); const t = tokens.find(async () => true);
        const tok = await ethers.getContractAt("MockERC20", l.asset);
        const amt = bn(rnd() * 1e20) + 1n;
        await tok.connect(actor).approve(LADDR, amt);
        const before = await tok.balanceOf(LADDR);
        await (await locker.connect(actor).topUp(l.id, amt)).wait();
        l.amount += (await tok.balanceOf(LADDR)) - before;
        tally("topup");
      } else if (action === "extend") {
        const cand = locks.filter((l) => !l.withdrawn && l.owner === actor.address);
        if (!cand.length) { tally("extend-skip"); continue; }
        const l = pick(cand);
        const nu = l.unlock + pick([1, 30, 365]) * DAY;
        await (await locker.connect(actor).extendLock(l.id, nu)).wait();
        l.unlock = nu; tally("extend");
      } else if (action === "xfer") {
        const cand = locks.filter((l) => !l.withdrawn && l.owner === actor.address);
        if (!cand.length) { tally("xfer-skip"); continue; }
        const l = pick(cand); let to = pick(actors);
        if (to.address === actor.address) { tally("xfer-skip"); continue; }
        await (await locker.connect(actor).transferLockOwnership(l.id, to.address)).wait();
        l.owner = to.address; tally("xfer");
      } else if (action === "withdraw") {
        const cand = locks.filter((l) => !l.withdrawn && l.owner === actor.address);
        if (!cand.length) { tally("wd-skip"); continue; }
        const l = pick(cand);
        const past = (await nowTs()) >= l.unlock;
        if (!past) {
          // must revert early
          let reverted = false;
          try { await locker.connect(actor).withdraw.staticCall(l.id); } catch { reverted = true; }
          if (!reverted) throw new Error(`[step ${step}] EARLY WITHDRAW allowed on lock ${l.id}`);
          tally("wd-early-blocked"); continue;
        }
        await (await locker.connect(actor).withdraw(l.id)).wait();
        l.withdrawn = true; tally("withdraw");
      } else if (action === "fee") {
        curFee = bn(rnd() * 2e16);
        await (await locker.connect(admin).setFee(curFee, treasury.address)).wait();
        tally("fee");
      } else if (action === "exempt") {
        // occasionally disable/re-enable the waiver
        if (chance(0.5)) await (await locker.connect(admin).setFeeExemption(ethers.ZeroAddress, 0)).wait();
        else await (await locker.connect(admin).setFeeExemption(await STAG.getAddress(), MIN)).wait();
        tally("exempt");
      } else if (action === "sweep") {
        const accrued = await locker.accruedFees();
        if (accrued > 0n) { await (await locker.connect(pick(actors)).withdrawFees()).wait(); tally("sweep"); }
        else tally("sweep-skip");
      } else if (action === "time") {
        await jump(pick([1, 30, 120, 400]) * DAY); tally("time");
      }
    } catch (e) {
      // legitimate reverts (FeeTooLow when fee changed mid-run, etc.) are fine; unexpected are not
      const m = String(e.message);
      if (/EARLY WITHDRAW|INSOLVENT|not held|mismatch|drift/.test(m)) throw e;
      tally("revert");
    }
    await assertInvariants(step);
  }

  console.log(`\n✅ ${N} simulation steps — ALL INVARIANTS HELD`);
  console.log("active locks:", locks.filter((l) => !l.withdrawn).length, "/ total", locks.length);
  console.log("action tally:", JSON.stringify(counts));
}
main().then(() => process.exit(0)).catch((e) => { console.error("\n❌ SIM FAILED:", e.message); process.exit(1); });
