# STAG ARCHERY — Handoff Brief

A finished, self-contained **3D first-person archery game** for $STAGWIFHOOD.
Everything is baked into one file: `stag-heist.html`.

---

## 1. What it is

- Real 3D (three.js) first-person archery: draw the bow, read the wind, sink the bullseye.
- Endless survival — 3 misses and the run ends; targets get farther / smaller / drift as your score climbs.
- Ring scoring, streak combos, gold "loot" bursts on bullseyes.
- Full synthesized sound (no audio files) + a 🔊 mute button.
- Emerald-dusk "promo" atmosphere: green cyber-skyline, neon-green energy arrows.
- The real $STAGWIFHOOD character art: **#3 Forest Ranger** = corner mascot (laughs on a miss),
  **#11 Golden Archer** = start-screen hero + the in-range banner.
- In-range **billboard** that rotates: promo video → "rent this billboard" → Telegram → live leaderboard.
- **Global leaderboard** (see §3).
- Telegram links point to **t.me/kingpetty317**.

## 2. How to host it (pick one)

It's **one static HTML file, ~1.9 MB, no build step, no dependencies.** All assets
(three.js, the promo mp4, character images) are embedded as data URIs.

- **Best:** commit `stag-heist.html` into the $STAG repo and serve it from the $STAG
  domain (e.g. `stagwifhood.xyz/play` or a subpage). Rename freely.
- If the host won't serve arbitrary root `.html` (some Vercel setups don't), either put it
  under `/public`, or serve it via `https://raw.githack.com/<org>/<repo>/<branch>/stag-heist.html`.
- Nothing else required — open the URL and it runs.

## 3. Leaderboard — IMPORTANT

- The board is **global** and already **live and working**. The game reads/writes it at an
  **absolute URL**, so it works from *any* host (CORS is open):

  ```
  https://www.catboyonsol.fun/api/stag-lb
  ```

- That endpoint currently lives on the **catboy** project's Vercel + Neon Postgres. It works
  fine cross-origin from the $STAG site — no change needed to keep the leaderboard working.

- **To move the leaderboard onto $STAG's own backend** (recommended eventually, so there's no
  catboy dependency):
  1. Deploy the endpoint below on the $STAG Vercel (or any host) with a Neon/Postgres `DATABASE_URL`.
  2. In `stag-heist.html`, change the single line:
     `const LB_API='https://www.catboyonsol.fun/api/stag-lb';`
     to the new URL.
  3. That's it. (The endpoint source is included as `stag-lb.js`.)

- Scores are deduped to best-per-name, rate-limited, and garbage scores are rejected.
  If you want to wipe the starter/house scores, add a small admin-clear route or truncate the
  `stag_scores` table.

## 4. Controls

- **Hold** to draw (power builds) · **drag** to aim · **release** to fire.
- Read the wind meter (top) and the dotted green trajectory + landing ring.
- Tap the in-range billboard → opens Telegram.

## 5. Notes

- Fully client-side; no secrets in the file.
- The promo on the billboard is an embedded H.264 mp4 (plays on iOS/Android). If a device
  can't decode it, a "▶ WATCH THE PROMO" card shows instead (never a black screen).
- Local device scores are kept in `localStorage` as an offline fallback if the API is unreachable.
