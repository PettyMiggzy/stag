// same as hardhat.config.js but with the REAL contract-size and initcode-size limits (24576 / 49152) enforced
const base = require("./hardhat.config.js");
const c = JSON.parse(JSON.stringify(base));
c.networks.hardhat.allowUnlimitedContractSize = false;
c.solidity = base.solidity;
module.exports = c;
