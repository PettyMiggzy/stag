require("@nomicfoundation/hardhat-toolbox");
module.exports = {
  solidity: { version: "0.8.26", settings: { evmVersion: "cancun", viaIR: true, optimizer: { enabled: true, runs: 200 } } },
  networks: { hardhat: { chainId: 4663, chains: { 4663: { hardforkHistory: { cancun: 0 } } }, allowUnlimitedContractSize: true, forking: { url: process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com", blockNumber: Number(process.env.RH_BLOCK || 0) || undefined }, accounts: { count: 6, accountsBalance: "1000000000000000000000" } } },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
};
