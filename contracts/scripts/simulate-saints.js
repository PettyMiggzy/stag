// Randomized invariant simulation for SherwoodSaints + SaintsSplitter.
//   npx hardhat run scripts/simulate-saints.js
// Random actors take random actions (pick-mint / free-mint / forward / rescue / royalty / config)
// against a shadow model; core invariants asserted after every step.
const { ethers } = require("hardhat");

const N = parseInt(process.env.SIM_RUNS || "400", 10);
let _s = (0x9e3779b9 ^ parseInt(process.env.SIM_SEED || "4663")) >>> 0;
const rnd = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 0x100000000; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const E = (n) => ethers.parseEther(String(n));

async function main() {
  const signers = await ethers.getSigners();
  const owner = signers[0], burnSink = signers[1], pool = signers[2], team = signers[3];
  const actors = signers.slice(4, 9);

  const saints = await (await ethers.getContractFactory("SherwoodSaints")).deploy(
    "https://stagwifhood.fun/assets/nft/saints/metadata/", owner.address, 500);
  const splitter = await (await ethers.getContractFactory("SaintsSplitter")).deploy(
    burnSink.address, pool.address, team.address, 6000, 3000);
  await saints.setSplitter(await splitter.getAddress());
  await saints.setMintActive(true);
  const SADDR = await saints.getAddress(), SPADDR = await splitter.getAddress();

  // shadow model
  const ownerOf = {};             // id -> actor address (minted)
  const mintedByPaid = {};        // addr -> paid count
  const freeLeft = {};            // addr -> free allowance
  let price = E("0.03"), maxPerWallet = 2n;
  let forwarded = 0n;             // total ETH pushed to splitter
  const counts = {};
  const tally = (k) => counts[k] = (counts[k] || 0) + 1;

  const assertInvariants = async (step) => {
    // 1) supply: at most 5, ids only 1..5, no dup — check on-chain ownerOf matches model
    let minted = 0;
    for (let id = 1; id <= 5; id++) {
      const chainOwner = await saints._ownerOf ? null : null; // use ownerOf via try
      let oc;
      try { oc = (await saints.ownerOf(id)).toLowerCase(); } catch { oc = null; }
      const mo = ownerOf[id] ? ownerOf[id].toLowerCase() : null;
      if (oc !== mo) throw new Error(`[${step}] ownerOf(${id}) chain ${oc} != model ${mo}`);
      if (oc) minted++;
    }
    if (minted > 5) throw new Error(`[${step}] supply ${minted} > 5`);
    if (Number(await saints.totalSupply()) !== minted) throw new Error(`[${step}] totalSupply mismatch`);
    // 2) contract ETH == (sum paid mints) - forwarded  == on-chain balance
    const bal = await ethers.provider.getBalance(SADDR);
    // model paid = price * number of PAID mints; free mints add 0
    // track via 'paidWei' accumulator instead — recompute:
    // (we track paidWei globally below)
    if (bal !== paidWei - forwarded) throw new Error(`[${step}] contract ETH ${bal} != paid-forwarded ${paidWei - forwarded}`);
    // 3) splitter never pools ETH (splits on arrival)
    if ((await ethers.provider.getBalance(SPADDR)) !== 0n) throw new Error(`[${step}] splitter holds ETH`);
    // 4) tokenURI has .json for a minted id
    for (let id = 1; id <= 5; id++) if (ownerOf[id]) {
      const u = await saints.tokenURI(id);
      if (!u.endsWith(`${id}.json`)) throw new Error(`[${step}] bad tokenURI ${u}`);
      break;
    }
  };

  let paidWei = 0n;

  for (let step = 0; step < N; step++) {
    const actor = pick(actors), a = actor.address;
    mintedByPaid[a] = mintedByPaid[a] || 0; freeLeft[a] = freeLeft[a] || 0;
    const action = pick(["mint","mint","mint","free-grant","free-mint","forward","rescue","price","maxwallet","royalty","split-eth"]);
    try {
      if (action === "mint") {
        const avail = [1,2,3,4,5].filter((id) => !ownerOf[id]);
        if (!avail.length) { tally("mint-soldout"); await assertInvariants(step); continue; }
        const id = pick(avail);
        const useFree = freeLeft[a] > 0;
        const overCap = !useFree && BigInt(mintedByPaid[a]) >= maxPerWallet;
        // pick a value: sometimes wrong to exercise reverts
        const val = useFree ? 0n : (rnd() < 0.15 ? price + 1n : price);
        if (overCap) {
          let rev = false; try { await saints.connect(actor).mintPick.staticCall(id, { value: val }); } catch { rev = true; }
          if (!rev) throw new Error(`[${step}] over-cap mint allowed`);
          tally("mint-cap-blocked"); await assertInvariants(step); continue;
        }
        if (!useFree && val !== price) {
          let rev = false; try { await saints.connect(actor).mintPick.staticCall(id, { value: val }); } catch { rev = true; }
          if (!rev) throw new Error(`[${step}] wrong-price mint allowed`);
          tally("mint-badprice-blocked"); await assertInvariants(step); continue;
        }
        await (await saints.connect(actor).mintPick(id, { value: val })).wait();
        ownerOf[id] = a;
        if (useFree) freeLeft[a]--; else { mintedByPaid[a]++; paidWei += price; }
        tally(useFree ? "mint-free" : "mint-paid");
      } else if (action === "free-grant") {
        const n = 1 + Math.floor(rnd() * 2);
        await (await saints.connect(owner).grantFreeMints(a, n)).wait();
        freeLeft[a] += n; tally("free-grant");
      } else if (action === "free-mint") {
        // handled by mint branch when freeLeft>0; here just no-op tally
        tally("noop");
      } else if (action === "forward") {
        const bal = await ethers.provider.getBalance(SADDR);
        if (bal === 0n) { tally("forward-empty"); }
        else {
          const b0 = await ethers.provider.getBalance(burnSink.address);
          const p0 = await ethers.provider.getBalance(pool.address);
          const t0 = await ethers.provider.getBalance(team.address);
          await (await saints.connect(pick(actors)).forwardProceeds()).wait();
          forwarded += bal;
          const b = (await ethers.provider.getBalance(burnSink.address)) - b0;
          const p = (await ethers.provider.getBalance(pool.address)) - p0;
          const t = (await ethers.provider.getBalance(team.address)) - t0;
          if (b + p + t !== bal) throw new Error(`[${step}] split sum ${b+p+t} != ${bal}`);
          if (b !== bal * 6000n / 10000n) throw new Error(`[${step}] burn share wrong ${b}`);
          if (p !== bal * 3000n / 10000n) throw new Error(`[${step}] pool share wrong ${p}`);
          tally("forward");
        }
      } else if (action === "rescue") {
        const bal = await ethers.provider.getBalance(SADDR);
        if (bal === 0n) { tally("rescue-empty"); }
        else {
          await (await saints.connect(owner).withdrawETH(team.address)).wait();
          forwarded += bal; // rescued out of the contract, same accounting effect
          tally("rescue");
        }
      } else if (action === "price") {
        price = E(pick(["0.02","0.03","0.05","0.1"]));
        await (await saints.connect(owner).setMintPrice(price)).wait(); tally("price");
      } else if (action === "maxwallet") {
        maxPerWallet = BigInt(1 + Math.floor(rnd() * 5));
        await (await saints.connect(owner).setMaxPerWallet(maxPerWallet)).wait(); tally("maxwallet");
      } else if (action === "royalty") {
        await (await saints.connect(owner).setRoyalty(owner.address, BigInt(Math.floor(rnd() * 1000)))).wait(); tally("royalty");
      } else if (action === "split-eth") {
        // send stray ETH directly to splitter — must fan out, never pool
        const b0 = await ethers.provider.getBalance(burnSink.address);
        const amt = E("0.01");
        await (await owner.sendTransaction({ to: SPADDR, value: amt })).wait();
        if ((await ethers.provider.getBalance(SPADDR)) !== 0n) throw new Error(`[${step}] splitter pooled stray ETH`);
        tally("split-eth");
      }
    } catch (e) {
      const m = String(e.message);
      if (/allowed|!=|> 5|mismatch|pooled|share wrong|split sum|bad tokenURI/.test(m)) throw e;
      tally("revert");
    }
    await assertInvariants(step);
  }

  console.log(`\n✅ ${N} simulation steps — ALL INVARIANTS HELD`);
  console.log("minted:", [1,2,3,4,5].filter((id) => ownerOf[id]).length, "/ 5");
  console.log("tally:", JSON.stringify(counts));
}
main().then(() => process.exit(0)).catch((e) => { console.error("\n❌ SIM FAILED:", e.message); process.exit(1); });
