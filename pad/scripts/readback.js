#!/usr/bin/env node
// READBACK CHECKLIST: verifies a deployed system against the expectations. Read-only. Exit code 1 if anything fails.
//   RPC=https://rpc.mainnet.chain.robinhood.com DEPLOYER=0x.. MULTISIG=0x.. node scripts/readback.js
// (DEPLOYER is the PadDeployer address.) Mainnet REQUIRES: RPC2 SALT_FILE DEPLOY_TX EXPECT_OWNERS EXPECT_THRESHOLD EXPECT_SINGLETON EXPECT_PROXY_CODEHASH EXPECT_SAFE_CREATION_TX EXPECT_MANIFEST_DIGEST. Also EXPECT_SAFE_FACTORY EXPECT_SINGLETON_CODEHASH EXPECT_FACTORY_CODEHASH. Optional: EXPECT_FALLBACK (+ EXPECT_FALLBACK_CODEHASH, required if a handler is set), EXPECT_OWNER_ACCEPTED=1. PM/QUOTE only on rehearsal chains. See README.
const fs = require("fs"), path = require("path");
const { ethers } = require("ethers");
const { PM_DEFAULT, STAG_DEFAULT, FLAG_MASK, FLAGS, probeSafe, safeChecks } = require("./lib");
const MAN = require("./manifest");

const ABI = {
  deployer: ["function hook() view returns (address)", "function factory() view returns (address)", "function battle() view returns (address)", "function multisig() view returns (address)"],
  hook: ["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwner()", "function factory() view returns (address)", "function battle() view returns (address)", "function QUOTE() view returns (address)", "function poolManager() view returns (address)", "function platformOwed() view returns (uint256)", "function TAX_BPS() view returns (uint256)", "function MAX_BURN_IMPACT_TICKS() view returns (int24)", "function BURN_GAP() view returns (uint256)", "function FORCED_MIN_STEP() view returns (uint256)", "function info(bytes32) view returns (address creator,address token,bool registered,bool quoteIs0,bool war,bool locked,uint64 freezeAt,bool endSnapped,uint128 chestAtEnd,uint128 chest,uint128 creatorOwed,uint128 holderOwed,uint256 volume)"],
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
  const pmAddr = cfg.allowOverrides ? (cfg.pm || PM_DEFAULT) : PM_DEFAULT, quote = cfg.allowOverrides ? (cfg.quote || STAG_DEFAULT) : STAG_DEFAULT;   // hard-coded: a fake PM/STAG must not be able to pass
  const warn = (name, ok, detail = "") => rows.push({ name, ok: true, warn: !ok, detail });
  const D = new ethers.Contract(cfg.deployer, ABI.deployer, provider);
  const hookA = await D.hook(), facA = await D.factory(), batA = await D.battle();
  const H = new ethers.Contract(hookA, ABI.hook, provider), F = new ethers.Contract(facA, ABI.factory, provider), B = new ethers.Contract(batA, ABI.battle, provider);
  const code = async (a) => provider.getCode(a);

  // 0. chain
  const net = await provider.getNetwork();
  ck("chainId == 4663 (Robinhood Chain)", cfg.allowAnyChain || net.chainId === 4663n, String(net.chainId));

  // 1. addresses and code
  for (const [n, a] of [["pool manager", pmAddr], ["quote token", quote], ["hook", hookA], ["factory", facA], ["battle", batA]]) ck(`${n} has code`, (await code(a)).length > 2, a);
  ck("hook address carries flags 0x28CC (low 14 bits)", (BigInt(hookA) & FLAG_MASK) === FLAGS, "0x" + (BigInt(hookA) & FLAG_MASK).toString(16));
  ck("PadDeployer runtime == compiled PadDeployer (immutables masked)", sameRuntime(await code(cfg.deployer), "PadDeployer"));
  ck("factory address == CREATE(deployer, nonce 2)", eq(ethers.getCreateAddress({ from: cfg.deployer, nonce: 2 }), facA), ethers.getCreateAddress({ from: cfg.deployer, nonce: 2 }));
  ck("battle address == CREATE(deployer, nonce 3)", eq(ethers.getCreateAddress({ from: cfg.deployer, nonce: 3 }), batA), ethers.getCreateAddress({ from: cfg.deployer, nonce: 3 }));
  if (cfg.salt) {
    ck("salt.json has initcodeHash", !!cfg.salt.initcodeHash);
    ck("DEPLOYER == CREATE(salt.eoa, salt.nonce)", eq(ethers.getCreateAddress({ from: cfg.salt.eoa, nonce: cfg.salt.nonce }), cfg.deployer), cfg.deployer);
    if (cfg.salt.initcodeHash) ck("hook address == CREATE2(deployer, salt, initcode hash) from salt.json", eq(ethers.getCreate2Address(cfg.deployer, cfg.salt.salt, cfg.salt.initcodeHash), hookA), hookA);
  } else ck("salt.json supplied (ties DEPLOYER to the operator's salt and proves the hook address)", !!cfg.dry);
  ck("hook runtime == compiled PadHook (immutables masked)", sameRuntime(await code(hookA), "PadHook"));
  ck("factory runtime == compiled PadFactory", sameRuntime(await code(facA), "PadFactory"));
  ck("battle runtime == compiled PadBattle", sameRuntime(await code(batA), "PadBattle"));
  const man = MAN.load();
  if (!man) ck("audited-manifest.json present (pins the audited build)", !!cfg.dry);
  else rows.push({ name: "manifest digest: compare with the value published out of band", ok: true, detail: ethers.keccak256(fs.readFileSync(MAN.FILE)) });
  if (man) for (const [n, a] of [["PadHook", hookA], ["PadFactory", facA], ["PadBattle", batA], ["PadDeployer", cfg.deployer]]) {
    const art = MAN.artifact(n);
    ck(`PINNED: ${n} runtime hash == audited manifest`, MAN.maskedHash(await code(a), art.refs) === man.runtime[n], a);
  }
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
    // prove the hook side will accept: simulate acceptOwner() as the multisig (this cannot prove the multisig can sign: rehearse a no-op transaction first)
    let sim = true; try { await provider.call({ from: cfg.multisig, to: hookA, data: new ethers.Interface(ABI.hook).encodeFunctionData("acceptOwner") }); } catch (e) { sim = false; }
    ck("simulated acceptOwner() from the multisig address succeeds", sim);
    rows.push({ name: "ACTION: multisig must now call hook.acceptOwner() promptly (until then the PadDeployer contract, which has no functions, is the owner)", ok: true, detail: "then re-run with EXPECT_OWNER_ACCEPTED=1" });
  }
  ck("multisig has code (is a contract/Safe)", (await code(cfg.multisig)).length > 2, cfg.multisig);
  const sc = await safeChecks(provider, cfg.multisig, { expectOwners: cfg.expectOwners, expectThreshold: cfg.expectThreshold, expectSingleton: cfg.expectSingleton, expectProxyCodehash: cfg.expectProxyCodehash, safeCreationTx: cfg.safeCreationTx, expectFactory: cfg.expectFactory, expectFallback: cfg.expectFallback, expectFallbackCodehash: cfg.expectFallbackCodehash, expectSingletonCodehash: cfg.expectSingletonCodehash, expectFactoryCodehash: cfg.expectFactoryCodehash, forbid: [hookA, facA, batA, cfg.deployer, pmAddr, quote].concat(cfg.salt && cfg.salt.eoa ? [cfg.salt.eoa] : []), dry: cfg.dry, allowNonSafe: cfg.allowNonSafeOwner });   // HARD requirement: a hand-over target that cannot sign would lock the owner role for good
  rows.push(...sc.rows);

  // 5b. the deployment transaction itself: its calldata must START WITH the pinned PadDeployer creation code (which embeds the hook/factory/battle
  //     creation code, constructors included) and END WITH the exact expected constructor args. Closes "same runtime, patched constructor".
  if (cfg.deployTx) {
    const tx = await provider.getTransaction(cfg.deployTx), rc = await provider.getTransactionReceipt(cfg.deployTx);
    ck("deploy tx found and succeeded", !!tx && !!rc && rc.status === 1);
    if (tx && rc) {
      const man = MAN.load();
      ck("deploy tx: from == salt.eoa, nonce == salt.nonce, to == null (plain creation)", !!cfg.salt && eq(tx.from, cfg.salt.eoa) && tx.nonce === Number(cfg.salt.nonce) && tx.to === null, `${tx.from} #${tx.nonce}`);
      ck("deploy tx created the DEPLOYER address", eq(rc.contractAddress || "", cfg.deployer), rc.contractAddress);
      const input = ethers.getBytes(tx.data);
      const want = ethers.getBytes(MAN.artifact("PadDeployer").creation);
      const head = ethers.keccak256(input.slice(0, want.length));
      ck("deploy tx calldata starts with the PINNED PadDeployer creation code (constructors of hook/factory/battle included)", !!man && head === man.deployerCreationCode, head);
      const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "bool", "bytes32"], [pmAddr, quote, cfg.multisig, true, cfg.salt ? cfg.salt.salt : ethers.ZeroHash]);
      ck("deploy tx constructor args == (PM, STAG, MULTISIG, mustBeContract=true, salt)", ethers.hexlify(input.slice(want.length)).toLowerCase() === args.toLowerCase());
    }
  } else ck("DEPLOY_TX supplied (the creation transaction is verified, not just the runtime code)", !!cfg.dry);
  // nothing may have been approved away from the system's contracts before launch
  rows.push({ name: "info: launches and battles so far", ok: true, info: true, detail: `${await F.launchCount()} launches, ${await B.count()} battles` });

  // 6. state: solvency over all launches (hook's ERC-6909 STAG >= platformOwed + sum(chest+creatorOwed+holderOwed)).
  //    Launches are permissionless, so the scan is batched, pinned to ONE block (a payout between reads cannot cause a false FAIL) and bounded by SCAN_MAX
  //    (default 300): above it the scan is skipped with a loud WARN and must be done by a monitor. Everything above (code, wiring, ownership, Safe) is O(1).
  const n = Number(await F.launchCount());
  const SCAN_MAX = Number(cfg.scanMax || 300);
  const PMc = new ethers.Contract(pmAddr, ABI.pm, provider);
  if (n > SCAN_MAX) {
    warn(`solvency scan SKIPPED: more launches than SCAN_MAX (raise SCAN_MAX or run a monitor)`, false, `${n} launches`);
  } else {
    const bn = await provider.getBlockNumber();
    const ov = { blockTag: bn };
    let owed = await H.platformOwed(ov), allReg = true;
    for (let i0 = 0; i0 < n; i0 += 20) {
      const idx = Array.from({ length: Math.min(20, n - i0) }, (_, j) => i0 + j);
      const infos = await Promise.all(idx.map(async (i) => {
        const k = await F.keyAt(i, ov);
        const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
        return { k, inf: await H.info(id, ov) };
      }));
      for (const { k, inf } of infos) { allReg = allReg && inf.registered && eq(k.hooks, hookA); owed += inf.chest + inf.creatorOwed + inf.holderOwed; }
    }
    ck("every launch is registered and uses this hook", allReg, `${n} launches`);
    const claims = await PMc.balanceOf(hookA, BigInt(quote), ov);
    ck("solvency: hook 6909 STAG >= platformOwed + sum(chest+creatorOwed+holderOwed)", claims >= owed, `claims ${claims} owed ${owed} at block ${bn}`);
  }
  warn("hook holds no real STAG (a 1-wei donation can make this warn; harmless)", (await Q.balanceOf(hookA)) === 0n, String(await Q.balanceOf(hookA)));
  warn("factory holds no STAG (a donation can make this warn; harmless)", (await Q.balanceOf(facA)) === 0n);
  return rows;
}
module.exports = { readback };

if (require.main === module) {
  (async () => {
    for (const k of Object.keys(process.env)) if (/^(EXPECT_|DEPLOY_TX|RPC2?$|SALT_FILE|DEPLOYER$|MULTISIG$)/.test(k)) process.env[k] = process.env[k].trim();
    const need = (k) => { if (!process.env[k]) { console.error("missing env " + k); process.exit(2); } return process.env[k]; };
    const provider = new ethers.JsonRpcProvider(need("RPC"));
    const p2 = process.env.RPC2 ? new ethers.JsonRpcProvider(process.env.RPC2) : null;
    const chainId = (await provider.getNetwork()).chainId, chain2 = p2 ? (await p2.getNetwork()).chainId : null;
    const real = chainId === 4663n || chain2 === 4663n;                 // either endpoint on the real chain => real: DRYRUN and all rehearsal shortcuts are ignored
    const dry = !!process.env.DRYRUN && !real;
    if ((process.env.PM || process.env.QUOTE) && !dry) { console.error("PM/QUOTE overrides are refused (rehearsal chains only): they are hard-coded on purpose"); process.exit(2); }
    if (real) for (const k of ["SALT_FILE", "RPC2", "EXPECT_OWNERS", "EXPECT_THRESHOLD", "EXPECT_SINGLETON", "EXPECT_PROXY_CODEHASH", "EXPECT_SAFE_CREATION_TX", "EXPECT_SAFE_FACTORY", "EXPECT_SINGLETON_CODEHASH", "EXPECT_FACTORY_CODEHASH", "DEPLOY_TX", "EXPECT_MANIFEST_DIGEST"]) if (!process.env[k]) { console.error(`${k} is required on mainnet`); process.exit(2); }
    const lb = (u) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);
    if (!lb(process.env.RPC) && new URL(process.env.RPC).protocol !== "https:") { console.error("RPC must be https (http only for a loopback rehearsal node)"); process.exit(2); }
    if (process.env.RPC2 && !lb(process.env.RPC2) && new URL(process.env.RPC2).protocol !== "https:") { console.error("RPC2 must be https"); process.exit(2); }
    if (process.env.DRYRUN && !(lb(process.env.RPC) && (!process.env.RPC2 || lb(process.env.RPC2)))) { console.error("DRYRUN is only honoured with loopback RPC URLs; unset it"); process.exit(2); }
    if (real && new URL(process.env.RPC).hostname.toLowerCase() === new URL(process.env.RPC2).hostname.toLowerCase()) { console.error("RPC2 must be on a different hostname than RPC"); process.exit(2); }
    const salt = process.env.SALT_FILE ? JSON.parse(fs.readFileSync(process.env.SALT_FILE, "utf8")) : null;
    const cfg = { deployer: ethers.getAddress(need("DEPLOYER")), multisig: ethers.getAddress(need("MULTISIG")), pm: process.env.PM, quote: process.env.QUOTE, scanMax: process.env.SCAN_MAX, dry, allowOverrides: dry, allowAnyChain: dry, allowNonSafeOwner: dry && process.env.ALLOW_NON_SAFE === "1",
      salt: salt ? { salt: salt.salt, initcodeHash: salt.initcodeHash, eoa: salt.eoa, nonce: salt.nonce } : null,
      expectOwners: process.env.EXPECT_OWNERS ? process.env.EXPECT_OWNERS.split(",").map((x) => ethers.getAddress(x.trim())) : null,
      expectThreshold: process.env.EXPECT_THRESHOLD, ownerAccepted: process.env.EXPECT_OWNER_ACCEPTED === "1", expectSingleton: process.env.EXPECT_SINGLETON, expectProxyCodehash: process.env.EXPECT_PROXY_CODEHASH, safeCreationTx: process.env.EXPECT_SAFE_CREATION_TX, expectFactory: process.env.EXPECT_SAFE_FACTORY, expectFallback: process.env.EXPECT_FALLBACK, expectFallbackCodehash: process.env.EXPECT_FALLBACK_CODEHASH, expectSingletonCodehash: process.env.EXPECT_SINGLETON_CODEHASH, expectFactoryCodehash: process.env.EXPECT_FACTORY_CODEHASH, deployTx: process.env.DEPLOY_TX };
    const rows = await readback(provider, cfg);
    if (p2) {                                                            // the WHOLE readback again on the second endpoint; any difference is a failure
      const rows2 = await readback(p2, cfg);
      const key = (r) => JSON.stringify([r.name, r.ok]);   // live balances differ between two reads; every ok/fail verdict must match
      const same = rows.length === rows2.length && rows.every((r, i) => key(r) === key(rows2[i]));
      rows.push({ name: "RPC2 produced the identical readback (every pass/fail verdict)", ok: same, detail: same ? "" : "RPC1 and RPC2 disagree: do not trust either until resolved" });
      const extra = [];
      if (!same) { const n = Math.max(rows.length - 1, rows2.length); for (let i = 0; i < n; i++) if (!rows[i] || !rows2[i] || key(rows[i]) !== key(rows2[i])) extra.push({ name: "DISAGREEMENT at: " + ((rows[i] || rows2[i]).name), ok: false, detail: "RPC1=" + (rows[i] ? rows[i].ok : "-") + " | RPC2=" + (rows2[i] ? rows2[i].ok : "-") }); }
      rows.push(...extra);
    } else rows.push({ name: "WARN no RPC2 set: a single endpoint is trusted (rehearsal only)", ok: true, warn: true, detail: "" });
    { const dg = MAN.load() ? ethers.keccak256(fs.readFileSync(MAN.FILE)) : null;
      if (process.env.EXPECT_MANIFEST_DIGEST || real) rows.push({ name: "manifest digest == EXPECT_MANIFEST_DIGEST (published with the audit report)", ok: !!dg && dg.toLowerCase() === String(process.env.EXPECT_MANIFEST_DIGEST || "").toLowerCase(), detail: String(dg) }); }
    let bad = 0;
    for (const r of rows) { console.log(`${r.warn ? "WARN" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + String(r.detail).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).slice(0, 300) + "]" : ""}`); if (!r.ok) bad++; }
    console.log(bad ? `\n${bad} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
    process.exit(bad ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
