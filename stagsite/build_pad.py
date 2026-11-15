#!/usr/bin/env python3
"""Generates the /pad pages for the $STAG site. Reuses the deployed site's own CSS, header and footer (taken from stagr/index.html)
so the pad matches the rest of the site, and adds a Pad link to the nav. Run: python3 build_pad.py"""
import pathlib, re, html

D = pathlib.Path(__file__).parent
src = (D / "index.html").read_text()   # the home page carries the full current nav and footer
STYLE = re.search(r"<style>(.*?)</style>", src, re.S).group(1)
HEAD_START = src.index("<header>")
HEAD = src[HEAD_START: src.index("</header>") + 9]
FOOT = src[src.index("<footer>"): src.index("</footer>") + 9]
# The Pad is NOT linked from the site nav or footer until the owner says it is ready (it is reachable by URL only).
HEAD = HEAD.replace('<a href="/pad/">Pad</a>', '')
FOOT = FOOT.replace('<a href="/pad/">Pad</a>', '')
HEAD = HEAD.replace('<a class="btn solid" href="https://t.me/StagWifHood" rel="noopener">Join Telegram</a>',
                    '<a class="btn solid" href="https://t.me/StagWifHood" rel="noopener">Join Telegram</a>')

EXTRA = """
.padnote{border:1px solid var(--gold);background:rgba(255,200,60,.07);color:var(--gold-hi);border-radius:14px;padding:14px 18px;margin:0 0 22px;font-size:15px}
.padnote a{color:inherit}
.muted{color:var(--muted)}
.row{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between}
.padcard .kv,.padbox .kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line);font-size:15px}
.padcard .kv:last-child,.padbox .kv:last-child{border-bottom:0}
.padcard small,.padbox small,.sec-h small{font:700 .5em var(--mono);color:var(--muted);letter-spacing:.06em}
.padbox{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:20px;padding:22px 24px;margin:0 0 22px}
.padbox h3{font-size:26px;margin-bottom:12px}
.padgrid{align-items:start}
.padstats2{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 26px}
.padstats2>div{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.padstats2 span{font:700 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.padstats2 b{font-size:20px}
@media(max-width:900px){.padstats2{grid-template-columns:1fr 1fr}}
.inp{width:100%;background:#0a110b;color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:13px 14px;font:500 16px/1.2 inherit;font-family:inherit;margin:6px 0 14px}
.inp:focus{outline:2px solid var(--neon);outline-offset:1px}
.lbl{display:block;font:700 12px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-top:6px}
.tabs{display:flex;gap:8px;margin-bottom:14px}
.tab{flex:1;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:12px;font:700 14px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
.tab.on{background:var(--neon);color:#031005;border-color:var(--neon)}
.quote{min-height:48px;padding:12px 14px;background:var(--panel);border:1px dashed var(--line);border-radius:12px;font-size:15px;margin-bottom:14px}
.cta{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.cta .btn[disabled],.btn[disabled]{opacity:.45;cursor:not-allowed}
.plain{margin:0 0 6px 18px;padding:0;display:grid;gap:8px}
.padtoast{position:fixed;right:16px;bottom:16px;display:grid;gap:8px;z-index:60;max-width:min(92vw,420px)}
.padtoast .pt{background:#0d160e;border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:14px}
.padtoast .pt.ok{border-color:var(--neon)}.padtoast .pt.err{border-color:#ff6b6b;color:#ffd6d6}
.padmodal{position:fixed;inset:0;background:rgba(0,0,0,.7);display:grid;place-items:center;z-index:70;padding:16px}
.padmodal .pm{background:#0b130c;border:1px solid var(--neon);border-radius:20px;padding:24px;max-width:560px;width:100%;max-height:90vh;overflow:auto}
.padmodal .pm h3{font-size:28px;margin-bottom:12px}.padmodal .pmc{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}
.warnbox{border:1px solid #ff9f43;background:rgba(255,159,67,.07);border-radius:14px;padding:14px 18px;margin:18px 0}
.how h2{font-size:clamp(28px,4vw,44px);margin:34px 0 10px}.how p,.how li{color:#c4d6c0;font-size:17px;line-height:1.55}.how ul{margin:8px 0 8px 20px;display:grid;gap:8px}
table.fees{width:100%;border-collapse:collapse;margin:12px 0}table.fees th,table.fees td{border:1px solid var(--line);padding:10px 12px;text-align:left;font-size:15px;color:#c4d6c0}table.fees th{color:var(--fg)}
"""

def page(title, desc, body, path, pg):
    return f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{html.escape(title)}</title><meta name="description" content="{html.escape(desc)}"><meta property="og:title" content="{html.escape(title)}"><meta property="og:description" content="{html.escape(desc)}"><meta property="og:image" content="https://stagwifhood.fun/assets/poster.webp"><meta name="theme-color" content="#050806"><meta name="robots" content="noindex,nofollow"><link rel="icon" href="/assets/badge.webp">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow:wght@400;500;600&family=Space+Mono:wght@700&display=swap">
<style>{STYLE}{EXTRA}</style>
<body data-page="{pg}">
{HEAD}
{body}
{FOOT}
<script src="/pad/ethers.umd.min.js"></script>
<script src="/pad/config.js"></script>
<script src="/pad/pad.js"></script>
</body>
</html>"""

SUBNAV = '<div class="in" style="display:flex;flex-wrap:wrap;gap:10px;padding-top:22px"><a class="btn" href="/pad/">Pad</a><a class="btn" href="/pad/launch/">Launch</a><a class="btn" href="/pad/battles/">Battles</a><a class="btn" href="/pad/how/">How it works</a><span style="flex:1"></span><button class="btn solid" data-wallet>Connect wallet</button></div>'

home = f"""<main>{SUBNAV}
<section class="hero"><div class="in"><div>
<span class="eyebrow">$STAG Pad · Robinhood Chain</span>
<h1>Launch a token. Win the <em>chest</em>.</h1>
<p class="lead">Every token launches paired with $STAG, with its liquidity locked from the first second. Creators earn from trading. Tokens can fight: more trading volume wins the other side's war chest, and the winner burns it.</p>
<div class="cta"><a class="btn solid" href="/pad/launch/">Launch a token</a><a class="btn" href="/pad/how/">How it works</a></div>
<div class="stats" id="padstats"><span><b>3%</b> tax on the $STAG side</span><span><b>Locked</b> liquidity</span><span><b>Robinhood</b> Chain</span></div>
</div></div></section>
<section class="band"><div class="in"><div id="notlive"></div><span class="eyebrow">Launches</span><h2 class="sec-h">Latest tokens</h2><div class="grid" id="padlist"><p class="muted">Loading…</p></div></div></section>
<section class="band alt"><div class="in"><span class="eyebrow">Read this first</span><h2 class="sec-h">Plain risks</h2>
<ul class="plain"><li>Tokens launched here are created by anyone and can lose most or all of their value. Many will.</li><li>The pad takes a 3% tax on the $STAG side of every trade. Creators also earn the pool's 0.30% fee.</li><li>Battles are decided by trading volume, and volume counts even if it is wash trading. A well-funded token can outspend a small one.</li><li>The contracts have been tested on a copy of the real chain and reviewed repeatedly, but they have not had a professional third-party audit. Bugs can exist.</li><li>Nothing here is financial advice or a promise of returns. Only use money you can afford to lose.</li></ul></div></section>
</main>"""

launch = f"""<main>{SUBNAV}
<section class="band"><div class="in"><div id="notlive"></div><span class="eyebrow">Create</span><h1 class="sec-h">Launch a token</h1>
<p class="sec-p">One transaction makes the token and opens its pool with $STAG. The full supply goes into the pool as locked liquidity. There is no launch fee and no minimum buy.</p>
<form id="launchform" class="padbox"><label class="lbl" for="tname">Token name</label><input id="tname" name="tname" class="inp" maxlength="32" required placeholder="Stag Coin">
<label class="lbl" for="tsym">Symbol</label><input id="tsym" name="tsym" class="inp" maxlength="12" required placeholder="STAGC">
<label class="lbl" for="fdv">Starting value in $STAG (minimum 1,000,000)</label><input id="fdv" name="fdv" class="inp" inputmode="decimal" required value="1000000">
<label class="lbl">Mode</label><div class="tabs"><label class="tab on"><input type="radio" name="mode" value="war" checked style="margin-right:8px">War</label><label class="tab"><input type="radio" name="mode" value="peace" style="margin-right:8px">Peace</label></div>
<div class="quote" id="modeinfo"></div>
<div class="warnbox"><b>Before you launch:</b> launching is final, you receive no free tokens, and you cannot pull the liquidity. Launching a token to deceive people is not allowed by us and may be illegal where you live.</div>
<div class="cta"><button class="btn solid" id="launchgo" type="submit" disabled>Launch token</button></div></form></div></section>
</main>"""

token = f"""<main>{SUBNAV}
<section class="band"><div class="in"><div id="notlive"></div><div id="tokroot"><p class="muted">Loading…</p></div></div></section>
</main>"""

battles = f"""<main>{SUBNAV}
<section class="band"><div class="in"><div id="notlive"></div><span class="eyebrow">Battles</span><h1 class="sec-h">Token vs token</h1>
<p class="sec-p">A creator in war mode offers a battle and sets the length. The other creator accepts or the offer lapses after 3 days. Both pools are locked while it runs. More trading volume wins. Only what each token earned during the fight is at stake, and the winner's chest is marked to be burned.</p>
<div id="battlelist"><p class="muted">Loading…</p></div>
<h2 class="sec-h" style="margin-top:40px">Offer a battle</h2><div id="battlemine" class="padbox"></div></div></section>
</main>"""

how = f"""<main>{SUBNAV}
<section class="band how"><div class="in"><span class="eyebrow">How it works</span><h1 class="sec-h">The rules, in plain words</h1>
<div id="notlive"></div>
<h2>Launching</h2><p>A creator picks a name, a symbol and a starting value in $STAG (at least 1,000,000). One transaction creates the token (fixed supply of 1 billion, no minting) and puts all of it into a Uniswap pool paired with $STAG. That liquidity is locked by the contract: nobody can remove it, including the creator and us. The creator receives no free tokens. The creator earns the pool's 0.30% trading fee and can collect it at any time.</p>
<h2>The 3% tax</h2><table class="fees"><tr><th>Trade</th><th>Tax</th><th>Where it goes</th></tr>
<tr><td>Sell (token to $STAG)</td><td>3% of the $STAG you receive</td><td>The platform</td></tr>
<tr><td>Buy, war mode</td><td>3% of the $STAG you pay</td><td>The token's war chest</td></tr>
<tr><td>Buy, peace mode</td><td>3% of the $STAG you pay</td><td>1% to the creator, 2% to all holders in proportion to what they hold</td></tr></table>
<p>Prices you see in the trade box already include the tax. The pool's 0.30% fee is paid to the creator on top.</p>
<h2>War and peace</h2><p>The creator picks the mode and can switch while no battle holds the pool. Switching only changes later buys: the existing chest stays where it is. Every token page shows its current mode, and you should check it before you buy, because the creator can change it.</p>
<h2>The war chest and burns</h2><p>In war mode the buy tax builds a chest of $STAG. The creator can spend the chest buying their own token from the pool and burning what comes back. A burn moves the price by at most about 1.5%, only one burn is allowed per hour, and anything the pool cannot fill within that limit stays in the chest.</p>
<h2>Battles</h2><ul><li>A creator in war mode offers a battle to another token and sets how long it runs (1 hour to 14 days). The offer locks their pool (no mode change, no burning) and lapses after 3 days if not accepted.</li><li>The other creator accepts on chain. Both pools stay locked until the end.</li><li>The token with more <b>gross trading volume</b> during the fight wins. Volume counts even when it is wash trading, so a larger wallet can outspend a smaller one. That is part of the game and you should know it before you enter.</li><li>Only what each pool earned into its chest <b>during the fight</b> is at stake. The loser's fight earnings go to the winner's chest, and the winner's fight earnings plus that prize are marked to be burned. Older chest money stays with its pool.</li><li>A tie moves nothing. Nobody, including us, can pick or change a result.</li><li>If the winner's creator does not burn, anyone can burn the marked chest in steps, one per hour, with the creator getting the first chance each hour.</li></ul>
<h2>What can go wrong</h2><ul><li>Tokens can lose most or all of their value. Thin pools can be pushed around by large trades.</li><li>The creator can switch war and peace at any time while no battle holds the pool.</li><li>The contracts are new. They were tested on a copy of the real chain and reviewed repeatedly by independent reviewers, but they have <b>not</b> had a professional third-party audit.</li><li>Some wallets and tools show prices without the 3% tax. Use the trade box here for the real number.</li><li>Gas fees and the $STAG curve's own fees apply when you trade through ETH.</li></ul>
<p class="fine">Nothing here is financial advice or a promise of returns. $STAG and tokens launched on the pad are volatile. You can lose everything you put in.</p></div></section>
</main>"""

def write(rel, content):
    p = D / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    print("wrote", rel)

write("pad/index.html", page("$STAG Pad | Launch a token, win the chest", "Launch tokens paired with $STAG on Robinhood Chain. Locked liquidity, war chests and token battles.", home, "/pad/", "home"))
write("pad/launch/index.html", page("Launch a token | $STAG Pad", "Create a token paired with $STAG in one transaction.", launch, "/pad/launch/", "launch"))
write("pad/token/index.html", page("Token | $STAG Pad", "Trade and manage a token launched on the $STAG Pad.", token, "/pad/token/", "token"))
write("pad/battles/index.html", page("Battles | $STAG Pad", "Token vs token battles on the $STAG Pad.", battles, "/pad/battles/", "battles"))
write("pad/how/index.html", page("How the pad works | $STAG Pad", "The rules of the $STAG Pad in plain words: fees, war and peace, battles and risks.", how, "/pad/how/", "how"))

# make sure the existing pages do not link to the pad yet (idempotent)
for rel in ("index.html", "stagr/index.html"):
    f = D / rel
    s = f.read_text()
    if 'href="/pad/"' in s:
        f.write_text(s.replace('<a href="/pad/">Pad</a>', ''))
        print("pad link removed from", rel)
