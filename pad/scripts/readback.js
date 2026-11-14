#!/usr/bin/env node
// READBACK CHECKLIST: verifies a deployed system against the expectations. Read-only. Exit code 1 if anything fails.
//   RPC=https://rpc.mainnet.chain.robinhood.com DEPLOYER=0x.. MULTISIG=0x.. node scripts/readback.js
// (DEPLOYER is the PadDeployer address; everything else is read from it.) Optional: PM, QUOTE, EXPECT_OWNER_ACCEPTED=1.
const fs = require("fs"), path = require("path");
const { ethers } = require("ethers");
const { PM_DEFAULT, STAG_DEFAULT, FLAG_MASK, FLAGS } = require("./lib");

const ABI = {
  deployer: ["function hook() view returns (address)", "function factory() view returns (address)", "function battle() view returns (address)", "function admin() view returns (address)", "function multisig() view returns (address)"],
  hook: ["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function factory() view returns (address)", "function battle() view returns (address)", "function QUOTE() view returns (address)", "function poolManager() view returns (address)", "function platformOwed() view returns (uint256)", "function TAX_BPS() view returns (uint256)", "function MAX_BURN_IMPACT_TICKS() view returns (int24)", "function BURN_GAP() view returns (uint256)", "function FORCED_MIN_STEP() view returns (uint256)", "function info(bytes32) view returns (address creator,address token,bool registered,bool quoteIs0,bool war,bool locked,uint64 freezeAt,bool endSnapped,uint128 chestAtEnd,uint128 chest,uint128 creatorOwed,uint128 holderOwed,uint256 volume)"],
  factory: ["function hook() view returns (address)", "function quote() view returns (address)", "function pm() view returns (address)", "function SUPPLY() view returns (uint256)", "function LP_FEE() view returns (uint24)", "function SPACING() view returns (int24)", "function RANGE_TICKS() view returns (int24)", "function MIN_FDV() view returns (uint256)", "function MAX_FDV() view returns (uint256)", "function launchCount() view returns (uint256)", "function keyAt(uint256) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))"],
  battle: ["function hook() view returns (address)", "function OFFER_WINDOW() view returns (uint64)", "function MIN_DURATION() view returns (uint64)", "function MAX_DURATION() view returns (uint64)", "function count() view returns (uint256)"],
  erc20: ["function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"],
  pm: ["function balanceOf(address,uint256) view returns (uint256)"],
};

function immutableMask(contractName) {          // byte ranges of immutables in the runtime code (from the compiler output)
  // use the build that THIS contract's artifact points at (hardhat writes a .dbg.json next to each artifact), never "any build-info"
  const root = path.join(__dirname, "..", "artifacts", "contracts");
  let dbg = null;
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, contractName + ".dbg.json");
    if (fs.existsSync(f)) { dbg = f; break; }
  }
  if (!dbg) throw new Error("no artifact for " + contractName);
  const info = path.resolve(path.dirname(dbg), JSON.parse(fs.readFileSync(dbg, "utf8")).buildInfo);
  const j = JSON.parse(fs.readFileSync(info, "utf8"));
  for (const src of Object.keys(j.output.contracts)) {
    const c = j.output.contracts[src][contractName];
    if (c) return { code: "0x" + c.evm.deployedBytecode.object, refs: c.evm.deployedBytecode.immutableReferences || {} };
  }
  throw new Error("no build-info for " + contractName);
}
function sameRuntime(onchain, name) {
  const { code, refs } = immutableMask(name);
  const a = ethers.getBytes(onchain), b = ethers.getBytes(code);
  if (a.length !== b.length) return false;
  const skip = new Uint8Array(b.length);
  for (const id of Object.keys(refs)) for (const r of refs[id]) skip.fill(1, r.start, r.start + r.length);
  for (let i = 0; i < a.length; i++) if (!skip[i] && a[i] !== b[i]) return false;
  return true;
}

async function readback(provider, cfg) {
  const rows = [];
  const ck = (name, ok, detail = "") => rows.push({ name, ok: !!ok, detail });
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const pmAddr = cfg.pm || PM_DEFAULT, quote = cfg.quote || STAG_DEFAULT;
  const D = new ethers.Contract(cfg.deployer, ABI.deployer, provider);
  const hookA = await D.hook(), facA = await D.factory(), batA = await D.battle();
  const H = new ethers.Contract(hookA, ABI.hook, provider), F = new ethers.Contract(facA, ABI.factory, provider), B = new ethers.Contract(batA, ABI.battle, provider);
  const code = async (a) => provider.getCode(a);

  // 1. addresses and code
  for (const [n, a] of [["pool manager", pmAddr], ["quote token", quote], ["hook", hookA], ["factory", facA], ["battle", batA]]) ck(`${n} has code`, (await code(a)).length > 2, a);
  ck("hook address carries flags 0x28CC (low 14 bits)", (BigInt(hookA) & FLAG_MASK) === FLAGS, "0x" + (BigInt(hookA) & FLAG_MASK).toString(16));
  ck("hook runtime == compiled PadHook (immutables masked)", sameRuntime(await code(hookA), "PadHook"));
  ck("factory runtime == compiled PadFactory", sameRuntime(await code(facA), "PadFactory"));
  ck("battle runtime == compiled PadBattle", sameRuntime(await code(batA), "PadBattle"));
  ck("hook runtime fits 24576 bytes", ((await code(hookA)).length - 2) / 2 <= 24576);
  ck("factory runtime fits 24576 bytes", ((await code(facA)).length - 2) / 2 <= 24576);

  // 2. wiring, both directions
  ck("hook.poolManager == PM", eq(await H.poolManager(), pmAddr));
  ck("hook.QUOTE == STAG", eq(await H.QUOTE(), quote));
  ck("hook.factory == factory", eq(await H.factory(), facA));
  ck("hook.battle == battle", eq(await H.battle(), batA));
  ck("factory.hook == hook", eq(await F.hook(), hookA));
  ck("factory.quote == STAG", eq(await F.quote(), quote));
  ck("factory.pm == PM", eq(await F.pm(), pmAddr));
  ck("battle.hook == hook", eq(await B.hook(), hookA));
  ck("factory != battle", !eq(facA, batA));

  // 3. constants (what the code is supposed to say)
  ck("TAX_BPS 300", (await H.TAX_BPS()) === 300n);
  ck("MAX_BURN_IMPACT_TICKS 150", (await H.MAX_BURN_IMPACT_TICKS()) === 150n);
  ck("BURN_GAP 1h", (await H.BURN_GAP()) === 3600n);
  ck("FORCED_MIN_STEP 50,000 STAG", (await H.FORCED_MIN_STEP()) === ethers.parseEther("50000"));
  ck("SUPPLY 1e9 tokens", (await F.SUPPLY()) === ethers.parseEther("1000000000"));
  ck("LP_FEE 3000", (await F.LP_FEE()) === 3000n);
  ck("SPACING 60", (await F.SPACING()) === 60n);
  ck("RANGE_TICKS 69060 (multiple of 60)", (await F.RANGE_TICKS()) === 69060n && 69060n % 60n === 0n);
  ck("MIN_FDV 1,000,000 STAG", (await F.MIN_FDV()) === ethers.parseEther("1000000"));
  ck("MAX_FDV 1e30", (await F.MAX_FDV()) === 10n ** 30n);
  ck("battle OFFER_WINDOW 3d / MIN 1h / MAX 14d", (await B.OFFER_WINDOW()) === 259200n && (await B.MIN_DURATION()) === 3600n && (await B.MAX_DURATION()) === 1209600n);

  // 4. quote token sanity
  const Q = new ethers.Contract(quote, ABI.erc20, provider);
  ck("STAG decimals 18", (await Q.decimals()) === 18n);
  ck("STAG symbol", true, await Q.symbol().catch(() => "?"));

  // 5. ownership
  const owner = await H.owner(), pend = await H.pendingOwner();
  ck("deployer.multisig == expected multisig", eq(await D.multisig(), cfg.multisig), await D.multisig());
  if (cfg.ownerAccepted) {
    ck("hook.owner == multisig (accepted)", eq(owner, cfg.multisig), owner);
    ck("hook.pendingOwner == 0", eq(pend, ethers.ZeroAddress));
  } else {
    ck("hook.owner == PadDeployer (hand-over pending)", eq(owner, cfg.deployer), owner);
    ck("hook.pendingOwner == multisig", eq(pend, cfg.multisig), pend);
    rows.push({ name: "ACTION: multisig must now call hook.acceptOwner()", ok: true, detail: "then re-run with EXPECT_OWNER_ACCEPTED=1" });
  }
  ck("multisig has code (is a contract/Safe)", (await code(cfg.multisig)).length > 2, cfg.multisig);

  // 6. state: solvency over all launches (hook's ERC-6909 STAG >= platformOwed + sum(chest+creatorOwed+holderOwed))
  const n = Number(await F.launchCount());
  let owed = await H.platformOwed();
  const PMc = new ethers.Contract(pmAddr, ABI.pm, provider);
  for (let i = 0; i < n; i++) {
    const k = await F.keyAt(i);
    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
    const inf = await H.info(id);
    ck(`launch #${i} registered, hook is the key's hook`, inf.registered && eq(k.hooks, hookA));
    owed += inf.chest + inf.creatorOwed + inf.holderOwed;
  }
  const claims = await PMc.balanceOf(hookA, BigInt(quote));
  ck(`solvency: hook 6909 STAG ${claims} >= owed ${owed} (${n} launches)`, claims >= owed);
  ck("hook holds no real STAG", (await Q.balanceOf(hookA)) === 0n, String(await Q.balanceOf(hookA)));
  ck("factory holds no STAG", (await Q.balanceOf(facA)) === 0n);
  return rows;
}
module.exports = { readback };

if (require.main === module) {
  (async () => {
    const need = (k) => { if (!process.env[k]) { console.error("missing env " + k); process.exit(2); } return process.env[k]; };
    const provider = new ethers.JsonRpcProvider(need("RPC"));
    const rows = await readback(provider, { deployer: ethers.getAddress(need("DEPLOYER")), multisig: ethers.getAddress(need("MULTISIG")), pm: process.env.PM, quote: process.env.QUOTE, ownerAccepted: process.env.EXPECT_OWNER_ACCEPTED === "1" });
    let bad = 0;
    for (const r of rows) { console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`); if (!r.ok) bad++; }
    console.log(bad ? `\n${bad} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
    process.exit(bad ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
