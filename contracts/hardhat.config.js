require("dotenv").config(); // loads contracts/.env (gitignored) → process.env.DEPLOYER_KEY
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris", // avoid Cancun-only opcodes (MCOPY/TSTORE) on the L2 target
    },
  },
  paths: { sources: "./src", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    hardhat: {},
    rhmainnet: {
      url: process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
  // Blockscout uses an Etherscan-compatible API and needs no real key.
  etherscan: {
    apiKey: { rhmainnet: "blockscout" },
    customChains: [
      {
        network: "rhmainnet",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
