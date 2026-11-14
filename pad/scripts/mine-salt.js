#!/usr/bin/env node
// OFF-CHAIN salt mining for the hook. Usage:
//   node scripts/mine-salt.js --eoa 0xDEPLOYER_EOA --nonce N [--pm 0x..] [--quote 0x..] [--out salt.json]
// Run `npx hardhat compile` first; the salt is only valid for exactly this compiled bytecode (do not recompile
// between mining and deploying, and deploy from the same EOA at the same nonce).
const fs = require("fs");
const { ethers } = require("ethers");
const { PM_DEFAULT, STAG_DEFAULT, hookInitCode, predictDeployer, mineSalt } = require("./lib");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; }
(async () => {
  const eoa = arg("eoa"), nonce = arg("nonce");
  if (!eoa || nonce === undefined) { console.error("need --eoa and --nonce"); process.exit(2); }
  const pm = ethers.getAddress(arg("pm", PM_DEFAULT)), quote = ethers.getAddress(arg("quote", STAG_DEFAULT));
  const art = require("../artifacts/contracts/PadHook.sol/PadHook.json");
  const dep = predictDeployer(ethers.getAddress(eoa), Number(nonce));
  const init = hookInitCode(art.bytecode, pm, dep, quote);
  const t = Date.now();
  const r = mineSalt(dep, init);
  const out = { deployer: dep, eoa, nonce: Number(nonce), pm, quote, salt: r.salt, hook: r.hook, tries: r.tries.toString(), initcodeHash: ethers.keccak256(init) };
  console.log(JSON.stringify(out, null, 2), `\n(${Date.now() - t} ms)`);
  const o = arg("out"); if (o) fs.writeFileSync(o, JSON.stringify(out, null, 2));
})();
