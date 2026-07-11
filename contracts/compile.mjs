#!/usr/bin/env node
// Minimal solc compile check with OpenZeppelin import resolution.
// Usage: node compile.mjs [File.sol ...]  (default: all top-level .sol here)
import solc from "solc";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(here).filter((f) => f.endsWith(".sol"));

const sources = {};
for (const f of targets) sources[f] = { content: readFileSync(resolve(here, f), "utf8") };

function findImports(path) {
  try {
    const p = path.startsWith("@") ? resolve(here, "node_modules", path) : resolve(here, path);
    return { contents: readFileSync(p, "utf8") };
  } catch (e) {
    return { error: "not found: " + path };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errs = (out.errors || []).filter((e) => e.severity === "error");
const warns = (out.errors || []).filter((e) => e.severity === "warning");

for (const w of warns) console.log("⚠️ ", w.formattedMessage.split("\n")[0]);
if (errs.length) {
  console.error("\n❌ COMPILE ERRORS:");
  for (const e of errs) console.error(e.formattedMessage);
  process.exit(1);
}
console.log("\n✅ compiled OK:");
for (const f of Object.keys(out.contracts || {})) {
  for (const [name, c] of Object.entries(out.contracts[f])) {
    const sz = (c.evm?.bytecode?.object?.length || 0) / 2;
    if (sz > 0) console.log(`   ${f}:${name}  (${sz} bytes${sz > 24576 ? "  ⚠️ OVER 24KB LIMIT" : ""})`);
  }
}
