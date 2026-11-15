#!/usr/bin/env node
// Verifies a deployed PadRouter (read-only). A verified-source match alone proves nothing: the constructor arguments are
// immutables, so a router built from the right source with wrong or hostile arguments looks identical. This checks them.
//   RPC=<https rpc> ROUTER=0x.. HOOK=0x.. node tools/verify-router.js
// Exit 0 only if every row passes. Needs the project compiled (npx hardhat compile) for the local build.
const { ethers } = require("ethers");
const { artifact, maskedHash } = require("../scripts/manifest");

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const STAG = "0x67Ef4460A1280fBD9d31D6312FEd2Ce1EFd66305";
const CURVE = "0x8e68043f7553ff7adf30eb8b0baac8d8fc2ed958";
const need = (k) => { if (!process.env[k]) { console.error("missing env " + k); process.exit(2); } return process.env[k].trim(); };

(async () => {
  const provider = new ethers.JsonRpcProvider(need("RPC"));
  const router = ethers.getAddress(need("ROUTER")), hook = ethers.getAddress(need("HOOK"));
  const rows = [];
  const ck = (name, ok, detail = "") => rows.push({ name, ok: !!ok, detail });
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  const net = await provider.getNetwork();
  ck("chain id == 4663 (a local fork keeps this id: use a real public RPC and compare the head block on an explorer)", net.chainId === 4663n, String(net.chainId));
  const code = await provider.getCode(router);
  ck("router has code", code.length > 2);
  const R = new ethers.Contract(router, ["function pm() view returns (address)", "function hook() view returns (address)", "function stag() view returns (address)", "function curve() view returns (address)"], provider);
  const H = new ethers.Contract(hook, ["function QUOTE() view returns (address)", "function poolManager() view returns (address)", "function factory() view returns (address)", "function owner() view returns (address)"], provider);
  const [rpm, rhook, rstag, rcurve] = await Promise.all([R.pm(), R.hook(), R.stag(), R.curve()]);
  ck("router.pm == the Uniswap v4 PoolManager", eq(rpm, PM), rpm);
  ck("router.hook == the PadHook you pass in HOOK", eq(rhook, hook), rhook);
  ck("router.stag == $STAG", eq(rstag, STAG), rstag);
  ck("router.curve == the $STAG curve", eq(rcurve, CURVE), rcurve);
  const [q, hpm] = await Promise.all([H.QUOTE(), H.poolManager()]);
  ck("hook.QUOTE == router.stag (the hook pairs the same $STAG)", eq(q, rstag), q);
  ck("hook.poolManager == router.pm", eq(hpm, rpm), hpm);
  ck("curve has code", (await provider.getCode(CURVE)).length > 2);

  // the runtime must equal the local build, with the four immutable address slots masked, and each slot must hold one of the four expected addresses
  const a = artifact("PadRouter");
  const onchain = ethers.getBytes(code), local = ethers.getBytes(a.runtime);
  ck("runtime length == local build", onchain.length === local.length, `${onchain.length} vs ${local.length}`);
  if (onchain.length === local.length) {
    ck("runtime (immutables masked) == local PadRouter build", maskedHash(code, a.refs) === maskedHash(a.runtime, a.refs));
    const want = [PM, hook, STAG, CURVE].map((x) => ethers.zeroPadValue(x, 32).toLowerCase());
    const found = new Set(); let slotsOk = true;
    for (const id of Object.keys(a.refs)) for (const r of a.refs[id]) {
      const w = ethers.hexlify(onchain.slice(r.start, r.start + r.length)).toLowerCase();
      if (!want.includes(w)) slotsOk = false; found.add(w);
    }
    ck("every immutable slot holds one of PM / HOOK / STAG / CURVE", slotsOk);
    ck("all four expected addresses appear in the immutable slots", want.every((w) => found.has(w)));
  }
  ck("router holds no ETH right now (informational: donations are stranded, never extractable)", (await provider.getBalance(router)) === 0n, String(await provider.getBalance(router)));

  let bad = 0;
  for (const r of rows) { console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + String(r.detail).slice(0, 120) + "]" : ""}`); if (!r.ok) bad++; }
  console.log(bad ? `\n${bad} CHECK(S) FAILED: do not publish this router address` : "\nALL CHECKS PASSED (also run a tiny swapExactIn and zapBuy from a funded, approved account before publishing)");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
