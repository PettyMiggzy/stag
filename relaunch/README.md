# STAG relaunch preview

A static, no-build preview page for the STAG relaunch. Open `index.html`.

- Built around the four Junk Junkies Texas logos (Spring, Tomball, Cypress, College Station).
- Uses real crew photos from the businesses.
- Does not use the old collection artwork. Those files are untouched elsewhere in this repo.
- Copy deliberately contains no returns, prizes, discounts or yield claims. Anything connecting a
  token to the businesses needs legal review before it goes on a public page.

Fonts load from Google Fonts. Nothing here touches the existing site at the repo root.

## Game and the token hook

`#game` is an idle game with no tapping: trucks drive on a real map between claimed cities. Claim the 16 cities in order and upgrade each crew's truck, trailer and helpers.
Progress is saved in `localStorage` (key `stagr-claim-v2`) with up to 8 hours of offline earnings.

Premium perks are listed but locked. When STAGR launches, set `window.STAGR.enabled = true` and implement
`window.STAGR.pay(perk)` so it resolves `true` only after the on-chain payment is confirmed, then replace the
disabled "Soon" buttons in the "STAGR perks" tab with real buy buttons. Game cash has no cash value and cannot be cashed out.
Prices, perks and any rewards need to be set and reviewed before launch.
