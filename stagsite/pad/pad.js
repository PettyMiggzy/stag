/* $STAG Pad front end. Plain browser JS + ethers v6 (global `ethers`). Reads the chain through a public RPC,
   writes through the visitor's own wallet. Nothing here holds keys or talks to a server of ours. */
(() => {
  const C = window.PAD || {};
  const E = window.ethers;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const LIVE = !!(C.live && C.hook && C.factory && C.battle && C.router);
  const KEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";

  const ABI = {
    factory: [
      "function launchCount() view returns (uint256)",
      `function keyAt(uint256) view returns (${KEY})`,
      "function MIN_FDV() view returns (uint256)",
      `function launch(string name,string symbol,uint256 startFdv,bool war) returns (${KEY} key,address token)`,
      `function collectFees(${KEY} key,address to) returns (uint256,uint256)`,
      "event Launched(bytes32 indexed id,address indexed creator,address token,uint256 startFdv,bool war,string name,string symbol)",
    ],
    hook: [
      "function info(bytes32) view returns (address creator,address token,bool registered,bool quoteIs0,bool war,bool locked,uint64 freezeAt,bool endSnapped,uint128 chestAtEnd,uint128 chest,uint128 creatorOwed,uint128 holderOwed,uint256 volume)",
      "function forced(bytes32) view returns (uint128)",
      "function lastBurn(bytes32) view returns (uint64)",
      `function setMode(${KEY} key,bool war)`,
      `function claimCreator(${KEY} key,address to)`,
      `function pushHolders(${KEY} key)`,
      `function burnChest(${KEY} key,uint256 minOut) returns (uint256)`,
      `function burnForced(${KEY} key,uint256 minOut) returns (uint256)`,
    ],
    battle: [
      "function count() view returns (uint256)",
      `function get(uint256) view returns (tuple(${KEY} a,${KEY} b,uint64 duration,uint64 offerExpiry,uint64 start,uint64 end,uint256 volA0,uint256 volB0,uint128 chestA0,uint128 chestB0,uint8 state))`,
      `function challenge(${KEY} a,${KEY} b,uint64 duration) returns (uint256)`,
      "function accept(uint256)",
      "function cancel(uint256)",
      "function settle(uint256)",
    ],
    router: [
      `function swapExactIn(${KEY} key,bool zeroForOne,uint256 amountIn,uint256 minOut,address to,uint256 deadline) returns (uint256)`,
      `function zapBuy(${KEY} key,uint256 minStag,uint256 minOut,address to,uint256 deadline) payable returns (uint256,uint256)`,
      `function zapSell(${KEY} key,uint256 tokensIn,uint256 minEth,address to,uint256 deadline) returns (uint256,uint256)`,
    ],
    erc20: [
      "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)", "function totalSupply() view returns (uint256)",
    ],
    padToken: ["function claimable(address) view returns (uint256)", "function claim()"],
    stateView: ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"],
    curve: ["function graduated() view returns (bool)"],
  };

  // ------------------------------------------------------------------ demo mode
  // /pad/?demo=1 fills every page with FAKE sample data so the layout can be reviewed before launch. Nothing is read from or sent to
  // the chain in demo mode: every button that would send a transaction only shows a "demo only" message. `&as=creator` previews the creator view.
  const DEMO = /[?&]demo=1(&|$)/.test(location.search);
  const ROLE = new URLSearchParams(location.search).get("as") === "creator" ? "creator" : "trader";
  const W18 = (n) => E.parseUnits(String(n), 18);
  const MOCK_CREATOR = "0xc0ffee254729296a45a3885639ac7e10f9d54979", MOCK_ME = "0xde30000000000000000000000000000000000001";
  const nowS = () => Math.floor(Date.now() / 1000);
  const mk = (i, name, symbol, war, o) => ({ i, key: null, id: "0x" + String(i).padStart(64, "0"), name, symbol, token: "0x" + String(0xa0 + i).padStart(2, "0").repeat(20), creator: o.creator || ("0x" + String(0xb0 + i).padStart(2, "0").repeat(20)), quoteIs0: true, war, locked: !!o.locked, chest: W18(o.chest || 0), creatorOwed: W18(o.cowed || 0), holderOwed: W18(o.howed || 0), volume: W18(o.vol), forced: W18(o.forced || 0), lastBurn: o.burn || 0, stagPerToken: o.price });
  const MOCK = DEMO ? [
    mk(0, "Stag Hood Coin", "SHC", true, { creator: MOCK_CREATOR, chest: 182400, cowed: 0, howed: 0, vol: 4210000, price: 0.01842, forced: 41200, burn: nowS() - 5400 }),
    mk(1, "Junk Junkies", "JNK", false, { vol: 1120000, price: 0.01131, cowed: 3840, howed: 7680 }),
    mk(2, "Winslow Bankz", "WBZ", true, { chest: 96300, vol: 2860000, price: 0.02407, locked: true }),
    mk(3, "Hood Rich", "HDR", true, { chest: 74100, vol: 2310000, price: 0.01526, locked: true }),
    mk(4, "Moon Mullet", "MUL", false, { vol: 640000, price: 0.00871, cowed: 920, howed: 1840 }),
    mk(5, "Robin Bank", "RBK", true, { creator: MOCK_CREATOR, chest: 12800, vol: 380000, price: 0.01018 }),
    mk(6, "Hood Cat", "HCT", true, { chest: 8100, vol: 215000, price: 0.01006 }),
  ] : [];
  const MOCK_BATTLES = DEMO ? [
    { id: 0, a: 0, b: 5, st: 3, dur: 86400 },
    { id: 1, a: 2, b: 3, st: 2, dur: 86400, endIn: 5 * 3600 + 1500, va: 1420000, vb: 1180000 },
    { id: 2, a: 6, b: 5, st: 1, dur: 43200, expIn: 2.1 * 86400 },
  ] : [];
  const demoHref = (h) => { if (!DEMO || !h || !h.startsWith("/pad/") || /[?&]demo=1/.test(h)) return h; const [path, hash] = h.split("#"); return path + (path.includes("?") ? "&" : "?") + "demo=1" + (ROLE === "creator" ? "&as=creator" : "") + (hash ? "#" + hash : ""); };
  const demoBanner = () => `<div class="padnote"><b>DEMO MODE: fake data.</b> These tokens, prices and battles are made up to show the layout. Nothing here is real, nothing is read from the chain and nothing can be sent. &nbsp; View as: <a href="${demoHref(location.pathname + location.search.replace(/&?as=creator/, "").replace(/\?&/, "?"))}">trader</a> · <a href="${location.pathname}${location.search.replace(/&?as=creator/, "").replace(/\?&/, "?")}${location.search.includes("?") ? "&" : "?"}as=creator">creator</a> · <a href="/pad/">leave demo</a></div>`;

  // ------------------------------------------------------------------ helpers
  // Time comes from the chain, not from the visitor's clock: a wrong clock on a phone must not expire a trade or hide a battle's end.
  let skewMs = 0;
  const nowSec = () => Math.floor((Date.now() + skewMs) / 1000);
  async function syncClock() { try { const b = await ro.getBlock("latest"); if (b) skewMs = b.timestamp * 1000 - Date.now(); } catch { /* keep the local clock */ } }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  const num = (wei, dp = 2) => {
    const n = Number(E.formatUnits(wei, 18));
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(1) + "K";
    if (n > 0 && n < 1) return n.toLocaleString(undefined, { maximumSignificantDigits: 4, maximumFractionDigits: 18 });
    return n.toLocaleString(undefined, { maximumFractionDigits: dp });
  };
  const ago = (t) => { const d = Math.max(0, nowSec() - t); return d < 90 ? d + "s" : d < 5400 ? Math.round(d / 60) + "m" : d < 129600 ? Math.round(d / 3600) + "h" : Math.round(d / 86400) + "d"; };
  const left = (t) => { const d = t - nowSec(); if (d <= 0) return "ended"; return d < 5400 ? Math.ceil(d / 60) + " min" : d < 129600 ? Math.round(d / 3600) + " h" : Math.round(d / 86400) + " d"; };
  const explorer = (type, v) => `${C.explorer || "https://robinhoodchain.blockscout.com"}/${type}/${v}`;
  const keyArr = (k) => [k[0], k[1], k[2], k[3], k[4]];
  const poolId = (k) => E.keccak256(E.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], keyArr(k)));

  const ro = new E.JsonRpcProvider(C.rpc, C.chainId, { staticNetwork: true });
  const c = (name, addr, runner) => new E.Contract(addr, ABI[name], runner || ro);
  const R = {
    factory: () => c("factory", C.factory), hook: () => c("hook", C.hook), battle: () => c("battle", C.battle),
    stateView: () => c("stateView", C.stateView), stag: () => c("erc20", C.stag),
  };


  // ------------------------------------------------------------------ motion
  // Drifting embers over a banner. Decorative only: pauses when the tab is hidden or the banner is off screen, and does nothing when the visitor asks for reduced motion.
  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function embers(host, opts = {}) {
    if (REDUCED || !host) return;
    const cv = document.createElement("canvas"); cv.className = "embers"; cv.setAttribute("aria-hidden", "true"); host.prepend(cv);
    const ctx = cv.getContext("2d"); let W2 = 0, H2 = 0, run = true, vis = true, parts = [];
    const cols = opts.cols || ["57,255,20", "255,200,60"], n = opts.n || 55, split = opts.split;
    const size = () => { const r = host.getBoundingClientRect(); const d = Math.min(2, window.devicePixelRatio || 1); W2 = cv.width = Math.max(1, r.width * d); H2 = cv.height = Math.max(1, r.height * d); cv.style.width = r.width + "px"; cv.style.height = r.height + "px"; };
    const mkp = (init) => { const x = Math.random() * W2; const c2 = split ? (x < W2 / 2 ? cols[0] : cols[1]) : cols[Math.random() < 0.6 ? 0 : 1]; return { x, y: init ? Math.random() * H2 : H2 + 10, r: (0.8 + Math.random() * 2.4) * (W2 > 900 ? 1.4 : 1), vy: 0.25 + Math.random() * 0.9, vx: (Math.random() - 0.5) * 0.35, ph: Math.random() * 6.28, a: 0.25 + Math.random() * 0.6, c: c2 }; };
    size(); for (let i = 0; i < n; i++) parts.push(mkp(true));
    const frame = (t) => { if (!run) return; requestAnimationFrame(frame); if (!vis || document.hidden) return; ctx.clearRect(0, 0, W2, H2);
      for (const q of parts) { q.y -= q.vy; q.x += q.vx + Math.sin(t / 900 + q.ph) * 0.25; if (q.y < -10) Object.assign(q, mkp(false)); const f = Math.min(1, (q.y / H2) * 1.4 + 0.15);
        ctx.beginPath(); ctx.fillStyle = `rgba(${q.c},${q.a * f})`; ctx.shadowColor = `rgba(${q.c},.9)`; ctx.shadowBlur = 8; ctx.arc(q.x, q.y, q.r, 0, 6.283); ctx.fill(); } };
    if ("IntersectionObserver" in window) new IntersectionObserver((e) => { vis = e[0].isIntersecting; }).observe(host);
    window.addEventListener("resize", size); requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ toast + modal
  let toastBox;
  // one toast per action: it is updated in place (confirm, sent, done) instead of stacking three lines per transaction
  function toast(msg, kind = "", keep = false) {
    if (!toastBox) { toastBox = document.createElement("div"); toastBox.className = "padtoast"; toastBox.setAttribute("role", "status"); toastBox.setAttribute("aria-live", "polite"); document.body.appendChild(toastBox); }
    const t = document.createElement("div"); t.className = "pt " + kind; t.textContent = msg; toastBox.appendChild(t);
    if (!keep) setTimeout(() => t.remove(), kind === "err" ? 9000 : 5000);
    return t;
  }
  function upd(t, msg, kind = "", done = false) { t.className = "pt " + kind; t.textContent = msg; if (done) setTimeout(() => t.remove(), kind === "err" ? 9000 : 5000); }
  function confirmModal(title, html, okLabel = "I understand, continue") {
    return new Promise((res) => {
      const b = document.createElement("div"); b.className = "padmodal"; b.setAttribute("role", "dialog"); b.setAttribute("aria-modal", "true");
      b.innerHTML = `<div class="pm"><h3>${esc(title)}</h3><div class="pmb">${html}</div><div class="pmc"><button class="btn" data-x="0">Cancel</button><button class="btn solid" data-x="1">${esc(okLabel)}</button></div></div>`;
      b.addEventListener("click", (e) => { const x = e.target.closest("[data-x]"); if (x) { b.remove(); res(x.dataset.x === "1"); } });
      document.body.appendChild(b); $("button.solid", b).focus();
    });
  }

  // ------------------------------------------------------------------ wallet
  const W = { provider: null, signer: null, account: null };
  async function connect() {
    if (DEMO) { W.account = ROLE === "creator" ? MOCK_CREATOR : MOCK_ME; W.provider = ro; renderWallet(); document.dispatchEvent(new CustomEvent("pad:wallet", { detail: W.account })); return W.account; }
    if (!window.ethereum) { toast("No wallet found. Install a wallet (MetaMask, Rabby, Coinbase Wallet) and reload.", "err"); return null; }
    try {
      const eth = window.ethereum;
      await eth.request({ method: "eth_requestAccounts" });
      const hex = "0x" + Number(C.chainId).toString(16);
      if ((await eth.request({ method: "eth_chainId" })) !== hex) {
        try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
        catch (e) {
          await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [C.rpc], blockExplorerUrls: [C.explorer] }] });
        }
      }
      W.provider = new E.BrowserProvider(eth, C.chainId);
      const net = await W.provider.getNetwork();
      if (Number(net.chainId) !== Number(C.chainId)) { toast("Wrong network. Switch your wallet to Robinhood Chain (4663).", "err"); return null; }
      W.signer = await W.provider.getSigner(); W.account = await W.signer.getAddress();
      renderWallet(); document.dispatchEvent(new CustomEvent("pad:wallet", { detail: W.account }));
      return W.account;
    } catch (e) { toast(errMsg(e), "err"); return null; }
  }
  function renderWallet() { $$("[data-wallet]").forEach((b) => { b.textContent = W.account ? short(W.account) : "Connect wallet"; b.classList.toggle("solid", !W.account); }); }
  function errMsg(e) {
    const m = (e && (e.shortMessage || e.reason || e.message)) || String(e);
    if (/user rejected|denied|ACTION_REJECTED/i.test(m)) return "Cancelled in your wallet.";
    const map = { Locked: "This pool is locked by a battle.", NothingToDo: "Nothing to do right now.", BurnTooSoon: "A burn already happened in the last hour. Try again later.", NotAllowed: "Your wallet is not allowed to do that.", Slippage: "Price moved more than your slippage limit. Try again or raise slippage.", PartialFill: "The pool could not fill the whole amount. Try a smaller amount.", Expired: "Transaction expired. Try again." };
    for (const k of Object.keys(map)) if (m.includes(k)) return map[k];
    return m.length > 220 ? m.slice(0, 220) + "…" : m;
  }
  async function send(label, fn) {
    if (DEMO) { toast(label + ": demo only. Nothing was sent.", ""); return null; }
    if (!W.signer && !(await connect())) return null;
    try {
      var t = toast(label + ": confirm in your wallet…", "", true);
      const tx = await fn(W.signer);
      upd(t, label + ": sent, waiting…");
      const rc = await tx.wait();
      upd(t, label + ": done.", "ok", true);
      return rc;
    } catch (e) { if (typeof t !== "undefined") upd(t, label + " failed: " + errMsg(e), "err", true); else toast(label + " failed: " + errMsg(e), "err"); return null; }
  }
  const deadline = () => nowSec() + 20 * 60;

  // ------------------------------------------------------------------ data
  async function launchCount() { return DEMO ? MOCK.length : Number(await R.factory().launchCount()); }
  async function pool(i) {
    if (DEMO) { if (!MOCK[i]) throw new Error("No such token."); return MOCK[i]; }
    const f = R.factory(), h = R.hook();
    const k = keyAt0(await f.keyAt(i)); const id = poolId(k);
    const inf = await h.info(id);
    const tok = c("erc20", inf.token);
    const [name, symbol, sl0, forced, lastBurn] = await Promise.all([tok.name(), tok.symbol(), R.stateView().getSlot0(id).catch(() => null), h.forced(id), h.lastBurn(id)]);
    const quoteIs0 = inf.quoteIs0; let stagPerToken = null;
    if (sl0) { const s = Number(sl0[0]) / 2 ** 96, p = s * s; stagPerToken = quoteIs0 ? 1 / p : p; }
    return { i, key: k, id, name, symbol, token: inf.token, creator: inf.creator, quoteIs0, war: inf.war, locked: inf.locked, chest: inf.chest, creatorOwed: inf.creatorOwed, holderOwed: inf.holderOwed, volume: inf.volume, forced, lastBurn: Number(lastBurn), stagPerToken };
  }
  const keyAt0 = (k) => ({ 0: k[0], 1: k[1], 2: k[2], 3: k[3], 4: k[4], currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] });
  const fdvOf = (p) => (p.stagPerToken == null ? null : p.stagPerToken * 1e9);
  const price = (p) => (p.stagPerToken == null ? "n/a" : p.stagPerToken < 1e-4 ? p.stagPerToken.toExponential(2) : p.stagPerToken.toLocaleString(undefined, { maximumSignificantDigits: 4 }));
  // Card art: decorative only. Demo uses the local sample pictures; real tokens have no picture yet, so show their initials on a tint taken from the token id.
  const ART = ["a-green", "a-chest", "a-lantern", "a-gold", "a-ridge"];
  const artHtml = (p) => DEMO ? `<div class="art" style="background-image:url(/pad/assets/${ART[p.i % ART.length]}.webp)" aria-hidden="true"></div>` : `<div class="art ini" style="--h:${(parseInt(String(p.id).slice(2, 8), 16) || 0) % 360}" aria-hidden="true"><span>${esc(String(p.symbol || "?").slice(0, 3).toUpperCase())}</span></div>`;
  const modeChip = (p) => `<span class="chip ${p.war ? "" : "soon"}">${p.war ? "War" : "Peace"}${p.locked ? " · locked in battle" : ""}</span>`;

  function notLiveBanner() {
    if (DEMO) return demoBanner();
    if (LIVE) return "";
    return `<div class="padnote"><b>Not live yet.</b> The contracts are being finished and checked. Nothing on this page can spend your funds until the addresses are announced in <a href="https://t.me/StagWifHood" rel="noopener">Telegram</a>.</div>`;
  }

  // ------------------------------------------------------------------ pages
  const pages = {};

  pages.home = async () => {
    embers($(".hero"), { n: 45 });
    const box = $("#padlist"), stats = $("#padstats");
    if (!LIVE && !DEMO) { box.innerHTML = `<p class="muted">No launches yet. This page lists every token launched through the pad once it is live.</p>`; return; }
    try {
      const n = await launchCount(), nb = DEMO ? MOCK_BATTLES.length : Number(await R.battle().count());
      stats.innerHTML = `<span><b>${n}</b> launches</span><span><b>${nb}</b> battles</span><span><b>Robinhood</b> Chain</span>`;
      if (!n) { box.innerHTML = `<p class="muted">No launches yet. <a href="/pad/launch/">Be the first.</a></p>`; return; }
      const idx = []; for (let i = Math.max(0, n - 24); i < n; i++) idx.push(i);
      const ps = (await Promise.all(idx.map((i) => pool(i).catch(() => null)))).filter(Boolean).reverse();
      box.innerHTML = ps.map((p) => `<a class="card padcard ${p.war ? "war" : "peace"}" href="${demoHref("/pad/token/?i=" + p.i)}">${artHtml(p)}<div class="b"><div class="row">${modeChip(p)}<span class="muted">#${p.i}</span></div><h3>${esc(p.name)} <small>$${esc(p.symbol)}</small></h3><div class="kv"><span>Price</span><b>${price(p)} STAG</b></div><div class="kv"><span>Volume</span><b>${num(p.volume)} STAG</b></div><div class="kv"><span>War chest</span><b>${num(p.chest)} STAG</b></div></div></a>`).join("");
    } catch (e) { box.innerHTML = `<p class="muted">Could not load launches: ${esc(errMsg(e))}</p>`; }
  };

  pages.launch = async () => {
    const form = $("#launchform"); if (!form) return;
    const btn = $("#launchgo"); btn.disabled = !LIVE && !DEMO;
    const modeInfo = $("#modeinfo");
    const showMode = () => { const war = form.mode.value === "war"; $$(".tabs .tab", form).forEach((l) => l.classList.toggle("on", l.querySelector("input").checked)); modeInfo.innerHTML = war ? "<b>War:</b> the 3% tax on buys builds a war chest. You can burn it, or put it up in a battle. Nothing from buy tax goes to you or to holders." : "<b>Peace:</b> the 3% tax on buys pays 1% to you and 2% to everyone holding the token, in proportion to what they hold. No war chest builds, and you cannot enter battles while in peace (switch to war first)."; };
    form.addEventListener("change", showMode); showMode();
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault(); if (!LIVE && !DEMO) return;
      const name = form.tname.value.trim(), sym = form.tsym.value.trim(), fdvStr = form.fdv.value.trim(), war = form.mode.value === "war";
      if (!/^[A-Za-z0-9 ._+!?:#-]{1,32}$/.test(name)) return toast("Name: 1 to 32 letters, numbers, spaces or . _ - + ! ? : #", "err");
      if (!/^[A-Za-z0-9 ._+!?:#-]{1,12}$/.test(sym)) return toast("Symbol: 1 to 12 letters, numbers or . _ - + ! ? : #", "err");
      let fdv; try { fdv = E.parseUnits(fdvStr, 18); } catch { return toast("Starting value must be a number.", "err"); }
      const min = DEMO ? W18(1000000) : await R.factory().MIN_FDV(); if (fdv < min) return toast("Starting value must be at least " + num(min) + " STAG.", "err");
      const ok = await confirmModal("Launch " + name + "?", `<ul class="plain"><li>The whole supply (1,000,000,000 tokens) goes into a pool with $STAG. You receive no tokens and no free allocation.</li><li>The liquidity is locked by the contract: nobody, including you and us, can pull it out.</li><li>You earn the pool's 0.30% LP fee on every trade, and you can collect it any time.</li><li>Mode: <b>${war ? "War" : "Peace"}</b>. You can change it later unless a battle holds the pool.</li><li>Launching is final. You cannot rename or delete the token.</li></ul>`, "Launch token");
      if (!ok) return;
      btn.disabled = true;
      const rc = await send("Launch", (s) => c("factory", C.factory, s).launch(name, sym, fdv, war));
      btn.disabled = false; if (!rc) return;
      try { const ev = rc.logs.map((l) => { try { return c("factory", C.factory).interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Launched"); if (ev) { const n = await launchCount(); location.href = "/pad/token/?i=" + (n - 1); } }
      catch { /* stay on page */ }
    });
  };

  pages.token = async () => {
    const root = $("#tokroot"); const i = Number(new URLSearchParams(location.search).get("i"));
    if (!LIVE && !DEMO) { root.innerHTML = `<p class="muted">Token pages appear here once the pad is live.</p>`; return; }
    if (!Number.isInteger(i) || i < 0) { root.innerHTML = `<p class="muted">Pick a token from the <a href="/pad/">pad</a>.</p>`; return; }
    let p; try { if (i >= (await launchCount())) throw new Error("No such token."); p = await pool(i); } catch (e) { root.innerHTML = `<p class="muted">Could not load this token: ${esc(errMsg(e))}</p>`; return; }
    document.title = `${p.symbol} | $STAG Pad`;
    const stag = C.stag, tok = c("erc20", p.token), stagC = R.stag();
    const zeroForOneBuy = p.quoteIs0;
    root.innerHTML = `
      <div class="row"><h1 class="sec-h" style="margin:0">${esc(p.name)} <small>$${esc(p.symbol)}</small></h1>${modeChip(p)}</div>
      <p class="muted">Token <a href="${explorer("address", p.token)}" rel="noopener">${short(p.token)}</a> · creator <a href="${explorer("address", p.creator)}" rel="noopener">${short(p.creator)}</a> · pool #${p.i}. The creator can switch between war and peace at any time while no battle holds the pool.</p>
      <div class="padstats2"><div><span>Price</span><b>${price(p)} STAG</b></div><div><span>Market value</span><b>${fdvOf(p) == null ? "n/a" : num(E.parseUnits(String(Math.round(fdvOf(p))), 18)) + " STAG"}</b></div><div><span>Volume</span><b>${num(p.volume)} STAG</b></div><div><span>War chest</span><b>${num(p.chest)} STAG</b></div></div>
      <div class="grid two padgrid">
        <section class="padbox"><h3>Trade</h3>
          <div class="tabs" role="tablist"><button class="tab on" data-m="buy">Buy</button><button class="tab" data-m="sell">Sell</button></div>
          <label class="lbl" id="paylbl">Pay with</label><select id="payas" class="inp"></select>
          <label class="lbl" for="amt">Amount</label><input id="amt" class="inp" inputmode="decimal" placeholder="0.0" autocomplete="off">
          <label class="lbl" for="slip">Slippage limit (%)</label><input id="slip" class="inp" inputmode="decimal" value="2">
          <div class="quote" id="quote">Enter an amount.</div><p class="fine" id="slipwarn" hidden>High slippage: a bot can profit by moving the price against you up to this limit. Use the lowest setting that works.</p>
          <div class="cta"><button class="btn" id="approveBtn" hidden>Approve</button><button class="btn solid" id="tradeBtn">Connect wallet</button></div>
          <p class="fine">Every trade pays a 3% tax on its $STAG side (see <a href="/pad/how/">how it works</a>). Prices move with trades and this token can lose most or all of its value. Amounts shown are estimates until your wallet confirms.</p>
        </section>
        <section class="padbox"><h3>You</h3><div id="mine" class="muted">Connect a wallet to see your balances.</div></section>
      </div>
      <section class="padbox" id="creatorbox" hidden><h3>Creator tools</h3><div id="creatortools"></div></section>
      <section class="padbox"><h3>Anyone can</h3><div id="anyone"></div></section>`;

    let mode = "buy"; const payas = $("#payas"), amt = $("#amt"), quoteEl = $("#quote"), tradeBtn = $("#tradeBtn"), approveBtn = $("#approveBtn"), slipEl = $("#slip");
    // once the $STAG curve has graduated its ETH zaps revert, so the ETH options are hidden (trading with $STAG always works)
    let curveLive = true; if (!DEMO) { try { curveLive = !(await c("curve", C.curve).graduated()); } catch { curveLive = true; } }
    const opts = () => { if (!curveLive) { payas.innerHTML = mode === "buy" ? `<option value="stag">$STAG</option>` : `<option value="stag">Receive $STAG</option>`; $("#paylbl").textContent = mode === "buy" ? "Pay with" : "Receive as"; return; } payas.innerHTML = mode === "buy" ? `<option value="stag">$STAG</option><option value="eth">ETH (zaps through the $STAG curve)</option>` : `<option value="stag">Receive $STAG</option><option value="eth">Receive ETH (through the $STAG curve)</option>`; $("#paylbl").textContent = mode === "buy" ? "Pay with" : "Receive as"; };
    opts();
    $$(".tab").forEach((t) => t.addEventListener("click", () => { mode = t.dataset.m; $$(".tab").forEach((x) => x.classList.toggle("on", x === t)); opts(); refresh(); }));
    // Any change to the inputs immediately disables the trade button and drops the old quote, so a click can never run a stale amount;
    // `seq` makes slow, older quote requests discard their results if a newer one has started.
    let ctx = null, seq = 0; // ctx: what the trade button will do
    const invalidate = () => { seq++; ctx = null; approveBtn.hidden = true; tradeBtn.disabled = true; if (W.account) quoteEl.textContent = "Updating quote…"; };
    $$(".tab").forEach((t) => t.addEventListener("click", invalidate));
    [payas, amt, slipEl].forEach((el) => el.addEventListener("input", () => { invalidate(); clearTimeout(refresh.t); refresh.t = setTimeout(refresh, 350); }));
    async function refresh() {
      $("#slipwarn").hidden = !(Number(slipEl.value) > 5);
      const my = ++seq, stale = () => my !== seq;
      ctx = null; approveBtn.hidden = true; tradeBtn.disabled = true;
      tradeBtn.textContent = W.account ? (mode === "buy" ? "Buy" : "Sell") : "Connect wallet";
      if (!W.account) { tradeBtn.disabled = false; quoteEl.textContent = "Connect your wallet to get a quote."; return; }
      let a; try { a = E.parseUnits(amt.value || "0", 18); } catch { quoteEl.textContent = "Amount must be a number."; return; }
      if (a <= 0n) { quoteEl.textContent = "Enter an amount."; return; }
      const slip = Number(slipEl.value); if (!(slip >= 0.01 && slip <= 20)) { quoteEl.textContent = "Slippage must be between 0.01 and 20."; return; }
      if (DEMO) {   // sample quote from the sample price: no chain calls
        const px = p.stagPerToken, asE = payas.value === "eth", af = Number(amt.value);
        if (mode === "buy") { const stag = asE ? af * 3000 : af; const out = (stag * 0.97) / px; quoteEl.innerHTML = `(demo numbers) You get about <b>${out.toLocaleString(undefined, { maximumFractionDigits: 0 })} $${esc(p.symbol)}</b> after the 3% tax${asE ? " (sample rate: 1 ETH = 3,000 STAG)" : ""}.`; }
        else { const stag = af * px * 0.97; quoteEl.innerHTML = payas.value === "eth" ? `(demo numbers) You get about <b>${(stag / 3000).toLocaleString(undefined, { maximumSignificantDigits: 4 })} ETH</b> after the 3% tax and the curve's fees (sample rate: 1 ETH = 3,000 STAG).` : `(demo numbers) You get about <b>${stag.toLocaleString(undefined, { maximumFractionDigits: 2 })} $STAG</b> after the 3% tax.`; }
        ctx = { run: null, label: mode === "buy" ? "Buy" : "Sell" }; tradeBtn.disabled = false; return;
      }
      const bps = BigInt(Math.round(slip * 100)), asEth = payas.value === "eth", me = W.account, dl = deadline();
      const rc = c("router", C.router, W.provider);
      try {
        if (mode === "buy" && asEth) {
          const bal = await W.provider.getBalance(me); if (stale()) return; if (bal < a) { quoteEl.textContent = "Not enough ETH."; return; }
          const [, out] = await rc.zapBuy.staticCall(p.key, 1, 1, me, dl, { value: a, from: me }); if (stale()) return;
          const min = (out * (10000n - bps)) / 10000n;
          quoteEl.innerHTML = `You get about <b>${num(out)} $${esc(p.symbol)}</b> (at least ${num(min)}).`;
          // protect the curve leg too: expected STAG is unknown to the page, so the final minimum on the token carries the protection
          ctx = { run: (s) => c("router", C.router, s).zapBuy(p.key, 1, min, me, deadline(), { value: a }), label: "Buy" };
        } else if (mode === "buy") {
          const [bal, al] = await Promise.all([stagC.balanceOf(me), stagC.allowance(me, C.router)]); if (stale()) return;
          if (bal < a) { quoteEl.textContent = "Not enough $STAG."; return; }
          if (al < a) { approveBtn.hidden = false; approveBtn.textContent = "Approve $STAG"; approveBtn.onclick = () => approve(stag, a); quoteEl.textContent = "Approve $STAG for the router first."; return; }
          const out = await rc.swapExactIn.staticCall(p.key, zeroForOneBuy, a, 1, me, dl, { from: me }); if (stale()) return;
          const min = (out * (10000n - bps)) / 10000n;
          quoteEl.innerHTML = `You get about <b>${num(out)} $${esc(p.symbol)}</b> (at least ${num(min)}), after the 3% tax.`;
          ctx = { run: (s) => c("router", C.router, s).swapExactIn(p.key, zeroForOneBuy, a, min, me, deadline()), label: "Buy" };
        } else {
          const [bal, al] = await Promise.all([tok.balanceOf(me), tok.allowance(me, C.router)]); if (stale()) return;
          if (bal < a) { quoteEl.textContent = "You do not hold that many $" + p.symbol + "."; return; }
          if (al < a) { approveBtn.hidden = false; approveBtn.textContent = "Approve $" + p.symbol; approveBtn.onclick = () => approve(p.token, a); quoteEl.textContent = "Approve $" + p.symbol + " for the router first."; return; }
          if (asEth) {
            const [, eth] = await rc.zapSell.staticCall(p.key, a, 1, me, dl, { from: me }); if (stale()) return;
            const min = (eth * (10000n - bps)) / 10000n;
            quoteEl.innerHTML = `You get about <b>${num(eth, 6)} ETH</b> (at least ${num(min, 6)}), after the 3% tax and the curve's fees.`;
            ctx = { run: (s) => c("router", C.router, s).zapSell(p.key, a, min, me, deadline()), label: "Sell" };
          } else {
            const out = await rc.swapExactIn.staticCall(p.key, !zeroForOneBuy, a, 1, me, dl, { from: me }); if (stale()) return;
            const min = (out * (10000n - bps)) / 10000n;
            quoteEl.innerHTML = `You get about <b>${num(out)} $STAG</b> (at least ${num(min)}), after the 3% tax.`;
            ctx = { run: (s) => c("router", C.router, s).swapExactIn(p.key, !zeroForOneBuy, a, min, me, deadline()), label: "Sell" };
          }
        }
        tradeBtn.disabled = false;
      } catch (e) { if (!stale()) quoteEl.textContent = "Could not quote this trade: " + errMsg(e); }
    }
    async function approve(token, a) { const rc = await send("Approve", (s) => c("erc20", token, s).approve(C.router, a)); if (rc) refresh(); }
    tradeBtn.addEventListener("click", async () => {
      if (!W.account) { await connect(); await refresh(); await mine(); return; }
      if (!ctx) return refresh();
      const traded = amt.value;
      tradeBtn.disabled = true; const rc = await send(ctx.label, ctx.run); tradeBtn.disabled = false;
      if (rc) { if (amt.value === traded) amt.value = ""; await mine(); refresh(); }   // never wipe an amount the user has already started typing for the next trade
    });

    async function mine() {
      const m = $("#mine"); if (!W.account) { m.textContent = "Connect a wallet to see your balances."; return; }
      if (DEMO) { m.innerHTML = `<div class="kv"><span>$STAG</span><b>12,500</b></div><div class="kv"><span>$${esc(p.symbol)}</span><b>840,000</b></div><div class="kv"><span>ETH</span><b>0.84</b></div><div class="kv"><span>Holder payout waiting</span><b>38.2 STAG</b></div><div class="cta"><button class="btn solid" id="claimBtn">Claim payout</button></div>`; const cb0 = $("#claimBtn"); if (cb0) cb0.onclick = () => send("Claim", null); return; }
      const me = W.account, pt = c("padToken", p.token);
      const [sb, tb, eb, cl] = await Promise.all([stagC.balanceOf(me), tok.balanceOf(me), (W.provider || ro).getBalance(me), pt.claimable(me).catch(() => 0n)]);
      m.innerHTML = `<div class="kv"><span>$STAG</span><b>${num(sb)}</b></div><div class="kv"><span>$${esc(p.symbol)}</span><b>${num(tb)}</b></div><div class="kv"><span>ETH</span><b>${num(eb, 5)}</b></div>${cl > 0n ? `<div class="kv"><span>Holder payout waiting</span><b>${num(cl)} STAG</b></div><div class="cta"><button class="btn solid" id="claimBtn">Claim payout</button></div>` : ""}`;
      const cb = $("#claimBtn"); if (cb) cb.onclick = async () => { if (await send("Claim", (s) => c("padToken", p.token, s).claim())) mine(); };
    }

    // creator tools + anyone
    const isCreator = () => W.account && W.account.toLowerCase() === p.creator.toLowerCase();
    function tools() {
      const box = $("#creatorbox"), ct = $("#creatortools"); box.hidden = !isCreator(); if (!isCreator()) return;
      ct.innerHTML = `<div class="kv"><span>LP fees</span><b>collect any time</b></div><div class="kv"><span>Your tax share waiting</span><b>${num(p.creatorOwed)} STAG</b></div><div class="kv"><span>War chest</span><b>${num(p.chest)} STAG</b></div>
        <div class="cta"><button class="btn" id="cFees">Collect LP fees</button><button class="btn" id="cClaim" ${p.creatorOwed === 0n ? "disabled" : ""}>Claim tax share</button><button class="btn" id="cBurn" ${p.chest === 0n || p.locked ? "disabled" : ""}>Burn the war chest</button><button class="btn" id="cMode" ${p.locked ? "disabled" : ""}>Switch to ${p.war ? "peace" : "war"}</button><a class="btn" href="${demoHref("/pad/battles/")}">Battles</a></div>
        ${p.locked ? `<p class="fine">A battle holds this pool, so mode and burning are locked until it ends.</p>` : ""}`;
      $("#cFees").onclick = async () => { await send("Collect LP fees", (s) => c("factory", C.factory, s).collectFees(p.key, W.account)); };
      $("#cClaim").onclick = async () => { if (await send("Claim", (s) => c("hook", C.hook, s).claimCreator(p.key, W.account))) location.reload(); };
      $("#cBurn").onclick = async () => {
        const ok = await confirmModal("Burn the war chest?", `<p>This spends up to <b>${num(p.chest)} STAG</b> of the chest buying <b>$${esc(p.symbol)}</b> from the pool and burning what comes back. A burn moves the price by at most about 1.5%, only one burn is allowed per hour, and what the pool cannot fill within that limit stays in the chest. Burning is final.</p>`, "Burn");
        if (ok && (await send("Burn", (s) => c("hook", C.hook, s).burnChest(p.key, 1)))) location.reload();
      };
      $("#cMode").onclick = async () => {
        const toPeace = p.war;
        const ok = await confirmModal(toPeace ? "Switch to peace mode?" : "Switch to war mode?", toPeace
          ? `<ul class="plain"><li>From now on, the 3% tax on <b>buys</b> pays <b>1% to you and 2% to token holders</b> instead of building the war chest.</li><li>Your existing chest <b>stays</b> in the chest and you can still burn it.</li><li>You cannot challenge or accept a battle while in peace.</li><li>Holders and challengers can see the mode on this page, and you can switch back any time while no battle holds the pool. Switching only changes later buys.</li></ul>`
          : `<ul class="plain"><li>From now on, <b>all</b> of the 3% buy tax goes into the war chest. Nothing from buy tax goes to you or to holders.</li><li>You can spend the chest only by burning it, or put it at stake in a battle.</li><li>Switching only changes later buys.</li></ul>`, toPeace ? "Switch to peace" : "Switch to war");
        if (ok && (await send("Switch mode", (s) => c("hook", C.hook, s).setMode(p.key, !p.war)))) location.reload();
      };
    }
    function anyone() {
      const a = $("#anyone"); const now = nowSec();
      a.innerHTML = `<div class="kv"><span>Holder payout waiting to be pushed</span><b>${num(p.holderOwed)} STAG</b></div><div class="kv"><span>Chest marked for burning (battle win)</span><b>${num(p.forced)} STAG</b></div>
        <div class="cta"><button class="btn" id="aPush" ${p.holderOwed === 0n ? "disabled" : ""}>Push holder payout</button><button class="btn" id="aForced" ${p.forced === 0n || p.locked ? "disabled" : ""}>Burn the marked chest (step)</button></div>
        <p class="fine">Pushing the holder payout is free of risk to you: it only moves money that is already owed to holders. The marked chest can be burned by anyone in steps (one per hour; the creator gets the first shot each hour) so a battle win always ends in a burn. ${p.lastBurn ? "Last burn: " + ago(p.lastBurn) + " ago." : ""}</p>`;
      $("#aPush").onclick = async () => { if (await send("Push payout", (s) => c("hook", C.hook, s).pushHolders(p.key))) location.reload(); };
      $("#aForced").onclick = async () => { if (await send("Burn", (s) => c("hook", C.hook, s).burnForced(p.key, 1))) location.reload(); };
    }
    tools(); anyone();
    document.addEventListener("pad:wallet", () => { tools(); mine(); refresh(); });
    $$("[data-wallet]").forEach((b) => b.addEventListener("click", () => !W.account && connect()));
    if (DEMO) connect(); else if (window.ethereum && window.ethereum.selectedAddress) connect();
  };

  pages.battles = async () => {
    const list = $("#battlelist"), mine = $("#battlemine");
    if (DEMO) {
      const ST = ["none", "Offered", "Live", "Settled", "Cancelled"];
      const rows = [...MOCK_BATTLES].reverse().map((b) => {
        const A = MOCK[b.a], B = MOCK[b.b]; let line = "", acts = [];
        if (b.st === 1) { line = `Offer open for ${Math.round(b.expIn / 86400 * 10) / 10} d. Runs ${b.dur / 3600} h once accepted.`; }
        if (b.st === 2) line = `Ends in ${Math.floor(b.endIn / 3600)} h ${Math.round((b.endIn % 3600) / 60)} min. Volume since start: ${num(W18(b.va))} vs ${num(W18(b.vb))} STAG.`;
        if (b.st === 3) line = "Settled. The winner is the token with more volume during the fight; its chest is marked for burning (see that token page). A tie moves nothing.";
        if (b.st === 1 && ROLE === "creator" && B.creator === MOCK_CREATOR) acts.push(`<button class="btn solid" data-act="accept">Accept</button>`);
        return `<div class="padbox bt"><div class="row"><b>#${b.id}</b><span class="chip ${b.st === 2 ? "" : "soon"}">${ST[b.st]}</span></div><h3>${esc(A.name)} <small>vs</small> ${esc(B.name)}</h3><p class="muted">${line}</p><div class="cta"><a class="btn" href="${demoHref("/pad/battle/?id=" + b.id)}">View battle</a>${acts.join("")}</div></div>`;
      });
      list.innerHTML = rows.join("");
      $$("[data-act]", list).forEach((bt) => bt.addEventListener("click", () => send("Accept", null)));
      const renderDemoMine = () => {
        if (ROLE !== "creator") { mine.innerHTML = `<p class="muted">You have not launched a token with this wallet. (Preview the creator view with the "creator" link at the top.)</p>`; return; }
        const mineP = MOCK.filter((p) => p.creator === MOCK_CREATOR);
        mine.innerHTML = `<form id="chform" class="padform"><label class="lbl">Your token (must be in war mode and free)</label><select name="a" class="inp">${mineP.map((p) => `<option value="${p.i}">${esc(p.name)} ($${esc(p.symbol)})</option>`).join("")}</select>
          <label class="lbl">Opponent</label><select name="b" class="inp">${MOCK.map((p) => `<option value="${p.i}" ${p.i === MOCK.find((q) => q.i !== mineP[0].i).i ? "selected" : ""}>${esc(p.name)} ($${esc(p.symbol)})${p.war ? "" : " (peace: cannot accept)"}</option>`).join("")}</select>
          <label class="lbl">Length (hours, 1 to 336)</label><input name="h" class="inp" value="24" inputmode="numeric">
          <div class="cta"><button class="btn solid" type="submit">Offer battle</button></div></form>`;
        $("#chform").addEventListener("submit", async (ev) => { ev.preventDefault(); const f = ev.target, a = MOCK[Number(f.a.value)], b = MOCK[Number(f.b.value)]; if (a.i === b.i) return toast("Pick two different tokens.", "err");
          const ok = await confirmModal("Offer this battle?", `<ul class="plain"><li><b>${esc(a.name)}</b> vs <b>${esc(b.name)}</b>, ${Number(f.h.value)} hours once accepted.</li><li>Your pool is locked from now (no mode change, no burning) until the offer is accepted, withdrawn or lapses after 3 days.</li><li>Only trading volume decides the winner. Volume counts even when it is wash trading, so a rich opponent can outspend you.</li><li>Only what each pool <b>earned during the fight</b> is at stake: the loser's fight earnings join the winner's chest, and the winner burns it.</li></ul>`, "Offer battle"); if (ok) await send("Offer battle", null); });
      };
      renderDemoMine(); return;
    }
    if (!LIVE) { list.innerHTML = `<p class="muted">Battles appear here once the pad is live.</p>`; return; }
    const names = {}; const nm = async (i0) => names[i0.id] || (names[i0.id] = await (async () => { const inf = await R.hook().info(i0.id); return { name: await c("erc20", inf.token).name().catch(() => "?"), symbol: await c("erc20", inf.token).symbol().catch(() => "?"), creator: inf.creator, volume: inf.volume }; })());
    const ST = ["none", "Offered", "Live", "Settled", "Cancelled"];
    async function render() {
      try {
        const n = Number(await R.battle().count());
        if (!n) { list.innerHTML = `<p class="muted">No battles yet.</p>`; } else {
          const ids = []; for (let i = n - 1; i >= Math.max(0, n - 30); i--) ids.push(i);
          const rows = await Promise.all(ids.map(async (id) => {
            const b = await R.battle().get(id); const A = await nm({ id: poolId(b.a) }), B = await nm({ id: poolId(b.b) });
            const st = Number(b.state), now = nowSec();
            const live = st === 2, ended = live && now >= Number(b.end);
            let line = "";
            if (st === 1) line = `Offer open for ${left(Number(b.offerExpiry))}. Runs ${Math.round(Number(b.duration) / 3600 * 10) / 10} h once accepted.`;
            if (st === 3) line = "Settled. The winner is the token with more volume during the fight; its chest is marked for burning (see that token page). A tie moves nothing.";
            if (st === 4) line = "Offer withdrawn or lapsed.";
            if (live) { const va = A.volume - b.volA0, vb = B.volume - b.volB0; line = `${ended ? "Ended" : "Ends in " + left(Number(b.end))}. Volume since start: ${num(va)} vs ${num(vb)} STAG.`; }
            const acts = [];
            if (st === 1 && W.account && W.account.toLowerCase() === B.creator.toLowerCase() && now <= Number(b.offerExpiry)) acts.push(`<button class="btn solid" data-act="accept" data-id="${id}">Accept</button>`);
            if (st === 1 && W.account && (W.account.toLowerCase() === A.creator.toLowerCase() || now > Number(b.offerExpiry))) acts.push(`<button class="btn" data-act="cancel" data-id="${id}">${now > Number(b.offerExpiry) ? "Clear lapsed offer" : "Withdraw offer"}</button>`);
            if (ended) acts.push(`<button class="btn solid" data-act="settle" data-id="${id}">Settle</button>`);
            return `<div class="padbox bt"><div class="row"><b>#${id}</b><span class="chip ${st === 2 ? "" : "soon"}">${ST[st]}</span></div><h3>${esc(A.name)} <small>vs</small> ${esc(B.name)}</h3><p class="muted">${line}</p><div class="cta"><a class="btn" href="/pad/battle/?id=${id}">View battle</a>${acts.join("")}</div></div>`;
          }));
          list.innerHTML = rows.join("");
          $$("[data-act]", list).forEach((bt) => bt.addEventListener("click", async () => {
            const id = BigInt(bt.dataset.id), act = bt.dataset.act;
            const fnName = { accept: "accept", cancel: "cancel", settle: "settle" }[act];
            if (await send(act, (s) => c("battle", C.battle, s)[fnName](id))) render();
          }));
        }
      } catch (e) { list.innerHTML = `<p class="muted">Could not load battles: ${esc(errMsg(e))}</p>`; }
      await renderMine();
    }
    async function renderMine() {
      if (!W.account) { mine.innerHTML = `<p class="muted">Connect your wallet to challenge another token from a pool you created.</p>`; return; }
      try {
        const n = await launchCount(); const mineP = [], all = [];
        for (let i = 0; i < n; i++) { const p = await pool(i).catch(() => null); if (p) { all.push(p); if (p.creator.toLowerCase() === W.account.toLowerCase()) mineP.push(p); } }
        if (!mineP.length) { mine.innerHTML = `<p class="muted">You have not launched a token with this wallet.</p>`; return; }
        mine.innerHTML = `<form id="chform" class="padform"><label class="lbl">Your token (must be in war mode and free)</label><select name="a" class="inp">${mineP.map((p) => `<option value="${p.i}" ${!p.war || p.locked ? "disabled" : ""}>${esc(p.name)} ($${esc(p.symbol)})${!p.war ? " (peace mode)" : p.locked ? " (locked)" : ""}</option>`).join("")}</select>
          <label class="lbl">Opponent</label><select name="b" class="inp">${all.map((p) => `<option value="${p.i}" ${all.length > 1 && p.i === all.find((q) => q.i !== mineP[0].i).i ? "selected" : ""}>${esc(p.name)} ($${esc(p.symbol)})${p.war ? "" : " (peace: cannot accept)"}</option>`).join("")}</select>
          <label class="lbl">Length (hours, 1 to 336)</label><input name="h" class="inp" value="24" inputmode="numeric">
          <div class="cta"><button class="btn solid" type="submit">Offer battle</button></div></form>`;
        $("#chform").addEventListener("submit", async (ev) => {
          ev.preventDefault(); const f = ev.target; const a = all[Number(f.a.value)], b = all[Number(f.b.value)], h = Number(f.h.value);
          if (!(h >= 1 && h <= 336)) return toast("Length must be between 1 and 336 hours.", "err");
          if (a.i === b.i) return toast("Pick two different tokens.", "err");
          const ok = await confirmModal("Offer this battle?", `<ul class="plain"><li><b>${esc(a.name)}</b> vs <b>${esc(b.name)}</b>, ${h} hours once accepted.</li><li>Your pool is locked from now (no mode change, no burning) until the offer is accepted, withdrawn or lapses after 3 days.</li><li>Only trading volume decides the winner. Volume counts even when it is wash trading, so a rich opponent can outspend you.</li><li>Only what each pool <b>earned during the fight</b> is at stake: the loser's fight earnings join the winner's chest, and the winner burns it.</li></ul>`, "Offer battle");
          if (ok && (await send("Offer battle", (s) => c("battle", C.battle, s).challenge(a.key, b.key, BigInt(h) * 3600n)))) render();
        });
      } catch (e) { mine.innerHTML = `<p class="muted">Could not load your tokens: ${esc(errMsg(e))}</p>`; }
    }
    document.addEventListener("pad:wallet", render);
    $$("[data-wallet]").forEach((b) => b.addEventListener("click", () => !W.account && connect()));
    await render();
    if (window.ethereum && window.ethereum.selectedAddress) connect();
  };


  // ------------------------------------------------------------------ battle detail page
  // Everything here is read-only and rebuilt from public chain data (the battle record, the hook's Taxed events and the tokens' Transfer logs).
  // Addresses are wallets, not people, and volume counts even when it is wash trading.
  const IFACE = new E.Interface(["event Taxed(bytes32 indexed id,bool buy,uint256 volume,uint256 fee)", "event PoolRegistered(bytes32 indexed id,address indexed creator,address token,bool war,bool quoteIs0)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
  const DEAD = "0x000000000000000000000000000000000000dEaD".toLowerCase(), ZERO = E.ZeroAddress.toLowerCase();
  async function blockAt(ts) {
    const head = await ro.getBlockNumber(); const hb = await ro.getBlock(head); if (ts >= hb.timestamp) return head;
    let lo = 0, hi = head; while (lo < hi) { const mid = (lo + hi) >> 1; const b = await ro.getBlock(mid); if (b.timestamp < ts) lo = mid + 1; else hi = mid; } return lo;
  }
  async function getLogsSafe(f, from, to, depth = 0) {
    try { return await ro.getLogs({ ...f, fromBlock: from, toBlock: to }); }
    catch (e) { if (depth >= 6 || to - from < 20000) throw e; const mid = Math.floor((from + to) / 2); return (await getLogsSafe(f, from, mid, depth + 1)).concat(await getLogsSafe(f, mid + 1, to, depth + 1)); }
  }
  const topN = (m, n) => [...m.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, n);
  async function sideStats(p, from, to) {
    const out = { buyVol: 0n, sellVol: 0n, buys: 0, sells: 0, buyers: new Map(), sellers: new Map(), holders: [], holdersSeen: 0, note: "", ev: [] };
    const head = await ro.getBlockNumber(); const toB = to == null ? head : Math.min(head, to);
    const taxedT = IFACE.getEvent("Taxed").topicHash;
    if (from != null) for (const l of await getLogsSafe({ address: C.hook, topics: [taxedT, p.id] }, from, toB)) { const d = IFACE.parseLog(l); if (d.args.buy) { out.buyVol += d.args.volume; out.buys++; } else { out.sellVol += d.args.volume; out.sells++; } }
    const trT = IFACE.getEvent("Transfer").topicHash; const skip = new Set([C.pm, C.hook, C.router, C.battle, C.factory].filter(Boolean).map((x) => x.toLowerCase()).concat([ZERO, DEAD]));
    // wallets that ever held the token: every Transfer since the pool was registered
    let regFrom = from;
    try { const rl = await getLogsSafe({ address: C.hook, topics: [IFACE.getEvent("PoolRegistered").topicHash, p.id] }, 0, head); if (rl.length) regFrom = rl[0].blockNumber; } catch { out.note = "Holder list covers only the battle window (full history not available from the RPC)."; }
    if (regFrom == null) regFrom = Math.max(0, head - 200000);
    const seen = new Map();
    for (const l of await getLogsSafe({ address: p.token, topics: [trT] }, regFrom, head)) {
      const d = IFACE.parseLog(l); const f = d.args.from.toLowerCase(), t = d.args.to.toLowerCase(), v = d.args.value;
      for (const a of [f, t]) if (!skip.has(a)) seen.set(a, (seen.get(a) || 0n) + v);
      const inWin = from != null && l.blockNumber >= from && l.blockNumber <= toB;
      if (inWin && f === C.pm.toLowerCase() && !skip.has(t)) { out.buyers.set(t, (out.buyers.get(t) || 0n) + v); out.ev.push({ blk: l.blockNumber, buy: true, addr: t, amt: v }); }
      if (inWin && t === C.pm.toLowerCase() && !skip.has(f)) { out.sellers.set(f, (out.sellers.get(f) || 0n) + v); out.ev.push({ blk: l.blockNumber, buy: false, addr: f, amt: v }); }
    }
    const cand = topN(seen, 150).map((x) => x[0]); const tok = c("erc20", p.token);
    const bal = await Promise.all(cand.map(async (a) => [a, await tok.balanceOf(a).catch(() => 0n)]));
    const held = bal.filter((x) => x[1] > 0n); out.holdersSeen = held.length; out.holders = held.sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 8);
    return out;
  }
  const mockWallet = (n) => E.keccak256(E.toUtf8Bytes("demo-wallet-" + n)).slice(0, 42);
  function mockSide(seed, vol) {
    const mk2 = (n, k) => Array.from({ length: n }, (_, j) => [mockWallet(seed * 40 + k * 10 + j), W18(Math.round(vol / (j + 2.2) / 90))]);
    const buyers = mk2(6, 1), sellers = mk2(4, 2), holders = mk2(8, 3).map((x) => [x[0], W18(Math.round(Number(E.formatUnits(x[1], 18)) * 900))]);
    return { buyVol: W18(Math.round(vol * 0.62)), sellVol: W18(Math.round(vol * 0.38)), buys: Math.round(vol / 31000), sells: Math.round(vol / 52000), buyers, sellers, holders, holdersSeen: 40 + seed * 7, note: "", ev: buyers.slice(0, 4).map((b, j) => ({ blk: 0, buy: j % 3 !== 2, addr: b[0], amt: b[1], age: 4 + j * 5 + seed })) };
  }
  const BATTLE_EV = new E.Interface(["event Settled(uint256 indexed id,bytes32 winner,bytes32 loser,uint256 volWinner,uint256 volLoser,uint256 chestWon)", "event Tied(uint256 indexed id,uint256 volA,uint256 volB)"]);
  const hueOf = (a) => (parseInt(String(a).slice(2, 8), 16) || 0) % 360;
  const pad2 = (n) => String(n).padStart(2, "0");
  const clock = (sec) => { sec = Math.max(0, Math.floor(sec)); return `${pad2(Math.floor(sec / 3600))} : ${pad2(Math.floor((sec % 3600) / 60))} : ${pad2(sec % 60)}`; };
  pages.battle = async () => {
    const root = $("#battleroot"); const id = Number(new URLSearchParams(location.search).get("id"));
    if (!Number.isInteger(id) || id < 0) { root.innerHTML = `<p class="muted">No battle selected. <a href="${demoHref("/pad/battles/")}">See all battles</a>.</p>`; return; }
    const ST = ["none", "Offered", "Live", "Settled", "Cancelled"];
    let A, B, st, dur, start = 0, end = 0, expiry = 0, chestA0 = 0n, chestB0 = 0n, volA0 = 0n, volB0 = 0n, SA, SB, vA = 0n, vB = 0n, endIn = 0, tie = false;
    try {
      if (DEMO) {
        const b = MOCK_BATTLES.find((x) => x.id === id); if (!b) throw new Error("No such battle.");
        A = MOCK[b.a]; B = MOCK[b.b]; st = b.st; dur = b.dur; endIn = b.endIn || 0; chestA0 = A.chest * 55n / 100n; chestB0 = B.chest * 62n / 100n; expiry = b.expIn || 0;
        if (st >= 2) { vA = W18(b.va || 1280000); vB = W18(b.vb || 990000); SA = mockSide(b.a + 1, Number(E.formatUnits(vA, 18))); SB = mockSide(b.b + 1, Number(E.formatUnits(vB, 18))); }
        else { SA = mockSide(b.a + 1, 0); SB = mockSide(b.b + 1, 0); SA.buyers = SA.sellers = SB.buyers = SB.sellers = []; SA.ev = SB.ev = []; SA.buyVol = SA.sellVol = SB.buyVol = SB.sellVol = 0n; SA.buys = SA.sells = SB.buys = SB.sells = 0; }
      } else {
        if (!LIVE) { root.innerHTML = `<p class="muted">Battles appear here once the pad is live.</p>`; return; }
        const n = Number(await R.battle().count()); if (id >= n) throw new Error("No such battle.");
        const b = await R.battle().get(id); st = Number(b.state); dur = Number(b.duration); start = Number(b.start); end = Number(b.end); expiry = Number(b.offerExpiry);
        chestA0 = b.chestA0; chestB0 = b.chestB0; volA0 = b.volA0; volB0 = b.volB0;
        const ld = async (k) => { const pid = poolId(k); const inf = await R.hook().info(pid); const tok = c("erc20", inf.token); const [name, symbol] = await Promise.all([tok.name().catch(() => "?"), tok.symbol().catch(() => "?")]); return { id: pid, i: 0, name, symbol, token: inf.token, creator: inf.creator, war: inf.war, locked: inf.locked, chest: inf.chest, volume: inf.volume }; };
        [A, B] = await Promise.all([ld(b.a), ld(b.b)]);
        const info = st >= 2 ? { from: await blockAt(start), to: st === 3 || nowSec() > end ? await blockAt(end) : null } : { from: null, to: null };
        [SA, SB] = await Promise.all([sideStats(A, info.from, info.to), sideStats(B, info.from, info.to)]);
        if (st >= 2) { vA = A.volume - volA0; vB = B.volume - volB0; endIn = end - nowSec(); }
        if (st === 3) { // the exact final volumes are in the settle event
          try { const bl = await getLogsSafe({ address: C.battle, topics: [[BATTLE_EV.getEvent("Settled").topicHash, BATTLE_EV.getEvent("Tied").topicHash], E.zeroPadValue(E.toBeHex(id), 32)] }, info.to, await ro.getBlockNumber());
            if (bl.length) { const d = BATTLE_EV.parseLog(bl[0]); if (d.name === "Tied") { vA = d.args.volA; vB = d.args.volB; tie = true; } else { const aWon = d.args.winner.toLowerCase() === A.id.toLowerCase(); vA = aWon ? d.args.volWinner : d.args.volLoser; vB = aWon ? d.args.volLoser : d.args.volWinner; } } } catch { /* fall back to the running totals */ }
        }
      }
    } catch (e) { root.innerHTML = `<p class="muted">Could not load this battle: ${esc(errMsg(e))} <a href="${demoHref("/pad/battles/")}">All battles</a></p>`; return; }

    const total = vA + vB, pa = total > 0n ? Math.round(Number((vA * 1000n) / total)) / 10 : 50, pb = Math.round((100 - pa) * 10) / 10;
    const live = st === 2, started = st >= 2;
    const leadA = vA > vB, level = vA === vB;
    const tokTotals = await Promise.all([A, B].map(async (p) => DEMO ? W18(1000000000) : c("erc20", p.token).totalSupply().catch(() => 0n)));
    const av = (a) => `<i class="av" style="--h:${hueOf(a)}"></i>`;
    const who = (a, p) => `<a href="${explorer("address", a)}" rel="noopener">${short(a)}</a>${p.creator && a.toLowerCase() === p.creator.toLowerCase() ? ` <span class="tag">creator</span>` : ""}`;
    const rowsHtml = (list, p, tsup) => { if (!list.length) return `<p class="muted small pad">None yet.</p>`; const mx = list[0][1] || 1n;
      return list.map(([a, v], i) => `<div class="rk r${i < 3 ? i + 1 : 0}"><span class="rn">${i + 1}</span>${av(a)}<span class="ra">${who(a, p)}</span><span class="rb"><u style="width:${Math.max(3, Number((v * 100n) / mx))}%"></u></span><b class="rv">${num(v)} <small>$${esc(p.symbol)}</small>${tsup ? ` <em>${(Number((v * 10000n) / tsup) / 100).toFixed(1)}%</em>` : ""}</b></div>`).join(""); };
    const col = (p, S, v, chest0, cls, ts, lead, label) => {
      const dChest = p.chest >= chest0 ? p.chest - chest0 : chest0 - p.chest, up = p.chest >= chest0;
      return `<div class="bcol ${cls}" data-col>
        <div class="bh"><h2>${esc(p.name)}</h2>${started ? `<span class="chip lead ${lead ? "" : "soon"}">${label}</span>` : ""}</div>
        <div class="stiles"><div><span>War chest</span><b>${num(p.chest)} STAG</b></div><div><span>Volume in battle</span><b>${started ? num(v) : "0"} STAG</b></div><div><span>Chest change</span><b class="${up ? "up" : "dn"}">${started ? (up ? "+" : "-") + num(dChest) : "n/a"} STAG</b></div></div>
        <div class="tabs2" role="tablist"><button class="on" data-tab="buy">Buyers</button><button data-tab="sell">Sellers</button><button data-tab="hold">Holders</button></div>
        <div data-pane="buy">${rowsHtml(topN(new Map(S.buyers), 5), p)}<p class="fine pad">${S.buys} buys · ${num(S.buyVol)} STAG, after the 3% tax</p></div>
        <div data-pane="sell" hidden>${rowsHtml(topN(new Map(S.sellers), 5), p)}<p class="fine pad">${S.sells} sells · ${num(S.sellVol)} STAG, after the 3% tax</p></div>
        <div data-pane="hold" hidden>${rowsHtml(S.holders.slice(0, 5), p, ts)}<p class="fine pad">${S.holdersSeen} wallets seen holding</p></div>
      </div>`; };
    let centre = "";
    if (live) centre = `<div class="cd ${endIn > 0 && endIn < 3600 ? "hot" : ""}" id="cd">${endIn <= 0 ? "TIME UP" : clock(endIn)}</div><div class="cdl">${endIn <= 0 ? "Anyone can settle" : "Remains"}</div>`;
    else if (st === 3) centre = `<div class="cd small">${tie ? "TIED" : "SETTLED"}</div><div class="cdl">${tie ? "Nothing moves" : esc((leadA ? A : B).name) + " wins · chest marked to burn"}</div>`;
    else if (st === 1) centre = `<div class="cd small">OFFERED</div><div class="cdl">Open for ${DEMO ? Math.round(expiry / 86400 * 10) / 10 + " d" : left(expiry)} · runs ${Math.round(dur / 3600 * 10) / 10} h</div>`;
    else centre = `<div class="cd small">NO FIGHT</div><div class="cdl">Offer withdrawn or lapsed</div>`;
    const half = (p, cls, art) => `<div class="half ${cls}"><div class="hn"><span class="pfp ${art ? "" : "ini"}" style="--h:${hueOf(p.id)};${art ? `background-image:url(${art})` : ""}">${art ? "" : esc(String(p.symbol || "?").slice(0, 2).toUpperCase())}</span><h2>${esc(p.name)}</h2><span class="chip ${cls === "ga" ? "" : "soon"}">${p.war ? "War" : "Peace"}</span></div></div>`;
    const artOf = (p) => DEMO ? `/pad/assets/${ART[p.i % ART.length]}.webp` : "";
    // newest trades from both sides, newest first
    let evs = [...SA.ev.map((e) => ({ ...e, side: "ga", p: A })), ...SB.ev.map((e) => ({ ...e, side: "gb", p: B }))].sort((x, y) => y.blk - x.blk || (x.age || 0) - (y.age || 0)).slice(0, 4);
    if (!DEMO && evs.length) { await Promise.all(evs.map(async (e) => { try { e.ts = (await ro.getBlock(e.blk)).timestamp; } catch { e.ts = null; } })); }
    const tick = evs.length ? `<div class="feed">${evs.map((e) => `<span class="${e.side}"><i></i>${DEMO ? (e.age + "s") : (e.ts ? ago(e.ts) : "")} ago · ${e.buy ? "bought" : "sold"} ${num(e.amt)} $${esc(e.p.symbol)} · ${short(e.addr)}</span>`).join("")}</div>` : "";
    root.innerHTML = `<div class="btop"><a href="${demoHref("/pad/battles/")}">← All battles</a><span><span class="chip ${live ? "live" : "soon"}">${live ? "● Live" : ST[st]}</span> <span class="chip grey">Battle #${id}</span></span></div>
      <div class="vsb"><div class="halves">${half(A, "ga", artOf(A))}${half(B, "gb", artOf(B))}</div><div class="flash"></div><div class="bolt"></div><div class="mid">${centre}</div></div>
      ${started ? `<div class="tug" role="img" aria-label="Volume share ${pa}% against ${pb}%"><i class="ta" style="width:${pa}%">${pa}%</i><b class="tb" style="width:${pb}%">${pb}%</b></div>
      <div class="tugn"><span>${num(vA)} STAG</span>${tick}<span>${num(vB)} STAG</span></div>` : ""}
      <div class="bcols">${col(A, SA, vA, chestA0, "ga", tokTotals[0], leadA && !level, level ? "LEVEL" : leadA ? (st === 3 ? "WINNER" : "LEADING") : (st === 3 ? "LOST" : "TRAILING"))}${col(B, SB, vB, chestB0, "gb", tokTotals[1], !leadA && !level, level ? "LEVEL" : !leadA ? (st === 3 ? "WINNER" : "LEADING") : (st === 3 ? "LOST" : "TRAILING"))}</div>
      <div class="warnbox">Built from public on-chain data. Volumes are what reaches the pool, after the 3% tax (a 500 STAG buy shows as 485). Volume counts even when it is wash trading, so a bigger number does not mean more real interest. Addresses are wallets, not people, and one person can use many. ${SA.note || SB.note || ""}</div>`;
    embers($(".vsb", root), { split: true, n: 70 });
    root.addEventListener("click", (ev) => { const bt = ev.target.closest("[data-tab]"); if (!bt) return; const colEl = bt.closest("[data-col]"); $$("[data-tab]", colEl).forEach((x) => x.classList.toggle("on", x === bt)); $$("[data-pane]", colEl).forEach((x) => { x.hidden = x.dataset.pane !== bt.dataset.tab; }); });
    if (live && endIn > 0) { const tEnd = DEMO ? Date.now() / 1000 + endIn : end; const iv = setInterval(() => { const el = $("#cd"); if (!el) return clearInterval(iv); const left2 = DEMO ? tEnd - Date.now() / 1000 : tEnd - nowSec(); el.textContent = left2 <= 0 ? "TIME UP" : clock(left2); if (left2 <= 0) clearInterval(iv); }, 1000); }
  };

  // ------------------------------------------------------------------ boot
  document.addEventListener("DOMContentLoaded", async () => {
    if (LIVE) await syncClock();
    const nl = $("#notlive"); if (nl) nl.innerHTML = notLiveBanner();
    $$("[data-wallet]").forEach((b) => { b.addEventListener("click", () => !W.account && connect()); });
    if (DEMO) { $$('a[href^="/pad/"]').forEach((a) => { a.setAttribute("href", demoHref(a.getAttribute("href"))); }); }
    const pg = document.body.dataset.page; if (pg && pages[pg]) await pages[pg]();
    if (DEMO) $$('a[href^="/pad/"]').forEach((a) => { a.setAttribute("href", demoHref(a.getAttribute("href"))); });
    if (!DEMO && pg !== "token" && pg !== "battles" && pg !== "battle" && window.ethereum && window.ethereum.selectedAddress) connect();
  });
  window.Pad = { connect, poolId, LIVE };
})();
