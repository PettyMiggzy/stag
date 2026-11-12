// The record launchpad. `contract` stays empty until the RecordStake contract is deployed; the page then shows "Opens soon".
// `goal` is the backing target shown on the meter for each record, in whole $STAG. It is only a display number: change it any time.
window.LAUNCH = { contract: "", stag: "0x67Ef4460A1280fBD9d31D6312FEd2Ce1EFd66305", rpc: "https://rpc.mainnet.chain.robinhood.com", api: "https://buybot.stagwifhood.fun",
  records: [
    { id: 11, title: "Who Got the Keys", by: "Winslow Bankz", cover: "/assets/whogotthekeys.webp", goal: 25000000 },
    { id: 10, title: "WYTE BOYZ", by: "Winslow Bankz feat. Jelly Roll & Pyrexx", cover: "/assets/covers/wyteboyz.jpg", goal: 25000000 }
  ] };
