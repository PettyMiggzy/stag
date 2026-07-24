/* ============================================================
   HOOD ✕ CHANGE — front-end app (hash-routed, no framework)
   ------------------------------------------------------------
   ALL blockchain / backend calls live in HX.api below.
   Everything is stubbed with mock data today. To go live, a
   dev only needs to replace the bodies of HX.api.* — the UI,
   routing and state stay exactly the same. No wallet-connect
   logic is wired here on purpose.
   ============================================================ */
(function () {
  "use strict";

  var HX = (window.HX = window.HX || {});

  /* ---------------------------------------------------------
     MOCK DATA  (delete once HX.api talks to real contracts)
     --------------------------------------------------------- */
  var CHAIN = { id: 4663, name: "Robinhood Chain" };

  var MOCK_TOKENS = [
    {
      addr: "0x620f0000000000000000000000000000000007a1e",
      name: "Bankruptcy", ticker: "BANKRUPTCY", blurb: "we re all broke",
      creator: "0x620f…7a1e", age: "2d ago",
      mcap: 2521.74, priceUsd: 0.00002521, change24: 0, trades24: 0,
      bonded: 0.0, status: "new", createdAt: 2, featured: true,
      supply: 1000000000, holders: 3, volume24: 0,
    },
    {
      addr: "0x1111000000000000000000000000000000001111",
      name: "Green Arrow", ticker: "ARROW", blurb: "straight to the target",
      creator: "0x8ac3…21de", age: "5h ago",
      mcap: 142300, priceUsd: 0.000142, change24: 38.2, trades24: 214,
      bonded: 74, status: "graduating", createdAt: 0,
      supply: 1000000000, holders: 388, volume24: 61200,
    },
    {
      addr: "0x2222000000000000000000000000000000002222",
      name: "Hooded Fox", ticker: "FOX", blurb: "sly on the chain",
      creator: "0x77b1…9c04", age: "1d ago",
      mcap: 88100, priceUsd: 0.0000881, change24: 12.4, trades24: 98,
      bonded: 52, status: "trending", createdAt: 1,
      supply: 1000000000, holders: 201, volume24: 24800,
    },
    {
      addr: "0x3333000000000000000000000000000000003333",
      name: "Sherwood", ticker: "WOOD", blurb: "deep in the forest",
      creator: "0x0d5e…4f2a", age: "3d ago",
      mcap: 61000, priceUsd: 0.000061, change24: 9.1, trades24: 55,
      bonded: 100, status: "graduated", createdAt: 3,
      supply: 1000000000, holders: 174, volume24: 15100,
    },
    {
      addr: "0x4444000000000000000000000000000000004444",
      name: "Merry Men", ticker: "MERRY", blurb: "band of builders",
      creator: "0x620f…7a1e", age: "6h ago",
      mcap: 34000, priceUsd: 0.000034, change24: 21.7, trades24: 40,
      bonded: 28, status: "new", createdAt: 0,
      supply: 1000000000, holders: 66, volume24: 9200,
    },
  ];

  var MOCK_BUILDERS = [
    { rank: 1, addr: "0x620f…7a1e", launched: 1 },
  ];

  /* ---------------------------------------------------------
     HX.api  —  THE PLUG-IN LAYER
     Replace each body with a real contract / backend call.
     Every method returns a Promise. Shapes documented inline.
     --------------------------------------------------------- */
  HX.api = {
    // Global headline stats for the hero.
    // -> { valueLockedEth, liveCoins, mcapGeneratedUsd }
    stats: function () {
      var mcap = MOCK_TOKENS.reduce(function (s, t) { return s + t.mcap; }, 0);
      return Promise.resolve({
        valueLockedEth: 0.0,
        liveCoins: MOCK_TOKENS.length,
        mcapGeneratedUsd: mcap,
      });
    },

    // List coins on the board. filter ∈ trending|new|graduating|graduated|all
    // sort ∈ mcap|new|volume ; q = search string
    // -> [token]
    listTokens: function (filter, sort, q) {
      var list = MOCK_TOKENS.slice();
      if (filter && filter !== "all") {
        list = list.filter(function (t) {
          if (filter === "trending") return t.change24 > 0;
          return t.status === filter;
        });
      }
      if (q) {
        var s = q.toLowerCase();
        list = list.filter(function (t) {
          return (t.name + " " + t.ticker + " " + t.addr).toLowerCase().indexOf(s) >= 0;
        });
      }
      list.sort(function (a, b) {
        if (sort === "new") return a.createdAt - b.createdAt;
        if (sort === "volume") return b.volume24 - a.volume24;
        return b.mcap - a.mcap; // default mcap
      });
      return Promise.resolve(list);
    },

    // Single coin by address -> token | null
    getToken: function (addr) {
      var t = MOCK_TOKENS.filter(function (x) { return x.addr === addr; })[0] || null;
      return Promise.resolve(t);
    },

    // Price history for the chart -> [{t, p}]  (oldest → newest)
    priceHistory: function (addr) {
      var t = MOCK_TOKENS.filter(function (x) { return x.addr === addr; })[0];
      var base = t ? t.priceUsd : 0.00001;
      var pts = [], p = base * 0.55, seed = (addr.charCodeAt(6) || 7);
      for (var i = 0; i < 48; i++) {
        // deterministic pseudo-wander (no Math.random for reproducibility)
        var w = Math.sin((i + seed) * 0.7) * 0.06 + Math.cos((i + seed) * 0.31) * 0.04 + 0.012;
        p = Math.max(base * 0.2, p * (1 + w));
        pts.push({ t: i, p: p });
      }
      pts[pts.length - 1].p = base;
      return Promise.resolve(pts);
    },

    // Top holders -> [{addr, pct}]
    holders: function (addr) {
      return Promise.resolve([
        { addr: "0x620f…7a1e", pct: 4.2 },
        { addr: "0x8ac3…21de", pct: 3.1 },
        { addr: "0x1f77…90ab", pct: 2.4 },
        { addr: "0x0d5e…4f2a", pct: 1.8 },
        { addr: "bonding curve", pct: 88.5 },
      ]);
    },

    builders: function () { return Promise.resolve(MOCK_BUILDERS); },

    // ---- write actions (need a wallet + contracts; stubbed) ----
    connectWallet: function () {
      return Promise.reject({ code: "NO_WALLET", msg: "Wallet connect isn't wired yet — front-end only." });
    },
    launchToken: function (form) {
      // form: {name, ticker, blurb, imageDataUrl, firstBuyEth}
      return Promise.reject({ code: "STUB", msg: "Launch ready to plug in: deploy(token) + seed LP → FeeLocker." });
    },
    buy: function (addr, ethAmount) {
      return Promise.reject({ code: "STUB", msg: "Buy ready to plug in: router.swapExactETHForTokens()." });
    },
    sell: function (addr, tokenAmount) {
      return Promise.reject({ code: "STUB", msg: "Sell ready to plug in: router.swapExactTokensForETH()." });
    },
    claimRewards: function () {
      return Promise.reject({ code: "STUB", msg: "Claim ready to plug in: FeeLocker.claim()." });
    },
  };

  /* ---------------------------------------------------------
     helpers
     --------------------------------------------------------- */
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function usd(n) {
    if (n == null) return "—";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + (n / 1e3).toFixed(2) + "K";
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toPrecision(3);
  }
  function chg(n) {
    var cls = n > 0 ? "up" : n < 0 ? "down" : "";
    var sign = n > 0 ? "+" : "";
    return '<span class="chg ' + cls + '">' + sign + (n || 0).toFixed(1) + "%</span>";
  }
  function toast(msg, isErr) {
    var wrap = document.querySelector(".toast-wrap");
    if (!wrap) { wrap = el('<div class="toast-wrap"></div>'); document.body.appendChild(wrap); }
    var t = el('<div class="toast' + (isErr ? " err" : "") + '"><span class="dot"></span><span>' + esc(msg) + "</span></div>");
    wrap.appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(function () { t.remove(); }, 300); }, 3200);
  }
  HX.toast = toast;
  function initialsBadge(t) { return '<span class="mono">' + esc((t.ticker || "?")[0]) + "</span>"; }

  /* ---------------------------------------------------------
     ROUTER
     routes:  #/  (home)   #/launch   #/token/<addr>   #/rewards
     --------------------------------------------------------- */
  var app;
  function router() {
    var h = (location.hash || "#/").replace(/^#/, "");
    var parts = h.split("/").filter(Boolean); // e.g. ['token','0x..']
    app.scrollTop = 0; window.scrollTo(0, 0);
    setActiveNav(parts[0] || "");
    if (parts[0] === "launch") return renderLaunch();
    if (parts[0] === "token") return renderToken(parts[1]);
    if (parts[0] === "rewards") return renderRewards();
    return renderHome();
  }
  function go(hash) { location.hash = hash; }
  HX.go = go;
  function setActiveNav(key) {
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-nav") === key);
    });
  }

  /* ---------------------------------------------------------
     VIEW: HOME  (hero + board + features + exchange + split + hold + cta)
     --------------------------------------------------------- */
  function renderHome() {
    app.innerHTML =
      heroSection() +
      boardSection() +
      featuresSection() +
      exchangeSection() +
      splitSection() +
      holdSection() +
      closingSection();

    // hydrate hero stats
    HX.api.stats().then(function (s) {
      setText("hx-stat-locked", (s.valueLockedEth || 0).toFixed(2) + " ETH");
      setText("hx-stat-coins", String(s.liveCoins));
      setText("hx-stat-mcap", usd(s.mcapGeneratedUsd));
    });
    // hydrate board
    wireBoard();
    // builders
    HX.api.builders().then(function (bs) {
      var box = document.getElementById("hx-builders");
      if (!box) return;
      box.innerHTML = bs.map(function (b) {
        return '<div class="lead-row"><span class="rk">↑ ' + b.rank + '</span><span class="ad mono">' + esc(b.addr) + '</span><span class="ct">' + b.launched + " launched</span></div>";
      }).join("") + '<a class="lead-link" data-go="#/">Full leaderboard →</a>';
    });
    animateBars();
    wireGoLinks();
  }

  function heroSection() {
    return '' +
      '<section class="hero"><div class="hero-bg"></div>' +
      '<img class="hero-mark" src="assets/img/hx-hero.png" alt="" onerror="this.style.display=\'none\'"/>' +
      '<div class="hero-in">' +
        '<span class="eyebrow">— Launchpad for the people</span>' +
        '<h1>Launch. Trade. <span class="grn">Hold.</span></h1>' +
        '<p class="sub">Fair launches on locked liquidity. Real charts, real coins, and a cut of every fee handed back to the people who hold. Steal from the rich — give it to the builders.</p>' +
        '<div class="hero-cta">' +
          '<a class="btn btn-grn btn-lg" data-go="#/launch">Launch a token →</a>' +
          '<a class="btn btn-ghost btn-lg" data-go="#/rewards">🎁 Holder rewards</a>' +
        '</div>' +
        '<div class="hero-stats">' +
          '<div class="s"><div class="v" id="hx-stat-locked">0.00 ETH</div><div class="l">Value locked</div></div>' +
          '<div class="s"><div class="v" id="hx-stat-coins">—</div><div class="l">Live coins</div></div>' +
          '<div class="s"><div class="v" id="hx-stat-mcap">—</div><div class="l">Market cap generated</div></div>' +
        '</div>' +
      '</div></section>';
  }

  function boardSection() {
    return '' +
      '<section class="blk wrap" id="board">' +
        '<div class="board-top"><div class="sec-head" style="margin:0">' +
          '<span class="eyebrow">Live on the chain</span>' +
          '<h2>The board never sleeps.</h2>' +
        '</div><a class="btn btn-grn" data-go="#/launch">+ Start a new coin</a></div>' +
        '<div class="tabs" id="hx-tabs">' +
          ["trending", "new", "graduating", "graduated", "all"].map(function (f, i) {
            return '<button class="tab' + (i === 0 ? " active" : "") + '" data-filter="' + f + '">' + f.charAt(0).toUpperCase() + f.slice(1) + "</button>";
          }).join("") +
        '</div>' +
        '<div class="board-filter">' +
          '<div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>' +
            '<input id="hx-search" placeholder="Search name, ticker, or address…"/></div>' +
          '<div class="sortsel"><label>Sort</label><select id="hx-sort"><option value="mcap">Market cap</option><option value="new">Newest</option><option value="volume">Volume</option></select></div>' +
        '</div>' +
        '<div id="hx-featured"></div>' +
        '<div class="coin-list" id="hx-coinlist"></div>' +
      '</section>';
  }

  function wireBoard() {
    var filter = "trending", sort = "mcap", q = "";
    function refresh() {
      HX.api.listTokens(filter, sort, q).then(function (list) {
        // featured
        var feat = document.getElementById("hx-featured");
        var f = list.filter(function (t) { return t.featured; })[0] || list[0];
        feat.innerHTML = f ? featuredCard(f) : "";
        // list
        var rest = list.filter(function (t) { return !f || t.addr !== f.addr; });
        var box = document.getElementById("hx-coinlist");
        box.innerHTML = rest.length ? rest.map(coinRow).join("") : '<div class="empty">No coins match. Try another filter.</div>';
        wireGoLinks();
      });
    }
    document.getElementById("hx-tabs").addEventListener("click", function (e) {
      var b = e.target.closest(".tab"); if (!b) return;
      document.querySelectorAll("#hx-tabs .tab").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active"); filter = b.getAttribute("data-filter"); refresh();
    });
    document.getElementById("hx-sort").addEventListener("change", function (e) { sort = e.target.value; refresh(); });
    document.getElementById("hx-search").addEventListener("input", function (e) { q = e.target.value; refresh(); });
    refresh();
  }

  function featuredCard(t) {
    return '<div class="feat-coin" data-go="#/token/' + t.addr + '"><div class="tagwant">Most wanted</div>' +
      '<div class="feat-coin-in">' +
        '<div class="thumb">' + initialsBadge(t) + '</div>' +
        '<div class="meta">' +
          '<div class="crumb">created by <span class="mono">' + esc(t.creator) + '</span> · ' + esc(t.age) + '</div>' +
          '<div class="nm">' + esc(t.name) + '</div>' +
          '<div class="tk">$' + esc(t.ticker) + '</div>' +
          '<div class="blurb">' + esc(t.blurb) + '</div>' +
          '<div class="nums"><span class="mc">' + usd(t.mcap) + ' mcap</span><span class="mut">' + t.trades24 + ' trades/24h</span></div>' +
          '<div class="bonded">' + t.bonded.toFixed(1) + '% bonded</div>' +
        '</div>' +
      '</div></div>';
  }

  function coinRow(t) {
    return '<div class="coin" data-go="#/token/' + t.addr + '">' +
      '<div class="thumb">' + initialsBadge(t) + '</div>' +
      '<div class="info"><div class="top"><span class="nm">' + esc(t.name) + '</span><span class="tk">$' + esc(t.ticker) + '</span>' +
        '<span class="by">by <span class="mono">' + esc(t.creator) + '</span> · ' + esc(t.age) + '</span></div>' +
        '<div class="blurb">' + esc(t.blurb) + '</div>' +
        '<div class="mini-bonded"><i style="width:' + t.bonded + '%"></i></div>' +
      '</div>' +
      '<div class="right"><div class="mc">' + usd(t.mcap) + '</div>' + chg(t.change24) +
        '<div class="tr">' + t.trades24 + ' trades</div></div>' +
    '</div>';
  }

  function featuresSection() {
    var feats = [
      ["LP locked forever", "Every launch seeds a single-sided Uniswap V3 position that's permanently locked — no rug pulls, ever."],
      ["Live DEX from block one", "Real on-chain trading the instant your token launches, no presale, no migration wait."],
      ["Fees shared with creators", "Swap fees route back to whoever launched the token via FeeLocker, split automatically with the platform."],
      ["First-buy at launch", "Seed your own token the moment it deploys, in the same transaction as the launch itself."],
    ];
    return '<section class="blk wrap"><div class="grid g-2">' +
      feats.map(function (f) { return '<div class="card feat"><h3>' + esc(f[0]) + '</h3><p>' + esc(f[1]) + '</p></div>'; }).join("") +
      '</div></section>';
  }

  function exchangeSection() {
    var steps = [
      ["1", "Launch fair", "Ship straight onto a real Uniswap V3 pool — no presale, no team bag, no snipe edge. Gas-only."],
      ["2", "Liquidity locks forever", "The LP mints straight to FeeLocker on block one. No withdraw, no transfer — un-ruggable, and you can prove it on-chain."],
      ["3", "Fees come home", "Every trade's LP fees split between burning supply and paying the staking pool. Nobody's discretionary cut sits in the middle."],
    ];
    return '<section class="blk wrap">' +
      '<div class="sec-head"><span class="eyebrow">The exchange</span>' +
      '<h2>Take from the rigged game. <span class="grn">Hand it to the people.</span></h2></div>' +
      '<div class="grid g-3" style="margin-top:2.4rem">' +
        steps.map(function (s) { return '<div class="step"><div class="n">' + s[0] + '</div><h3>' + esc(s[1]) + '</h3><p>' + esc(s[2]) + '</p></div>'; }).join("") +
      '</div></section>';
  }

  function splitSection() {
    return '<section class="blk wrap" id="fees">' +
      '<div class="sec-head"><span class="eyebrow">The split · every trade</span><h2>Where the fees go</h2>' +
      '<p>No hidden cut. Every LP fee collected splits automatically on-chain — read live from FeeLocker, not a promise in a deck.</p></div>' +
      '<div class="fee-grid">' +
        '<div class="fee"><div class="big">50%</div><div class="lbl">Burned</div><div class="desc">Project token supply — gone forever</div></div>' +
        '<div class="fee"><div class="big">50% · 50%</div><div class="lbl">Staking Pool</div><div class="desc">Token side · ETH side — both fund stakers</div></div>' +
        '<div class="fee"><div class="big">50%</div><div class="lbl">Platform</div><div class="desc">Keeps the lights on</div></div>' +
      '</div>' +
      '<div class="bar-card"><div class="kicker">Project token fees</div><div class="bar-row"><span>50% burn</span><span>50% staking</span></div><div class="split"><i data-w="50"></i></div></div>' +
      '<div class="bar-card"><div class="kicker">ETH fees</div><div class="bar-row"><span>50% staking</span><span>50% platform</span></div><div class="split"><i data-w="50"></i></div></div>' +
    '</section>';
  }

  function holdSection() {
    return '<section class="blk wrap" id="hold">' +
      '<div class="sec-head"><span class="eyebrow">The Robinhood vibe</span><h2>Hold coins. <span class="grn">Get paid.</span></h2></div>' +
      '<div class="grid g-2" style="margin-top:2.4rem">' +
        '<div class="card"><h3>The house pays you back</h3><p>Every LP fee splits on-chain between burning supply and the staking pool — no discretionary cut sits in the middle. Hold coins launched here, stake them, and your share of the pool grows with every trade.</p><a class="btn btn-grn" style="margin-top:1.6rem" data-go="#/rewards">Stake and earn →</a></div>' +
        '<div class="card"><h3>Every launch, its own pool</h3><p>Rewards aren\'t platform-wide — each token spins up its own dedicated staking pool, funded only by that token\'s own trading fees. Pick a coin on the board, stake it, and your cut compounds directly from its activity.</p></div>' +
      '</div>' +
      '<div class="card" style="margin-top:1.3rem"><h3>Top builders</h3><div id="hx-builders" style="margin-top:1.2rem"></div></div>' +
    '</section>';
  }

  function closingSection() {
    return '<section class="close wrap" id="launch-cta">' +
      '<span class="eyebrow">Your turn</span>' +
      '<h2 style="margin-top:1rem">Put your <span class="grn">hood</span> up.</h2>' +
      '<p class="sub">Gas-only launch. Locked liquidity. Fees that come home.</p>' +
      '<div class="hero-cta"><a class="btn btn-grn btn-lg" data-go="#/launch">Launch a token →</a><a class="btn btn-ghost btn-lg" data-go="#/">Swap tokens</a></div>' +
    '</section>';
  }

  /* ---------------------------------------------------------
     VIEW: LAUNCH  (create a coin)
     --------------------------------------------------------- */
  function renderLaunch() {
    app.innerHTML = '<section class="blk wrap"><div class="form-wrap">' +
      '<a class="backlink" data-go="#/">← Back to the board</a>' +
      '<div class="sec-head"><span class="eyebrow">Start a new coin</span><h2>Launch fair.</h2>' +
      '<p>Gas-only. Straight onto a real pool, liquidity locked to FeeLocker on block one.</p></div>' +
      '<div class="field"><label>Name</label><input class="input" id="lf-name" placeholder="e.g. Green Arrow" maxlength="32"/></div>' +
      '<div class="row2">' +
        '<div class="field"><label>Ticker</label><input class="input" id="lf-ticker" placeholder="ARROW" maxlength="10"/></div>' +
        '<div class="field"><label>First buy (optional)</label><input class="input" id="lf-buy" inputmode="decimal" placeholder="0.0 ETH"/><div class="hint">Seed your own bag in the launch tx.</div></div>' +
      '</div>' +
      '<div class="field"><label>Description</label><textarea class="textarea" id="lf-blurb" placeholder="One line the timeline will remember…" maxlength="140"></textarea></div>' +
      '<div class="field"><label>Coin image</label><div class="dropzone" id="lf-drop"><input type="file" id="lf-file" accept="image/*" hidden/><div id="lf-drop-inner">📷 Tap to upload art — PNG / JPG / GIF</div></div></div>' +
      '<div id="lf-preview"></div>' +
      '<div class="pill-note">🔒 Liquidity locks to FeeLocker on block one — un-ruggable, provable on-chain.</div>' +
      '<button class="btn btn-grn btn-lg btn-block" id="lf-submit" style="margin-top:1.6rem">Launch on ' + CHAIN.name + ' →</button>' +
    '</div></section>';

    var img = null;
    var drop = document.getElementById("lf-drop");
    var file = document.getElementById("lf-file");
    drop.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { img = r.result; drop.classList.add("has"); document.getElementById("lf-drop-inner").innerHTML = '<img src="' + img + '" alt=""/>'; updatePreview(); };
      r.readAsDataURL(f);
    });
    ["lf-name", "lf-ticker", "lf-blurb", "lf-buy"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", updatePreview);
    });
    function updatePreview() {
      var name = val("lf-name"), tk = val("lf-ticker"), blurb = val("lf-blurb");
      if (!name && !tk) { document.getElementById("lf-preview").innerHTML = ""; return; }
      document.getElementById("lf-preview").innerHTML =
        '<div class="launch-preview"><div class="pv-thumb">' + (img ? '<img src="' + img + '" style="width:100%;height:100%;object-fit:cover;border-radius:12px"/>' : '<span class="mono">' + esc((tk || "?")[0]) + '</span>') + '</div>' +
        '<div><div style="font-weight:800">' + esc(name || "Untitled") + ' <span class="grn">$' + esc(tk || "TICKER") + '</span></div><div class="mut" style="font-size:.88rem">' + esc(blurb || "no description yet") + '</div><div class="mut" style="font-size:.78rem;margin-top:.3rem">bonding curve · locked LP</div></div></div>';
    }
    document.getElementById("lf-submit").addEventListener("click", function () {
      var name = val("lf-name"), tk = val("lf-ticker");
      if (!name || !tk) { toast("Name and ticker are required.", true); return; }
      var btn = this; btn.disabled = true; btn.textContent = "Launching…";
      HX.api.launchToken({ name: name, ticker: tk, blurb: val("lf-blurb"), imageDataUrl: img, firstBuyEth: val("lf-buy") })
        .then(function (res) { toast("Launched $" + tk + "!"); go("#/token/" + (res && res.addr ? res.addr : "")); })
        .catch(function (e) { toast(e.msg || "Not wired yet.", true); btn.disabled = false; btn.textContent = "Launch on " + CHAIN.name + " →"; });
    });
    wireGoLinks();
  }

  /* ---------------------------------------------------------
     VIEW: TOKEN  (trade page)
     --------------------------------------------------------- */
  function renderToken(addr) {
    HX.api.getToken(addr).then(function (t) {
      if (!t) { app.innerHTML = '<section class="blk wrap"><a class="backlink" data-go="#/">← Back</a><div class="empty">Coin not found.</div></section>'; wireGoLinks(); return; }
      app.innerHTML = '<section class="blk wrap">' +
        '<a class="backlink" data-go="#/">← Back to the board</a>' +
        '<div class="tok-head"><div class="thumb">' + initialsBadge(t) + '</div>' +
          '<div style="flex:1"><div class="nm">' + esc(t.name) + ' <span class="tk">$' + esc(t.ticker) + '</span></div>' +
          '<div class="addr mono">' + esc(t.addr) + '</div></div>' +
          '<a class="btn btn-ghost btn-sm" data-go="#/rewards">🎁 Stake</a></div>' +
        '<div class="tok-grid">' +
          '<div><div class="chart-card">' +
            '<div class="chart-top"><div><div class="chart-price">' + usd(t.priceUsd) + '</div><div class="mut" style="font-size:.82rem">price</div></div>' +
            '<div class="chart-chg">' + chg(t.change24) + '</div></div>' +
            '<div class="chart" id="hx-chart"></div>' +
          '</div>' +
          '<div class="tok-stats">' +
            stat(usd(t.mcap), "Market cap") + stat(usd(t.volume24), "Volume 24h") +
            stat(t.holders, "Holders") + stat(t.bonded.toFixed(1) + "%", "Bonded") +
          '</div>' +
          '<div class="card" style="margin-top:1.4rem"><h3 style="font-size:1.05rem">Holders</h3><div class="holders" id="hx-holders"></div></div>' +
          '</div>' +
          tradePanel(t) +
        '</div>' +
      '</section>';
      HX.api.priceHistory(addr).then(function (pts) { drawChart(pts, t.change24 >= 0); });
      HX.api.holders(addr).then(function (hs) {
        document.getElementById("hx-holders").innerHTML = hs.map(function (h) {
          return '<div class="holder"><span class="ad mono">' + esc(h.addr) + '</span><div class="bar"><i style="width:' + Math.min(100, h.pct) + '%"></i></div><span class="pct">' + h.pct.toFixed(1) + "%</span></div>";
        }).join("");
      });
      wireTrade(t);
      wireGoLinks();
    });
  }

  function stat(v, l) { return '<div class="st"><div class="v">' + v + '</div><div class="l">' + l + "</div></div>"; }

  function tradePanel(t) {
    return '<div><div class="trade">' +
      '<div class="trade-tabs"><button class="trade-tab buy active" data-side="buy">Buy</button><button class="trade-tab sell" data-side="sell">Sell</button></div>' +
      '<div class="amt"><input id="tr-amt" inputmode="decimal" placeholder="0.0"/><span class="cur" id="tr-cur">ETH</span></div>' +
      '<div class="quick" id="tr-quick"></div>' +
      '<div class="out"><span>You receive ≈</span><b id="tr-out">— ' + esc(t.ticker) + '</b></div>' +
      '<button class="btn btn-grn btn-block" id="tr-go">Buy ' + esc(t.ticker) + '</button>' +
      '<div class="mut" style="font-size:.76rem;text-align:center;margin-top:.8rem">Swaps route through the locked V3 pool. Fees split on every trade.</div>' +
    '</div></div>';
  }

  function wireTrade(t) {
    var side = "buy";
    var amt = document.getElementById("tr-amt");
    var quick = document.getElementById("tr-quick");
    function renderQuick() {
      quick.innerHTML = (side === "buy" ? ["0.05", "0.1", "0.5", "1"] : ["25%", "50%", "75%", "Max"])
        .map(function (q) { return "<button>" + q + "</button>"; }).join("");
    }
    function preview() {
      var v = parseFloat(amt.value) || 0;
      var out;
      if (side === "buy") out = v > 0 ? Math.floor(v / t.priceUsd * 2000).toLocaleString() + " " + t.ticker : "— " + t.ticker;
      else out = v > 0 ? "$" + (v * t.priceUsd).toPrecision(3) : "— ETH";
      document.getElementById("tr-out").textContent = "≈ " + out;
    }
    document.querySelectorAll(".trade-tab").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(".trade-tab").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active"); side = b.getAttribute("data-side");
        document.getElementById("tr-cur").textContent = side === "buy" ? "ETH" : t.ticker;
        var go = document.getElementById("tr-go");
        go.textContent = (side === "buy" ? "Buy " : "Sell ") + t.ticker;
        go.className = "btn btn-block " + (side === "buy" ? "btn-grn" : "btn-red");
        document.querySelector('.out span').textContent = side === "buy" ? "You receive ≈" : "You receive ≈";
        amt.value = ""; renderQuick(); preview();
      });
    });
    quick.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var txt = b.textContent;
      if (side === "buy") amt.value = txt;
      else amt.value = txt === "Max" ? "100" : parseFloat(txt);
      preview();
    });
    amt.addEventListener("input", preview);
    document.getElementById("tr-go").addEventListener("click", function () {
      var v = parseFloat(amt.value) || 0;
      if (v <= 0) { toast("Enter an amount.", true); return; }
      var fn = side === "buy" ? HX.api.buy : HX.api.sell;
      fn(t.addr, v).then(function () { toast("Order sent."); }).catch(function (e) { toast(e.msg || "Not wired yet.", true); });
    });
    renderQuick(); preview();
  }

  // simple SVG area chart from [{t,p}]
  function drawChart(pts, up) {
    var box = document.getElementById("hx-chart"); if (!box) return;
    var W = 640, H = 220, pad = 6;
    var ps = pts.map(function (p) { return p.p; });
    var min = Math.min.apply(null, ps), max = Math.max.apply(null, ps);
    var rng = (max - min) || 1;
    var stepX = (W - pad * 2) / (pts.length - 1);
    var coords = pts.map(function (p, i) {
      var x = pad + i * stepX;
      var y = pad + (H - pad * 2) * (1 - (p.p - min) / rng);
      return [x, y];
    });
    var line = coords.map(function (c, i) { return (i ? "L" : "M") + c[0].toFixed(1) + " " + c[1].toFixed(1); }).join(" ");
    var area = line + " L" + (W - pad) + " " + (H - pad) + " L" + pad + " " + (H - pad) + " Z";
    var col = up ? "#8fd0a5" : "#e57373";
    box.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="price chart">' +
      '<defs><linearGradient id="hxg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + col + '" stop-opacity=".28"/><stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#hxg)"/>' +
      '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' +
    '</svg>';
  }

  /* ---------------------------------------------------------
     VIEW: REWARDS
     --------------------------------------------------------- */
  function renderRewards() {
    app.innerHTML = '<section class="blk wrap">' +
      '<a class="backlink" data-go="#/">← Back to the board</a>' +
      '<div class="sec-head center"><span class="eyebrow">Holder rewards</span><h2>Hold coins. Get paid.</h2>' +
      '<p>Each coin runs its own pool, funded only by that coin\'s trading fees. Stake what you hold and your cut compounds from every trade.</p></div>' +
      '<div class="reward-hero" style="margin-top:2rem"><div class="big" id="rw-claim">0.00 ETH</div><div class="mut">claimable across your staked pools</div>' +
        '<button class="btn btn-grn btn-lg" id="rw-btn" style="margin-top:1.4rem">Claim rewards</button></div>' +
      '<div class="grid g-3" style="margin-top:1.4rem" id="rw-pools"></div>' +
    '</section>';
    // pools = per-token pools you could stake into
    HX.api.listTokens("all", "mcap", "").then(function (list) {
      document.getElementById("rw-pools").innerHTML = list.slice(0, 6).map(function (t) {
        var apr = (10 + t.bonded / 2).toFixed(0);
        return '<div class="card" style="padding:1.4rem"><div style="display:flex;align-items:center;gap:.7rem"><div class="thumb" style="width:40px;height:40px;border-radius:10px;border:1px solid var(--bd);display:grid;place-items:center">' + initialsBadge(t) + '</div><div><div style="font-weight:800">$' + esc(t.ticker) + '</div><div class="mut" style="font-size:.8rem">' + usd(t.mcap) + ' mcap</div></div></div>' +
          '<div style="display:flex;justify-content:space-between;margin-top:1rem"><span class="mut" style="font-size:.85rem">Pool APR</span><span class="grn" style="font-weight:800">~' + apr + '%</span></div>' +
          '<button class="btn btn-ghost btn-sm btn-block" style="margin-top:1rem" data-go="#/token/' + t.addr + '">Get $' + esc(t.ticker) + '</button></div>';
      }).join("");
      wireGoLinks();
    });
    document.getElementById("rw-btn").addEventListener("click", function () {
      HX.api.claimRewards().then(function () { toast("Claimed."); }).catch(function (e) { toast(e.msg || "Not wired yet.", true); });
    });
    wireGoLinks();
  }

  /* ---------------------------------------------------------
     shared wiring
     --------------------------------------------------------- */
  function wireGoLinks() {
    document.querySelectorAll("[data-go]").forEach(function (a) {
      if (a._wired) return; a._wired = true;
      a.addEventListener("click", function (e) { e.preventDefault(); go(a.getAttribute("data-go")); });
    });
  }
  function animateBars() {
    var bars = document.querySelectorAll(".split > i");
    if (!("IntersectionObserver" in window)) { bars.forEach(function (b) { b.style.width = (b.dataset.w || 50) + "%"; }); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.style.transition = "width 1.1s cubic-bezier(.2,.8,.2,1)"; e.target.style.width = (e.target.dataset.w || 50) + "%"; io.unobserve(e.target); } });
    }, { threshold: .4 });
    bars.forEach(function (b) { io.observe(b); });
  }
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ""; }
  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }

  /* ---------------------------------------------------------
     boot
     --------------------------------------------------------- */
  HX.boot = function () {
    app = document.getElementById("hx-app");
    // persistent nav / footer go-links
    wireGoLinks();
    window.addEventListener("hashchange", router);
    router();
  };
})();
