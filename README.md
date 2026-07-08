# 🦌 STAGWIFHOOD ($STAG)

> The stag who stole Robin Hood's hood. Face of Robinhood Chain.

A high-quality, single-page marketing site for **$STAG** — forest-and-gold theme,
animated hooded-stag hero, the **Milestone Prize Heist** (hold to win real prizes at
every market-cap milestone), and **The Hooded 20** NFT collection.

## Stack

Static site — plain HTML/CSS/JS, no build step. Deploys to Vercel or Cloudflare Pages
as-is. Fonts from Google Fonts (Cinzel / Inter / Space Grotesk).

```
index.html            # all sections
css/style.css         # design system + animations
js/main.js            # scroll reveals, count-ups, ladder fill, NFT gallery
assets/img/           # logo.png (hero), favicon.svg, generated art
assets/nft/stagwifhood/
  img/NN.png          # The Hooded 20 art
  metadata/NN.json    # per-token metadata
  collection.json     # collection-level metadata
  manifest.json       # index of the 20
scripts/generate-nfts.mjs   # Venice art generation ("$STAG AI")
vercel.json           # dev-branch preview builds disabled (cost control)
```

## Art generation ("$STAG AI")

All art is generated through Venice AI (referred to publicly only as **"$STAG AI"** —
never name the provider in marketing). The API key is read from the environment:

```bash
export AI_PROVIDER_KEY="…"     # or VENICE_INFERENCE_KEY_…
node scripts/generate-nfts.mjs            # generate all 20 + hero
node scripts/generate-nfts.mjs --only 3   # regenerate a single token
```

Character lock (prepended to every prompt for consistency): a majestic brown stag in a
forest-green Robin Hood hood, large antlers, golden-hour pine forest, gold-and-green
palette, painterly stylized-3D storybook look.

## Deploy notes (cost control)

- Preview deployments are **off** for the dev branch (`vercel.json`) — pushes here don't
  trigger builds.
- Keep large media (video) **out of git** — host on a CDN and reference the URL.
- It's a static site: a "build" is just clone + `npm install`, so keep the repo lean.

## Before launch — fill these in

- `#ca-text` in `index.html` — the real contract address.
- `SOCIALS` in `js/main.js` — X and Telegram URLs.
- Confirm the milestone/prize ladder copy in the **Prize Heist** section.
