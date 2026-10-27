import pathlib
D=pathlib.Path(__file__).parent
base=(D/'_base.css').read_text()
extra='''
.sec-h{font-size:clamp(38px,6vw,78px);margin-bottom:18px}.sec-p{color:#c4d6c0;font-size:19px;margin-bottom:40px}
.grid{display:grid;gap:22px;grid-template-columns:repeat(3,1fr)}
.grid.two{grid-template-columns:repeat(2,1fr)}
@media(max-width:900px){.grid,.grid.two{grid-template-columns:1fr}}
.card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:22px;overflow:hidden;display:flex;flex-direction:column;text-decoration:none;transition:transform .2s,border-color .2s,box-shadow .2s}
a.card:hover{transform:translateY(-4px);border-color:var(--neon);box-shadow:0 0 40px rgba(57,255,20,.25)}
.card img{width:100%;aspect-ratio:4/3;object-fit:cover}
.card .b{padding:22px 24px 26px;display:flex;flex-direction:column;gap:10px;flex:1}
.card h3{font-size:30px}.card p{color:#c4d6c0;font-size:16px}
.chip{align-self:flex-start;font:700 11px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;padding:7px 10px;border-radius:999px;border:1px solid var(--neon);color:var(--neon)}
.chip.soon{border-color:var(--gold);color:var(--gold-hi)}
.go{margin-top:auto;font:700 13px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--neon)}
.split{display:grid;grid-template-columns:1fr 1fr;gap:clamp(24px,5vw,64px);align-items:center}
@media(max-width:900px){.split{grid-template-columns:1fr}}
.frame{border-radius:26px;overflow:hidden;border:2px solid rgba(57,255,20,.45);box-shadow:0 0 60px rgba(57,255,20,.2)}
.frame video,.frame img{width:100%;display:block}
.steps{display:grid;gap:14px;counter-reset:s;margin-top:8px;padding:0;list-style:none}
.steps li{counter-increment:s;padding:16px 18px 16px 64px;position:relative;background:var(--panel);border:1px solid var(--line);border-radius:16px}
.steps li::before{content:counter(s);position:absolute;left:16px;top:50%;translate:0 -50%;width:34px;height:34px;border-radius:50%;background:var(--neon);color:#031005;font:400 18px/34px var(--display);text-align:center}
.ca{display:flex;flex-wrap:wrap;gap:12px;align-items:center;background:var(--panel);border:1px dashed var(--gold);border-radius:16px;padding:16px 20px;font:700 14px/1.4 var(--mono);color:var(--gold-hi);word-break:break-all}
.alt{background:var(--panel)}
footer{border-top:1px solid var(--line);padding-block:40px;color:var(--muted);font-size:14px}
footer .in{display:flex;flex-wrap:wrap;gap:12px 30px;align-items:center}
footer a{text-decoration:none}footer a:hover{color:var(--fg)}
.fine{max-width:80ch;margin-top:18px;font-size:13px;line-height:1.5}
@media(prefers-reduced-motion:reduce){.ticker div{animation:none}}
'''
TG='https://t.me/StagWifHood'
def page(title,desc,body,path):
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title}</title><meta name="description" content="{desc}"><meta property="og:title" content="{title}"><meta property="og:description" content="{desc}"><meta property="og:image" content="https://stagwifhood.fun/assets/poster.webp"><meta name="theme-color" content="#050806"><link rel="icon" href="/assets/badge.webp">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow:wght@400;500;600&family=Space+Mono:wght@700&display=swap">
<style>{base}{extra}</style>
<header><div class="in"><a class="brand" href="/"><img src="/assets/badge.webp" alt=""><span>$STAG</span></a><nav><a href="/#ecosystem">Ecosystem</a><a href="/stagr/">StagR</a><a href="https://records.stagwifhood.fun">Records</a><a class="btn solid" href="{TG}" rel="noopener">Join Telegram</a></nav></div></header>
{body}
<footer><div class="in"><span>© $STAG · Stag Wif Hood</span><a href="/stagr/">StagR CRM</a><a href="https://records.stagwifhood.fun">Stag House Records</a><a href="{TG}" rel="noopener">Telegram</a></div><div class="in"><p class="fine">$STAG is a community token. Nothing here is financial advice or a promise of returns. Crypto is volatile and you can lose everything you put in. Some music on Stag House Records is made with AI.</p></div></footer>
</html>'''
home='''<main>
<section class="hero"><div class="in"><div>
<span class="eyebrow">Stag Wif Hood</span>
<h1>The stag <em>runs</em> the hood.</h1>
<p class="lead">$STAG is the community token behind real businesses: a CRM built for junk removal and moving companies, and a record label where artists own their music.</p>
<div class="cta"><a class="btn solid" href="/stagr/">See StagR CRM</a><a class="btn" href="https://records.stagwifhood.fun">Hear the music</a></div>
<div class="stats"><span><b>1</b> CRM in beta</span><span><b>5</b> tracks live</span><span><b>Robinhood</b> Chain</span></div>
</div><div class="boothwrap"><img src="/assets/poster.webp" alt="Stag Wif Hood poster"></div></div></section>
<div class="ticker" aria-hidden="true"><div><span>$STAG</span><span>StagR CRM</span><span>Stag House Records</span><span>Winslow Bankz</span><span>Own your music</span><span>$STAG</span><span>StagR CRM</span><span>Stag House Records</span><span>Winslow Bankz</span><span>Own your music</span></div></div>
<section class="band" id="ecosystem"><div class="in"><span class="eyebrow">The ecosystem</span><h2 class="sec-h">Two doors. One <span class="gold">stag</span>.</h2><p class="sec-p">Everything is built by the same crew and tied back to the community.</p>
<div class="grid two">
<a class="card" href="/stagr/"><img src="/assets/stagr.webp" alt="StagR CRM"><div class="b"><span class="chip">In beta</span><h3>StagR CRM</h3><p>Customers, quotes, jobs, invoices and follow-ups for junk removal and moving companies. Already tested with a real crew.</p><span class="go">Open StagR →</span></div></a>
<a class="card" href="https://records.stagwifhood.fun"><img src="/assets/booth.webp" alt="Stag House Records booth"><div class="b"><span class="chip">Live</span><h3>Stag House Records</h3><p>Winslow Bankz and the label. Stream the tracks now. Music NFTs and videos are next.</p><span class="go">Open Records →</span></div></a>
</div></div></section>
<section class="band alt"><div class="in split"><div><span class="eyebrow">Hood Rich</span><h2 class="sec-h">Winslow Bankz</h2><p class="sec-p">The first artist on Stag House Records. Press play on a track, and watch for the Hood Rich digital album drop.</p><a class="btn solid" href="https://records.stagwifhood.fun">Listen now</a></div><div class="frame"><img src="/assets/hood-rich.webp" alt="Hood Rich digital album cover by Winslow Bankz" onerror="this.src='/assets/booth.webp'"></div></div></section>
<section class="band"><div class="in"><span class="eyebrow">Where it's going</span><h2 class="sec-h">The plan</h2><ol class="steps"><li>Ship StagR to real service businesses and keep improving it.</li><li>Release music on Stag House Records with the artist's say on every deal.</li><li>Use profits for music videos, with a stag clip ahead of each one.</li><li>Open NFT drops for fans, once the legal and platform details are settled.</li></ol></div></section>
<section class="band alt"><div class="in"><span class="eyebrow">Contract</span><h2 class="sec-h">Verify before you buy</h2><div class="ca"><span>Contract address: announced in Telegram at launch. Never trust an address from a DM.</span><a class="btn" href="'''+TG+'''" rel="noopener">Get it in Telegram</a></div></div></section>
</main>'''
stagr='''<main>
<section class="hero"><div class="in"><div><span class="eyebrow">StagR CRM · Beta</span><h1>Run the <em>crew</em> from your phone.</h1>
<p class="lead">The first CRM created by a crypto project. Built for junk removal and moving companies, powered by $STAG.</p>
<div class="cta"><a class="btn solid" href="'''+TG+'''" rel="noopener">Join the community</a><a class="btn" href="/">Back to $STAG</a></div></div>
<div class="frame"><video src="/assets/stagr-promo.mp4" controls playsinline preload="metadata" poster="/assets/stagr.webp"></video></div></div></section>
<section class="band"><div class="in"><span class="eyebrow">What it does</span><h2 class="sec-h">Lead to paid.</h2><ol class="steps"><li>Capture customers and requests in one place.</li><li>Send estimates, schedule jobs and assign crews.</li><li>Invoice and track payments.</li><li>Follow up by text and ask for Google reviews.</li></ol></div></section>
<section class="band alt"><div class="in"><span class="eyebrow">Status</span><h2 class="sec-h">Honest status</h2><p class="sec-p">StagR is working and in beta with a real junk removal company. The Android app is in Google Play review. Nothing here promises token returns.</p></div></section>
</main>'''
(D/'index.html').write_text(page('$STAG | Stag Wif Hood','The $STAG community token: StagR CRM and Stag House Records.',home,'/'))
(D/'stagr').mkdir(exist_ok=True)
(D/'stagr'/'index.html').write_text(page('StagR CRM | $STAG','The first CRM created by a crypto project, for junk removal and moving companies.',stagr,'/stagr/'))
