/* Shared config for the Hooded 20 mint + staking UI.
   After deploy, paste the addresses below ONCE (or set them in /admin, which stores
   overrides in localStorage). Every page (mint, stake, admin) reads from here. */
window.HOODED = {
  // ===== FILL AFTER DEPLOY =====
  mint: '',       // HoodedTwenty (0x…)  — empty => mint shows "coming soon"
  staking: '',    // StagStaking (0x…)
  splitter: '',   // RevenueSplitter (0x…)
  pact: '',       // SherwoodPact (0x…)
  // =============================
  stag: '0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49',
  chain: {
    chainId: '0x1237', // 4663 mainnet (testnet 46630 => '0xB626')
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
  },
  tiers: ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'],
  metaBase: 'assets/nft/stagwifhood',
};

// localStorage overrides (set by /admin) win over the hard-coded values above.
(function () {
  const g = (k) => localStorage.getItem('h20_' + k);
  ['mint', 'staking', 'splitter', 'pact'].forEach((k) => { const v = g(k); if (v) window.HOODED[k] = v; });
})();
