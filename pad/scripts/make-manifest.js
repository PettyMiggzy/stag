#!/usr/bin/env node
// Writes audited-manifest.json from the CURRENT compile. Run `npx hardhat compile` first; commit the file together with the reviewed sources.
const fs = require("fs");
const M = require("./manifest");
const m = M.build();
fs.writeFileSync(M.FILE, JSON.stringify(m, null, 2) + "\n");
console.log(JSON.stringify(m, null, 2));
