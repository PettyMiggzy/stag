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
[hidden]{display:none !important}
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

/* ---- look: dark forest, glowing war (green) / peace (gold) borders ---- */
:root{--glow:0 0 0 1px rgba(57,255,20,.35),0 0 26px rgba(57,255,20,.16)}
.hero{position:relative;background:linear-gradient(90deg,#050806 0%,rgba(5,8,6,.88) 38%,rgba(5,8,6,.15) 75%),url(/pad/assets/hero.webp) right center/cover no-repeat;border-bottom:1px solid var(--line)}
.hero .in{min-height:min(520px,70vh);display:flex;align-items:center}
.hero .stats{display:flex;flex-wrap:wrap;gap:12px;margin-top:26px}
.hero .stats span{background:rgba(5,8,6,.72);border:1px solid rgba(57,255,20,.45);box-shadow:var(--glow);border-radius:14px;padding:12px 18px;font:600 13px/1.2 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.hero .stats b{display:block;font:400 28px/1.1 Anton,Impact,sans-serif;letter-spacing:.02em;color:var(--fg);text-transform:none;margin-bottom:2px}
.padcard{padding:0;overflow:hidden;border:1px solid rgba(57,255,20,.5);box-shadow:var(--glow);border-radius:18px;transition:transform .15s,box-shadow .15s}
.padcard.peace{border-color:rgba(255,200,60,.55);box-shadow:0 0 0 1px rgba(255,200,60,.3),0 0 26px rgba(255,200,60,.12)}
.padcard:hover,.padcard:focus-visible{transform:translateY(-3px)}
.padcard .art{aspect-ratio:4/3;background:#07100a center/cover no-repeat;border-bottom:1px solid var(--line)}
.padcard .art.ini{display:grid;place-items:center;background:radial-gradient(circle at 50% 40%,hsl(var(--h) 60% 22%),#050806 75%)}
.padcard .art.ini span{font:400 clamp(36px,6vw,56px)/1 Anton,Impact,sans-serif;color:hsl(var(--h) 80% 70%);letter-spacing:.04em}
.padcard .b{padding:14px 16px 16px}
.padcard h3{font-size:22px;margin:8px 0 8px}
.chip{display:inline-block;border-radius:8px;padding:5px 10px;font:700 12px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;background:var(--neon);color:#031005}
.chip.soon{background:var(--gold);color:#241800}
.padbox{border-color:rgba(57,255,20,.4);box-shadow:var(--glow)}
.padstats2>div{border-color:rgba(57,255,20,.4);box-shadow:var(--glow);background:rgba(7,14,9,.9)}
.padstats2 b{font:400 26px/1.1 Anton,Impact,sans-serif;letter-spacing:.02em}
.inp{background:#060b07;border-color:rgba(57,255,20,.4)}
.inp#amt{font:400 34px/1.1 Anton,Impact,sans-serif;padding:16px}
#tradeBtn,#launchgo{font-size:20px;padding:16px 22px;width:100%;box-shadow:0 0 28px rgba(57,255,20,.35)}
.quote{background:rgba(7,14,9,.9);border:1px solid var(--line)}
.tab{min-height:44px}
#launchform .tabs{gap:14px}
#launchform .tab{position:relative;min-height:150px;display:flex;align-items:flex-end;justify-content:center;padding:12px;background:#07100a center/cover no-repeat;border:2px solid var(--line);overflow:hidden;color:#fff;text-shadow:0 2px 8px #000}
#launchform .tab::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.8))}
#launchform .tab>*,#launchform .tab{z-index:0}
#launchform .tab input{position:relative}
#launchform .tab:nth-child(1){background-image:url(/pad/assets/a-chest.webp)}
#launchform .tab:nth-child(2){background-image:url(/pad/assets/a-lantern.webp)}
#launchform .tab:not(.on){filter:saturate(.55) brightness(.75)}
#launchform .tab.on{background-color:#07100a;border-color:var(--neon);box-shadow:var(--glow);color:#fff}
#launchform .tab:nth-child(2).on{border-color:var(--gold);box-shadow:0 0 0 1px rgba(255,200,60,.3),0 0 26px rgba(255,200,60,.14)}
.padbox.bt{position:relative;overflow:hidden;border-color:rgba(57,255,20,.45);background:linear-gradient(90deg,rgba(57,255,20,.10),rgba(5,8,6,.9) 45%,rgba(255,200,60,.10)),var(--panel)}
.padbox.bt h3{text-align:center;font-size:30px}
.padbox.bt h3 small{color:var(--neon);font-size:.6em;padding:0 8px}
.padbox.bt p{text-align:center;max-width:none;margin:8px 0}
.padbox.bt .row{justify-content:center}
.battle-hero{height:clamp(150px,26vw,260px);border-radius:20px;border:1px solid rgba(57,255,20,.4);box-shadow:var(--glow);background:linear-gradient(180deg,transparent 40%,#050806),url(/pad/assets/battle.webp) center/cover;margin:0 0 22px}
@media(max-width:720px){.hero{background:linear-gradient(180deg,rgba(5,8,6,.55),#050806 85%),url(/pad/assets/hero.webp) 70% top/cover no-repeat}.hero .in{min-height:0;padding:56px 0 24px}#launchform .tab{min-height:110px}}
@media(prefers-reduced-motion:reduce){.padcard{transition:none}}

.bgrid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:18px 0}
@media(max-width:900px){.bgrid{grid-template-columns:1fr}}
.bside.ga{border-color:rgba(57,255,20,.5)}.bside.gb{border-color:rgba(255,200,60,.55);box-shadow:0 0 0 1px rgba(255,200,60,.3),0 0 26px rgba(255,200,60,.12)}
.bside h4{font:700 12px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:18px 0 8px}
.bside .bname{color:inherit;text-decoration:none}
.padstats2.two{grid-template-columns:1fr 1fr;margin:12px 0 4px}
.padstats2.two b{font-size:20px}
.tbl{width:100%;border-collapse:collapse}.tbl td{padding:7px 4px;border-bottom:1px solid var(--line);font-size:15px}.tbl td:last-child{text-align:right;white-space:nowrap}
.tag{font:700 10px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--line);border-radius:6px;padding:2px 5px;color:var(--muted)}
.small{font-size:14px}
.vs{color:var(--neon);font-size:.6em;padding:0 .2em}
.vsbar{display:flex;height:16px;border-radius:10px;overflow:hidden;background:var(--panel);border:1px solid var(--line)}
.vsbar i{background:var(--neon)}.vsbar b{background:var(--gold)}
.vslab{font:700 13px/1 var(--mono);color:var(--muted);margin:8px 0 6px}

/* battle page */
.btop{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin:0 0 12px}
.chip.live{background:#ff3b3b;color:#fff}.chip.grey{background:var(--panel);color:var(--muted);border:1px solid var(--line)}
.vsb{position:relative;border-radius:22px;overflow:hidden;border:2px solid rgba(57,255,20,.55);box-shadow:0 0 34px rgba(57,255,20,.18);min-height:clamp(240px,36vw,430px);background:#050806}
.vsb .halves{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr}
.vsb .half{position:relative;overflow:hidden;display:flex;align-items:flex-end}
.vsb .half::before{content:"";position:absolute;inset:-6%;background:url(/pad/assets/battle.webp) no-repeat;background-size:200% 100%;will-change:transform}
.vsb .half.ga::before{background-position:left center;animation:drift 16s ease-in-out infinite alternate}
.vsb .half.gb::before{background-position:right center;animation:drift 16s ease-in-out infinite alternate-reverse}
.vsb .half::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 45%,rgba(5,8,6,.88))}
.vsb .half.ga{box-shadow:inset 0 0 0 2px rgba(57,255,20,.0)}
.vsb .hn{position:relative;z-index:1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:18px 22px;max-width:100%}
.vsb .gb .hn{margin-left:auto;justify-content:flex-end;padding-right:22px}
.vsb h2{font:400 clamp(22px,3.5vw,52px)/1 Anton,Impact,sans-serif;text-shadow:0 3px 14px #000;margin:0;letter-spacing:.01em}
.pfp{width:clamp(44px,6vw,76px);aspect-ratio:1;border-radius:50%;border:3px solid currentColor;background:center/cover;display:grid;place-items:center;font:400 clamp(16px,2.4vw,28px)/1 Anton,Impact,sans-serif;flex:none}
.ga .pfp{color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.5)}.gb .pfp{color:var(--gold);box-shadow:0 0 18px rgba(255,200,60,.45)}
.pfp.ini{background:radial-gradient(circle,hsl(var(--h) 55% 24%),#050806);color:inherit}
.vsb .bolt{position:absolute;left:50%;top:0;bottom:0;width:64px;transform:translateX(-50%);background:linear-gradient(180deg,#fff,#eaffe0);filter:drop-shadow(0 0 8px #fff) drop-shadow(0 0 20px rgba(57,255,20,.85));clip-path:polygon(46% 0,64% 0,54% 28%,80% 28%,40% 62%,56% 62%,30% 100%,38% 68%,20% 68%,48% 36%,30% 36%);z-index:2;opacity:.92}
.vsb .mid{position:absolute;left:50%;top:14px;transform:translateX(-50%);text-align:center;z-index:3;width:min(44%,460px)}
.vsb .cd{font:400 clamp(26px,5.4vw,70px)/1 Anton,Impact,sans-serif;letter-spacing:.04em;text-shadow:0 3px 16px #000}
.vsb .cd.small{font-size:clamp(22px,3.6vw,46px)}
.vsb .cdl{font:700 12px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:#d9e8d4;text-shadow:0 2px 8px #000;margin-top:4px}
.tug{display:flex;gap:6px;margin:14px 0 6px;height:50px}
.tug i,.tug b{display:flex;align-items:center;font:400 28px/1 Anton,Impact,sans-serif;padding:0 14px;border-radius:12px;min-width:64px;font-style:normal;transition:width .6s}
.tug i{background:var(--neon);color:#031005;justify-content:flex-start;box-shadow:0 0 22px rgba(57,255,20,.35)}
.tug b{background:var(--gold);color:#241800;justify-content:flex-end}
.tugn{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:22px;font:400 26px/1 Anton,Impact,sans-serif}
.feed{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;font:500 13px/1.2 var(--mono);color:var(--muted);flex:1}
.feed span{display:inline-flex;align-items:center;gap:6px}.feed i{width:8px;height:8px;border-radius:50%;display:inline-block}
.feed .ga i{background:var(--neon)}.feed .gb i{background:var(--gold)}
.bcols{display:grid;grid-template-columns:1fr 1fr;gap:22px}
@media(max-width:900px){.bcols{grid-template-columns:1fr}.vsb .mid{position:absolute;left:50%;top:14px;transform:translateX(-50%);text-align:center;z-index:3;width:min(44%,460px)}.vsb .hn{padding:12px}.tugn{font-size:18px}.feed{display:none}}
.bcol .bh{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.bcol .bh h2{font:400 clamp(28px,3.4vw,44px)/1 Anton,Impact,sans-serif;margin:0}
.chip.lead{font-size:13px}
.stiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.stiles>div{border:2px solid var(--c);border-radius:12px;padding:10px 12px;background:rgba(7,14,9,.9);box-shadow:0 0 18px color-mix(in srgb,var(--c) 22%,transparent)}
.stiles span{display:block;font:700 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.stiles b{font:400 clamp(17px,1.9vw,24px)/1.1 Anton,Impact,sans-serif}
.bcol{--c:var(--neon)}.bcol.gb{--c:var(--gold)}
.up{color:var(--neon)}.dn{color:#ff6b6b}
.tabs2{display:grid;grid-template-columns:repeat(3,1fr);border:2px solid var(--c);border-radius:12px;overflow:hidden;margin-bottom:10px;background:var(--panel)}
.tabs2 button{background:transparent;border:0;color:var(--muted);font:400 18px/1 Anton,Impact,sans-serif;letter-spacing:.04em;padding:11px 6px;min-height:44px;cursor:pointer;text-transform:uppercase}
.tabs2 button.on{background:color-mix(in srgb,var(--c) 26%,#050806);color:var(--c)}
.rk{display:grid;grid-template-columns:34px 30px minmax(92px,1.1fr) minmax(40px,1.6fr) auto;align-items:center;gap:10px;padding:9px 10px;margin:0 0 6px;border-radius:10px;border:1px solid var(--line);background:rgba(7,14,9,.85);font-size:15px}
.rk .rn{font:400 18px/1 Anton,Impact,sans-serif;color:var(--muted);text-align:center}
.rk.r1{border-color:#e8b923;background:linear-gradient(90deg,rgba(232,185,35,.16),rgba(7,14,9,.85))}.rk.r1 .rn{color:#e8b923}
.rk.r2{border-color:#b9c3c7;background:linear-gradient(90deg,rgba(185,195,199,.12),rgba(7,14,9,.85))}.rk.r2 .rn{color:#cfd8dc}
.rk.r3{border-color:#c47a3a;background:linear-gradient(90deg,rgba(196,122,58,.14),rgba(7,14,9,.85))}.rk.r3 .rn{color:#d98a45}
.rk .av{width:28px;height:28px;border-radius:50%;background:radial-gradient(circle at 35% 30%,hsl(var(--h) 80% 70%),hsl(calc(var(--h) + 60) 60% 30%));border:2px solid rgba(255,255,255,.25);display:block}
.rk .ra a{color:var(--fg)}
.rk .rb{height:8px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden;display:block}.rk .rb u{display:block;height:100%;background:var(--c);border-radius:6px}
.rk.r2 .rb u{background:#cfd8dc}.rk.r3 .rb u{background:#d98a45}
.rk .rv{font:400 17px/1 Anton,Impact,sans-serif;white-space:nowrap;text-align:right}.rk .rv small{font:700 11px var(--mono);color:var(--muted)}.rk .rv em{font:700 11px var(--mono);color:var(--muted);font-style:normal;margin-left:4px}
.pad{padding:4px 2px}
@media(max-width:560px){.rk{grid-template-columns:28px 26px 1fr auto;}.rk .rb{display:none}.stiles{grid-template-columns:1fr}}

.embers{position:absolute;inset:0;pointer-events:none;z-index:2}
.hero .embers{z-index:0}.hero .in{position:relative;z-index:1}
.vsb .flash{position:absolute;left:50%;top:0;bottom:0;width:70%;transform:translateX(-50%);background:radial-gradient(ellipse at center,rgba(255,255,255,.55),rgba(57,255,20,.18) 35%,transparent 65%);mix-blend-mode:screen;z-index:1;animation:flash 3.4s infinite;pointer-events:none}
.vsb .bolt{animation:bolt 3.4s infinite}
.vsb .half.ga::after{animation:glowg 4s ease-in-out infinite alternate}
.vsb .half.gb::after{animation:glowy 4s ease-in-out infinite alternate-reverse}
.vsb .half::after{box-shadow:inset 0 -80px 120px -40px rgba(57,255,20,.0)}
@keyframes drift{from{transform:scale(1.02) translateX(0)}to{transform:scale(1.12) translateX(3%)}}
@keyframes flash{0%,100%{opacity:.18}6%{opacity:.95}9%{opacity:.25}12%{opacity:.8}18%{opacity:.2}55%{opacity:.3}58%{opacity:.7}62%{opacity:.2}}
@keyframes bolt{0%,100%{opacity:.78}6%{opacity:1}9%{opacity:.5}12%{opacity:1}18%{opacity:.7}58%{opacity:1}62%{opacity:.6}}
@keyframes glowg{from{box-shadow:inset 0 -90px 120px -50px rgba(57,255,20,.05)}to{box-shadow:inset 0 -90px 120px -40px rgba(57,255,20,.35)}}
@keyframes glowy{from{box-shadow:inset 0 -90px 120px -50px rgba(255,200,60,.05)}to{box-shadow:inset 0 -90px 120px -40px rgba(255,200,60,.35)}}
.vsb .cd.hot{animation:hot 1s ease-in-out infinite alternate}
@keyframes hot{from{text-shadow:0 3px 16px #000,0 0 8px rgba(255,80,80,.0)}to{text-shadow:0 3px 16px #000,0 0 22px rgba(255,80,80,.95);color:#ffe3e3}}
.chip.live{animation:livedot 1.4s ease-in-out infinite}
@keyframes livedot{50%{box-shadow:0 0 14px rgba(255,59,59,.9)}}
.tug i,.tug b{position:relative;overflow:hidden}
.tug i::after,.tug b::after{content:"";position:absolute;top:0;bottom:0;width:40%;left:-50%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);animation:sweep 3.2s ease-in-out infinite}
@keyframes sweep{to{left:120%}}
.rk{animation:rise .5s both}.rk:nth-child(2){animation-delay:.05s}.rk:nth-child(3){animation-delay:.1s}.rk:nth-child(4){animation-delay:.15s}.rk:nth-child(5){animation-delay:.2s}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.rk .rb u{animation:grow .9s cubic-bezier(.2,.8,.2,1) both}@keyframes grow{from{width:0 !important}}
.stiles>div{animation:rise .5s both}.stiles>div:nth-child(2){animation-delay:.08s}.stiles>div:nth-child(3){animation-delay:.16s}
.padcard{animation:rise .5s both}.padcard:nth-child(2){animation-delay:.06s}.padcard:nth-child(3){animation-delay:.12s}.padcard:nth-child(4){animation-delay:.18s}.padcard:nth-child(5){animation-delay:.24s}.padcard:nth-child(6){animation-delay:.3s}
.padcard .art{transition:transform .5s}.padcard:hover .art{transform:scale(1.08)}.padcard .art{overflow:hidden}
.padcard::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(115deg,transparent 40%,rgba(255,255,255,.1) 50%,transparent 60%);transform:translateX(-120%);transition:transform .8s}
.padcard{position:relative}.padcard:hover::after{transform:translateX(120%)}
.hero .stats span{animation:rise .6s both}.hero .stats span:nth-child(2){animation-delay:.1s}.hero .stats span:nth-child(3){animation-delay:.2s}
.vsb{animation:frame 5s ease-in-out infinite alternate}
@keyframes frame{from{box-shadow:0 0 22px rgba(57,255,20,.12)}to{box-shadow:0 0 46px rgba(57,255,20,.34),0 0 30px rgba(255,200,60,.18)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none !important;transition:none !important}}

/* ===== v3 look: key-art hero, glowing tiles, art cards ===== */
.homefeed{overflow:hidden;white-space:nowrap;background:#070d08;border-bottom:1px solid var(--line);font:500 13px/1 var(--mono);color:var(--muted)}
.homefeed:empty{display:none}
.ftrack{display:inline-flex;gap:34px;padding:11px 0;animation:marq 38s linear infinite;width:max-content}
.ftrack span{display:inline-flex;align-items:center;gap:8px}.ftrack i{width:8px;height:8px;border-radius:50%}
.ftrack .b i{background:var(--neon)}.ftrack .s i{background:#ff6b6b}.ftrack .b{color:#cfe9c8}
@keyframes marq{to{transform:translateX(-50%)}}
.hero{background:linear-gradient(180deg,rgba(5,8,6,.5) 0%,rgba(5,8,6,.2) 45%,#050806 100%),url(/pad/assets/hero.webp) center bottom/cover no-repeat;padding-bottom:36px}
.hero .in{min-height:0;display:block;text-align:center}
.hero .in:first-of-type{padding-top:clamp(36px,5vw,70px);padding-bottom:clamp(70px,11vw,150px)}
.hero .btn:not(.solid){background:rgba(5,8,6,.78);color:var(--neon)}
.hero h1{text-shadow:0 4px 30px #000}.hero .lead{margin-inline:auto;text-shadow:0 2px 14px #000;max-width:720px}
.hero .cta,.hero .stats{justify-content:center}
.topbattle:empty{display:none}
.tbs{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:14px;background:rgba(7,13,9,.86);border:2px solid rgba(57,255,20,.5);box-shadow:var(--glow);border-radius:18px;padding:14px 18px;margin:-70px auto 0;max-width:820px;color:inherit;text-decoration:none;position:relative;z-index:2;backdrop-filter:blur(6px)}
.tbs .chip{grid-column:1 / -1;justify-self:center;margin:-26px 0 0}
.tbs-mid{display:grid;gap:6px;min-width:0}.tbs-n{display:flex;justify-content:space-between;gap:10px;font:400 20px/1 Anton,Impact,sans-serif}.tbs-n b{font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbs-time{font:700 12px/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:right;max-width:110px}
@media(max-width:640px){.tbs{grid-template-columns:auto 1fr auto;gap:10px}.tbs-time{grid-column:1 / -1;text-align:center;max-width:none}.tbs-mid{grid-column:2}.tbs .pfp.gb{grid-column:3}}
.band.tight{padding-bottom:10px}
.mtug{display:flex;height:12px;border-radius:8px;overflow:hidden;background:var(--panel);gap:2px}
.mtug i{background:var(--neon)}.mtug b{background:var(--gold)}
.mtugn{display:flex;justify-content:space-between;font:700 12px/1 var(--mono);color:var(--muted);margin-top:6px}
.chip.live{background:#ff3b3b;color:#fff}
/* battle cards: wide, two avatars and a tug bar */
.padbox.bcard{display:grid;grid-template-columns:auto 1fr;gap:14px 18px;align-items:center;padding:16px 20px}
.padbox.bcard .cta{grid-column:1 / -1;flex-direction:row;justify-content:flex-end}
#battlelist .padbox.bcard{grid-template-columns:auto 1fr auto}
#battlelist .padbox.bcard .cta{grid-column:auto;flex-direction:column;justify-content:flex-start}
.mtugn span{white-space:nowrap}
.bcard h3{font-size:26px;margin:6px 0;text-align:left}
.padbox.bt.bcard p{text-align:left}.padbox.bt.bcard .row{justify-content:flex-start;gap:12px}.padbox.bt.bcard h3{text-align:left}
.bcard .crown{font:700 12px/1 var(--mono);letter-spacing:.08em;color:var(--gold);border:1px solid var(--gold);border-radius:8px;padding:3px 7px;margin-left:8px;vertical-align:middle;text-transform:uppercase}
.bav{display:flex;align-items:center;gap:8px;text-decoration:none}
.bav .pfp{width:64px}.vsbolt{font:400 22px/1 Anton,Impact,sans-serif;color:#fff;text-shadow:0 0 14px var(--neon)}
.bcard .cta{margin:0;align-items:stretch}
.bcard.s3{opacity:.92;border-color:rgba(255,200,60,.4)}
.bcard.s2{border-color:rgba(255,59,59,.55);box-shadow:0 0 0 1px rgba(255,59,59,.3),0 0 26px rgba(255,59,59,.12)}
@media(max-width:760px){.padbox.bcard,#battlelist .padbox.bcard{grid-template-columns:1fr}.padbox.bcard .cta,#battlelist .padbox.bcard .cta{flex-direction:row;justify-content:stretch}.bav{justify-content:center}}
.pills{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 18px}
.pills button{background:var(--panel);color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:10px 20px;font:400 18px/1 Anton,Impact,sans-serif;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;min-height:44px}
.pills button.on{background:var(--neon);color:#031005;border-color:var(--neon);box-shadow:0 0 18px rgba(57,255,20,.4)}
.vsb.feat{display:block;text-decoration:none;color:inherit;min-height:clamp(200px,28vw,330px);margin-bottom:6px}
.vsb.feat h2{font-size:clamp(20px,3vw,40px)}
.vsb.feat .mid{top:auto;bottom:14px}
/* token page */
.tbanner{border-radius:22px;border:2px solid rgba(57,255,20,.5);box-shadow:var(--glow);background:linear-gradient(90deg,rgba(5,8,6,.9),rgba(5,8,6,.55)),url(/pad/assets/hero.webp) center/cover;margin:0 0 18px}
.tb-in{display:flex;gap:22px;align-items:center;padding:22px}
.mascot{width:clamp(84px,14vw,170px);flex:none}.mascot .art{background-size:cover;background-position:center;background-repeat:no-repeat;aspect-ratio:1;border-radius:18px;border:3px solid var(--neon);box-shadow:0 0 26px rgba(57,255,20,.45);overflow:hidden}
.tb-name h1{font:400 clamp(34px,6vw,76px)/1 Anton,Impact,sans-serif;margin:0}
.tb-name h1 small{font-size:.4em;color:var(--muted)}
.row2{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center}
.rcol{display:grid;gap:22px;align-content:start}.rcol .padbox{margin:0}
.chestrow{display:flex;gap:16px;align-items:center}.chestrow img{border-radius:12px;filter:drop-shadow(0 0 16px rgba(57,255,20,.4))}
.chestrow .big{font:400 30px/1.1 Anton,Impact,sans-serif;color:var(--gold-hi)}
.feeds{margin-top:22px}
.trades{display:grid;gap:4px}
.tr{display:grid;grid-template-columns:70px 52px 1fr auto;gap:10px;padding:8px 10px;border-radius:8px;font:500 14px/1.2 var(--mono)}
.tr.b{background:rgba(57,255,20,.1)}.tr.b b{color:var(--neon)}.tr.s{background:rgba(255,80,80,.12)}.tr.s b{color:#ff8a8a}
.tr a{color:var(--muted)}
@media(max-width:560px){.tb-in{flex-direction:column;text-align:center}.tr{grid-template-columns:56px 44px 1fr}.tr a{display:none}.chestrow{flex-direction:column;text-align:center}}
/* launch page */
.steps3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:0 0 22px}
.steps3>div{display:flex;align-items:center;gap:14px;border:2px solid rgba(57,255,20,.4);border-radius:14px;padding:14px 18px;background:rgba(7,14,9,.85)}
.steps3 b{font:400 34px/1 Anton,Impact,sans-serif;color:var(--neon)}.steps3 span{font:400 22px/1 Anton,Impact,sans-serif;letter-spacing:.03em;text-transform:uppercase}
@media(max-width:640px){.steps3{grid-template-columns:1fr}}
.lgrid{display:grid;grid-template-columns:1.6fr 1fr;gap:22px;align-items:start}
@media(max-width:900px){.lgrid{grid-template-columns:1fr}}
#launchprev{position:sticky;top:90px}.padcard.nopad{animation:none;pointer-events:none}
#launchform .tab{min-height:230px;font:400 34px/1 Anton,Impact,sans-serif;letter-spacing:.04em}
#launchform .tab:nth-child(1){background-image:url(/pad/assets/war.webp)}
#launchform .tab:nth-child(2){background-image:url(/pad/assets/peace.webp)}
#launchform .tab input{accent-color:var(--neon)}
/* how page */
.howban{height:clamp(150px,24vw,280px);border-radius:22px;border:2px solid rgba(57,255,20,.45);box-shadow:var(--glow);background:linear-gradient(180deg,transparent 40%,#050806),url(/pad/assets/hero.webp) center/cover;margin:0 0 22px}
.step{display:grid;grid-template-columns:140px 1fr;gap:22px;align-items:center;margin:0 0 20px;padding:20px 24px;border:2px solid rgba(57,255,20,.4);border-radius:18px;background:rgba(7,14,9,.88);box-shadow:var(--glow)}
.step:nth-of-type(even){border-color:rgba(255,200,60,.5);box-shadow:0 0 0 1px rgba(255,200,60,.3),0 0 26px rgba(255,200,60,.1)}
.step img{width:140px;height:140px;object-fit:cover;border-radius:18px}
.step h2{margin:0 0 8px !important;font-size:clamp(28px,3.4vw,44px)}
.step.risk{grid-template-columns:1fr;border-color:#ff9f43;box-shadow:0 0 0 1px rgba(255,159,67,.3),0 0 26px rgba(255,159,67,.12)}
@media(max-width:640px){.step{grid-template-columns:1fr;text-align:left}.step img{width:96px;height:96px}}

.vbadge{display:inline-block;margin-left:8px;border-radius:8px;padding:5px 9px;font:700 11px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;background:rgba(57,255,20,.14);color:var(--neon);border:1px solid rgba(57,255,20,.6);vertical-align:middle;white-space:nowrap}
.vbadge.warn{background:rgba(255,80,80,.14);color:#ff8a8a;border-color:rgba(255,80,80,.7)}
.vmark{color:var(--neon);font-size:.7em;margin-left:4px;vertical-align:middle}.vmark.warn{color:#ff8a8a}
.vpanel{border-radius:14px;padding:14px 18px;margin:0 0 18px;font-size:16px;line-height:1.5}
.vpanel.ok{border:1px solid rgba(57,255,20,.55);background:rgba(57,255,20,.07)}
.vpanel.bad{border:2px solid #ff6b6b;background:rgba(255,80,80,.1);color:#ffe0e0}
.vpanel a{color:inherit}
.vcard h3{margin:0}

.vsb .bolt{display:none}
/* ===== v4 look: Staggy Paddy, the late-night forest diner (our realistic hooded stag as head chef) ===== */
.brand{font:400 34px/1 Anton,Impact,sans-serif;letter-spacing:.04em;color:var(--neon);text-shadow:0 0 6px rgba(57,255,20,.9),0 0 22px rgba(57,255,20,.55);text-decoration:none;margin-right:12px;white-space:nowrap}
.brand span{font:inherit;color:#ffd75e;text-shadow:0 0 6px rgba(255,200,60,.9),0 0 22px rgba(255,200,60,.5)}
.openSign{position:absolute;top:22px;right:clamp(14px,4vw,64px);font:400 28px/1 Anton,Impact,sans-serif;letter-spacing:.14em;color:#ff6b6b;border:3px solid #ff5a5a;border-radius:10px;padding:6px 16px;text-shadow:0 0 8px #ff5a5a,0 0 24px #ff2a2a;box-shadow:0 0 12px #ff2a2a,inset 0 0 10px rgba(255,42,42,.5);animation:openflick 4.2s infinite;z-index:3;background:rgba(40,0,0,.45)}
@keyframes openflick{0%,90%,100%{opacity:1}92%{opacity:.35}94%{opacity:1}96%{opacity:.5}97%{opacity:1}}
.hero{position:relative;min-height:clamp(520px,60vw,760px);background:linear-gradient(90deg,rgba(5,8,6,.72) 0%,rgba(5,8,6,.35) 40%,rgba(5,8,6,0) 70%),linear-gradient(180deg,rgba(5,8,6,.2),#050806 98%),url(/pad/assets/hero.webp) right center/cover no-repeat}
.hero .in:first-of-type{text-align:left;padding-top:clamp(70px,9vw,120px);padding-bottom:clamp(110px,14vw,200px)}
.hero .in:first-of-type>div{max-width:min(540px,92%)}
.hero .lead{margin-inline:0}.hero .cta,.hero .stats{justify-content:flex-start}
.hero h1{font-size:clamp(44px,6.2vw,88px)}
.hero .stats span{background:#e9dfc5;color:#2a2418;border:0;border-bottom:3px dashed #2a2418;border-radius:3px 3px 0 0;box-shadow:0 10px 26px rgba(0,0,0,.55);padding:14px 20px 16px;font:600 12px/1.2 var(--mono);letter-spacing:.1em;text-transform:uppercase;backdrop-filter:none}
.hero .stats b{color:#17120a;font-size:30px}
@media(max-width:720px){.hero{background:linear-gradient(180deg,rgba(5,8,6,.55) 0%,rgba(5,8,6,.4) 45%,#050806 95%),url(/pad/assets/hero.webp) 78% center/cover no-repeat}.openSign{font-size:20px;top:12px;padding:4px 10px}.hero .in:first-of-type{padding-top:80px}}
/* order-ticket cards */
.padcard{--c:var(--neon)}.padcard.peace{--c:var(--gold)}
.padcard .b{position:relative;border-top:2px dashed color-mix(in srgb,var(--c) 55%,transparent)}
.padcard .b::before,.padcard .b::after{content:"";position:absolute;top:-12px;width:22px;height:22px;border-radius:50%;background:#050806;border:2px solid var(--c)}
.padcard .b::before{left:-13px}.padcard .b::after{right:-13px}
.padcard .row .muted{font:700 12px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase}
.padbox.bcard .row b{font:700 12px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}

/* neon sign: PAD stays lit, the DY tubes flicker like a failing tube */
.brand .fk{font:inherit;font-style:normal;animation:dyflick 5.6s infinite;display:inline-block}
@keyframes dyflick{0%,18%,22%,26%,52%,60%,100%{opacity:1;color:#ffd75e;text-shadow:0 0 6px rgba(255,200,60,.9),0 0 22px rgba(255,200,60,.5)}
 19%,23%,53%,56%{opacity:1;color:#5b4a1d;text-shadow:none}
 20%,24%,54%{opacity:.85;color:#ffd75e;text-shadow:0 0 4px rgba(255,200,60,.7)}
 27%,50%{opacity:1;color:#5b4a1d;text-shadow:none}
 57%,59%{opacity:1;color:#5b4a1d;text-shadow:none}}
@media(prefers-reduced-motion:reduce){.brand .fk{animation:none}}
table.fees{width:100%;border-collapse:collapse;margin:12px 0}table.fees th,table.fees td{border:1px solid var(--line);padding:10px 12px;text-align:left;font-size:15px;color:#c4d6c0}table.fees th{color:var(--fg)}
/* ===== v5 polish: compact pad nav, phone hero, banner crops, tap targets ===== */
.padnav{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;padding-top:16px;padding-bottom:6px}
.padnav .brand{font-size:30px;margin-right:6px}
.padlinks{display:flex;gap:6px;align-items:center;flex:1;min-width:0}
.padlinks .btn,.padnav [data-wallet]{padding:0 16px;min-height:44px;font-size:13px;letter-spacing:.08em;white-space:nowrap}
.padlinks .btn{border:1px solid var(--line);color:#cfe9c8;background:rgba(10,17,12,.7)}
.padlinks .btn:hover,.padlinks .btn:focus-visible{border-color:var(--neon);color:var(--neon);transform:none;box-shadow:0 0 16px rgba(57,255,20,.3)}
body[data-page="home"] .padlinks [data-n="home"],body[data-page="token"] .padlinks [data-n="home"],body[data-page="launch"] .padlinks [data-n="launch"],body[data-page="battles"] .padlinks [data-n="battles"],body[data-page="battle"] .padlinks [data-n="battles"],body[data-page="verified"] .padlinks [data-n="verified"],body[data-page="how"] .padlinks [data-n="how"]{border-color:var(--neon);color:var(--neon);background:rgba(57,255,20,.1);box-shadow:inset 0 -2px 0 var(--neon)}
.padnav [data-wallet]{margin-left:auto;border-width:1px}
main>.padnav+.band{padding-top:clamp(18px,3vw,30px)}
.padnote a{display:inline-block;padding:11px 0;margin:-11px 0}
.padcard .kv b,.padbox .kv b{text-align:right;white-space:nowrap}
.padbox .kv small{font-size:11px}
#tradeBtn,#launchgo{justify-content:center}
.lbl{line-height:1.4}
#launchform .tabs{margin-top:8px}
.tr span:first-child{white-space:nowrap}
.btop>a{display:inline-flex;align-items:center;min-height:44px}
.vsb .cdl{text-shadow:0 1px 2px #000,0 0 10px #000,0 0 18px #000}
.howban{background:linear-gradient(180deg,transparent 45%,#050806),url(/pad/assets/hero.webp) center 5%/cover}
.tb-name h1{font-size:clamp(34px,5vw,60px)}
@media(min-width:561px){.tbanner{background:linear-gradient(90deg,#070d09 0%,#070d09 42%,rgba(7,13,9,.5) 70%,rgba(7,13,9,.08) 100%),url(/pad/assets/hero.webp) right top 18%/auto 165% no-repeat,#070d09}}
@media(max-width:720px){
.padnav{gap:10px;padding-top:12px}
.padnav .brand{font-size:26px;margin-right:0}
.padnav [data-wallet]{order:2}
.padlinks{order:3;flex:1 0 100%;overflow-x:auto;scrollbar-width:none;margin-inline:-16px;padding:6px 16px;-webkit-mask-image:linear-gradient(90deg,#000 86%,transparent);mask-image:linear-gradient(90deg,#000 86%,transparent)}
.padlinks::-webkit-scrollbar{display:none}
.padlinks .btn{flex:none;padding:0 13px}
.hero{min-height:0;padding-bottom:28px;background:linear-gradient(180deg,rgba(5,8,6,0) 0,rgba(5,8,6,0) 150px,rgba(5,8,6,.84) 262px,#050806 340px),url(/pad/assets/hero.webp) left calc(50vw - 705px) top/auto 380px no-repeat,#050806}
.hero .in{padding:0 16px}
.hero .in:first-of-type{padding-top:230px;padding-bottom:22px}
.tbs{margin-top:22px}
.hero .in:first-of-type>div{max-width:none}
.hero h1{font-size:clamp(40px,12.5vw,56px)}
.hero .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.hero .stats span{padding:10px 10px 12px;font-size:10px;letter-spacing:.06em}
.hero .stats b{font-size:22px}
.howban{height:200px;background:linear-gradient(180deg,transparent 45%,#050806),url(/pad/assets/hero.webp) 90% 10%/auto 150% no-repeat}
}
@media(max-width:640px){
.vsb.feat{min-height:230px}
.vsb.feat .hn{padding:10px 12px 60px;gap:8px}
.vsb.feat .pfp{width:36px;border-width:2px}
.vsb.feat h2{font-size:18px}
.vsb.feat .mid{width:92%;bottom:10px}
.vsb.feat .cd.small{font-size:20px}
.vsb:not(.feat) .mid{width:74%}
.vsb .cdl{font-size:10px;letter-spacing:.1em}
table.fees,table.fees tbody,table.fees tr,table.fees td{display:block}
table.fees tr:first-child{display:none}
table.fees tr{border:1px solid var(--line);border-radius:12px;padding:8px 0;margin:0 0 8px}
table.fees td{border:0;padding:3px 12px}
table.fees td:first-child{color:var(--fg);font-weight:600}
table.fees td:nth-child(2)::before{content:"Tax: ";color:var(--muted)}
table.fees td:nth-child(3)::before{content:"Goes to: ";color:var(--muted)}
.how .step ul{margin-left:0;padding-left:20px}
}
@media(max-width:560px){
.padbox .cta .btn{flex:1 1 100%;justify-content:center;text-align:center}
.tr{grid-template-columns:68px 44px 1fr}
.pills{gap:6px}.pills button{padding:10px 13px;font-size:16px}
.stiles{grid-template-columns:repeat(3,1fr);gap:6px}
.stiles>div{padding:8px;display:flex;flex-direction:column;justify-content:space-between}
.stiles span{font-size:9px;letter-spacing:.04em;line-height:1.2}
.stiles b{font-size:15px}
}
"""

def page(title, desc, body, path, pg):
    return f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{html.escape(title)}</title><meta name="description" content="{html.escape(desc)}"><meta property="og:title" content="{html.escape(title)}"><meta property="og:description" content="{html.escape(desc)}"><meta property="og:image" content="https://stagwifhood.fun/pad/assets/og.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://stagwifhood.fun/pad/assets/og.jpg"><meta name="theme-color" content="#050806"><meta name="robots" content="noindex,nofollow"><link rel="icon" href="/assets/badge.webp">
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

SUBNAV = '<div class="in padnav"><a class="brand" href="/pad/">STAGGY <span>PAD<i class="fk">DY</i></span></a><nav class="padlinks" aria-label="Staggy Paddy"><a class="btn" data-n="home" href="/pad/">Menu</a><a class="btn" data-n="launch" href="/pad/launch/">Launch</a><a class="btn" data-n="battles" href="/pad/battles/">Paddy wars</a><a class="btn" data-n="verified" href="/pad/verified/">Verified</a><a class="btn" data-n="how" href="/pad/how/">How it works</a></nav><button class="btn solid" data-wallet>Connect wallet</button></div>'

home = f"""<main><div id="feed" class="homefeed" aria-hidden="true"></div>{SUBNAV}
<div class="in" style="padding-top:18px"><div id="notlive"></div></div>
<section class="hero"><div class="in"><div>
<span class="openSign" aria-hidden="true">OPEN</span><span class="eyebrow">Staggy Paddy · Robinhood Chain</span>
<h1>Order up. <em>Launch</em> a token.</h1>
<p class="lead">Every token launches paired with $STAG, with its liquidity locked from the first second. Creators earn from trading. Tokens can fight: more trading volume wins the other side's war chest, and the winner burns it.</p>
<div class="cta"><a class="btn solid" href="/pad/launch/">Launch a token</a><a class="btn" href="/pad/how/">How it works</a></div>
<div class="stats" id="padstats"><span><b>3%</b> tax on the $STAG side</span><span><b>Locked</b> liquidity</span><span><b>Robinhood</b> Chain</span></div>
</div></div><div class="in"><div id="topbattle" class="topbattle"></div></div></section>
<section class="band tight"><div class="in"><span class="eyebrow">Paddy wars</span><h2 class="sec-h">Live battles</h2><div class="grid two" id="homebattles"><p class="muted">Loading…</p></div></div></section>
<section class="band"><div class="in"><span class="eyebrow">Launches</span><h2 class="sec-h">Latest tokens</h2><div class="pills" id="vfilter" role="group" aria-label="Filter tokens"><button class="on" data-v="0">All</button><button data-v="1">✔ Verified</button></div><p class="muted" id="vnone" hidden>No verified tokens yet.</p><div class="grid" id="padlist"><p class="muted">Loading…</p></div></div></section>
<section class="band alt"><div class="in"><span class="eyebrow">Read this first</span><h2 class="sec-h">Plain risks</h2>
<ul class="plain"><li>Tokens launched here are created by anyone and can lose most or all of their value. Many will.</li><li>The pad takes a 3% tax on the $STAG side of every trade. Creators also earn the pool's 0.30% fee.</li><li>Battles are decided by trading volume, and volume counts even if it is wash trading. A well-funded token can outspend a small one.</li><li>The contracts have been tested on a copy of the real chain and reviewed repeatedly, but they have not had a professional third-party audit. Bugs can exist.</li><li>Nothing here is financial advice or a promise of returns. Only use money you can afford to lose.</li></ul></div></section>
</main>"""

launch = f"""<main>{SUBNAV}
<section class="band"><div class="in"><div id="notlive"></div><span class="eyebrow">Create</span><h1 class="sec-h">Launch a token</h1>
<p class="sec-p">One transaction makes the token and opens its pool with $STAG. The full supply goes into the pool as locked liquidity. There is no launch fee and no minimum buy.</p>
<div class="steps3"><div><b>1</b><span>Name it</span></div><div><b>2</b><span>Pick your side</span></div><div><b>3</b><span>Launch</span></div></div>
<div class="lgrid"><form id="launchform" class="padbox"><label class="lbl" for="tname">Token name</label><input id="tname" name="tname" class="inp" maxlength="32" required placeholder="Stag Coin">
<label class="lbl" for="tsym">Symbol</label><input id="tsym" name="tsym" class="inp" maxlength="12" required placeholder="STAGC">
<label class="lbl" for="fdv">Starting value in $STAG (minimum 1,000,000)</label><input id="fdv" name="fdv" class="inp" inputmode="decimal" required value="1000000">
<label class="lbl">Mode</label><div class="tabs"><label class="tab on"><input type="radio" name="mode" value="war" checked style="margin-right:8px"><span>War</span></label><label class="tab"><input type="radio" name="mode" value="peace" style="margin-right:8px"><span>Peace</span></label></div>
<div class="quote" id="modeinfo"></div>
<div class="warnbox"><b>Before you launch:</b> launching is final, you receive no free tokens, and you cannot pull the liquidity. Launching a token to deceive people is not allowed by us and may be illegal where you live.</div>
<div class="cta"><button class="btn solid" id="launchgo" type="submit" disabled>Launch token</button></div></form><aside id="launchprev" class="padbox"></aside></div></div></section>
</main>"""

token = f"""<main>{SUBNAV}
<section class="band"><div class="in"><div id="notlive"></div><div id="tokroot"><p class="muted">Loading…</p></div></div></section>
</main>"""

battles = f"""<main>{SUBNAV}
<section class="band"><div class="in"><div id="notlive"></div><span class="eyebrow">Paddy wars</span><h1 class="sec-h">Token vs token</h1>
<p class="sec-p">A creator in war mode offers a battle and sets the length. The other creator accepts or the offer lapses after 3 days. Both pools are locked while it runs. More trading volume wins. Only what each token earned during the fight is at stake, and the winner's chest is marked to be burned.</p>
<div id="featured"></div>
<div class="pills" id="bfilter" role="group" aria-label="Filter battles"><button class="on" data-f="all">All</button><button data-f="2">Live</button><button data-f="1">Offered</button><button data-f="3">Settled</button></div>
<div id="battlelist"><p class="muted">Loading…</p></div>
<h2 class="sec-h" style="margin-top:40px">Offer a battle</h2><div id="battlemine" class="padbox"></div></div></section>
</main>"""

battle = f"""<main>{SUBNAV}
<section class="band"><div class="in"><div id="notlive"></div><div id="battleroot"><p class="muted">Loading…</p></div></div></section>
</main>"""

verified = f"""<main>{SUBNAV}
<section class="band"><div class="in"><div id="notlive"></div><span class="eyebrow">Official tokens</span><h1 class="sec-h">Verified projects</h1>
<p class="sec-p">Anyone can launch any name on the pad, including one that copies another project. This list shows the official pad token of projects we have checked. Always compare the contract address.</p>
<div id="verlist" class="grid two"><p class="muted">Loading…</p></div>
<div class="padbox" style="margin-top:28px"><h3>How a project gets verified</h3>
<ul class="plain"><li>Launch your token on the pad and post its contract address from your project's official account.</li><li>Send us the post's link and the contract address in <a href="https://t.me/StagWifHood" rel="noopener">Telegram</a>.</li><li>We check that the account is the project's official one and that the token is the one that was posted, then add it here. If the project already has a token elsewhere, the original token address is shown next to it.</li></ul>
<p class="fine">Verified means we confirmed the official account posted that address. It is not an audit, not an endorsement and not a promise about price. A verified token can still lose most or all of its value. We can remove an entry if we find it was wrong.</p></div>
</div></section>
</main>"""

how = f"""<main>{SUBNAV}
<section class="band how"><div class="in"><div class="howban" role="img" aria-label="The hooded stag chef holding a plate in the night forest"></div><span class="eyebrow">How it works</span><h1 class="sec-h">The rules, in plain words</h1>
<div id="notlive"></div>
<div class="step"><img src="/pad/assets/s1.webp" alt="" width="140" height="140" loading="lazy"><div><h2>Launching</h2><p>A creator picks a name, a symbol and a starting value in $STAG (at least 1,000,000). One transaction creates the token (fixed supply of 1 billion, no minting) and puts all of it into a Uniswap pool paired with $STAG. That liquidity is locked by the contract: nobody can remove it, including the creator and us. The creator receives no free tokens. The creator earns the pool's 0.30% trading fee and can collect it at any time.</p>
</div></div><div class="step"><img src="/pad/assets/s3.webp" alt="" width="140" height="140" loading="lazy"><div><h2>The 3% tax</h2><table class="fees"><tr><th>Trade</th><th>Tax</th><th>Where it goes</th></tr>
<tr><td>Sell (token to $STAG)</td><td>3% of the $STAG you receive</td><td>The platform</td></tr>
<tr><td>Buy, war mode</td><td>3% of the $STAG you pay</td><td>The token's war chest</td></tr>
<tr><td>Buy, peace mode</td><td>3% of the $STAG you pay</td><td>1% to the creator, 2% to all holders in proportion to what they hold</td></tr></table>
<p>Prices you see in the trade box already include the tax. The pool's 0.30% fee is paid to the creator on top.</p>
</div></div><div class="step"><img src="/pad/assets/s2.webp" alt="" width="140" height="140" loading="lazy"><div><h2>War and peace</h2><p>The creator picks the mode and can switch while no battle holds the pool. Switching only changes later buys: the existing chest stays where it is. Every token page shows its current mode, and you should check it before you buy, because the creator can change it.</p>
</div></div><div class="step"><img src="/pad/assets/s5.webp" alt="" width="140" height="140" loading="lazy"><div><h2>The war chest and burns</h2><p>In war mode the buy tax builds a chest of $STAG. The creator can spend the chest buying their own token from the pool and burning what comes back. A burn moves the price by at most about 1.5%, only one burn is allowed per hour, and anything the pool cannot fill within that limit stays in the chest.</p>
</div></div><div class="step"><img src="/pad/assets/s4.webp" alt="" width="140" height="140" loading="lazy"><div><h2>Battles</h2><ul><li>For now only tokens launched through the pad can battle. A project that already has a token elsewhere cannot plug that token in yet.</li><li>A creator in war mode offers a battle to another token and sets how long it runs (1 hour to 14 days). The offer locks their pool (no mode change, no burning) and lapses after 3 days if not accepted.</li><li>The other creator accepts on chain. Both pools stay locked until the end.</li><li>The token with more <b>gross trading volume</b> during the fight wins. Volume counts even when it is wash trading, so a larger wallet can outspend a smaller one. That is part of the game and you should know it before you enter.</li><li>Only what each pool earned into its chest <b>during the fight</b> is at stake. The loser's fight earnings go to the winner's chest, and the winner's fight earnings plus that prize are marked to be burned. Older chest money stays with its pool.</li><li>A tie moves nothing. Nobody, including us, can pick or change a result.</li><li>If the winner's creator does not burn, anyone can burn the marked chest in steps, one per hour, with the creator getting the first chance each hour.</li></ul>
</div></div><div class="step risk"><div><h2>What can go wrong</h2><ul><li>Anyone can launch any name or symbol, including one that copies another project. Look at the creator address and the contract address before you buy.</li><li>Tokens can lose most or all of their value. Thin pools can be pushed around by large trades.</li><li>The creator can switch war and peace at any time while no battle holds the pool.</li><li>The contracts are new. They were tested on a copy of the real chain and reviewed repeatedly by independent reviewers, but they have <b>not</b> had a professional third-party audit.</li><li>Some wallets and tools show prices without the 3% tax. Use the trade box here for the real number.</li><li>Gas fees and the $STAG curve's own fees apply when you trade through ETH.</li></ul>
</div></div><p class="fine">Nothing here is financial advice or a promise of returns. $STAG and tokens launched on the pad are volatile. You can lose everything you put in.</p></div></section>
</main>"""

def write(rel, content):
    p = D / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    print("wrote", rel)

write("pad/index.html", page("Staggy Paddy | Launch a token, win the chest", "Launch tokens paired with $STAG on Robinhood Chain. Locked liquidity, war chests and token battles.", home, "/pad/", "home"))
write("pad/launch/index.html", page("Launch a token | Staggy Paddy", "Create a token paired with $STAG in one transaction.", launch, "/pad/launch/", "launch"))
write("pad/token/index.html", page("Token | Staggy Paddy", "Trade and manage a token launched on Staggy Paddy.", token, "/pad/token/", "token"))
write("pad/battles/index.html", page("Battles | Staggy Paddy", "Token vs token battles on Staggy Paddy.", battles, "/pad/battles/", "battles"))
write("pad/battle/index.html", page("Battle | Staggy Paddy", "Token vs token battle on Staggy Paddy: volume, war chests, buyers, sellers and holders.", battle, "/pad/battle/", "battle"))
write("pad/verified/index.html", page("Verified projects | Staggy Paddy", "Official pad tokens of verified projects on Staggy Paddy.", verified, "/pad/verified/", "verified"))
write("pad/how/index.html", page("How the pad works | Staggy Paddy", "The rules of Staggy Paddy in plain words: fees, war and peace, battles and risks.", how, "/pad/how/", "how"))

# make sure the existing pages do not link to the pad yet (idempotent)
for rel in ("index.html", "stagr/index.html"):
    f = D / rel
    s = f.read_text()
    if 'href="/pad/"' in s:
        f.write_text(s.replace('<a href="/pad/">Pad</a>', ''))
        print("pad link removed from", rel)
