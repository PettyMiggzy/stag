// Catalog contract on Robinhood Chain. Items are read from the chain, so new releases appear automatically.
// Songs 1-8 are only sold inside the Hood Rich album (#9), so they are not listed here. WYTE BOYZ (#10) is an exclusive single.
window.SONGS = { hide: [1,2,3,4,5,6,7,8,12], minPrice: { 11: "0.008", 13: "0.008" }, contract: "0x895c3c2cC2790Db976EB03b0Fae17EB5594aaCA4", rpc: "https://rpc.mainnet.chain.robinhood.com",
  songs: [
    { id: 9, title: "Hood Rich (album, 9 tracks)" }, { id: 10, title: "WYTE BOYZ (feat. Jelly Roll & Pyrexx)" }
  ] };
