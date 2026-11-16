# Verified projects

Anyone can launch any name or symbol on the pad, including one that copies another project. The verified list is how we mark the
official pad token of a real project. It is a plain file, edited by hand: `stagsite/pad/verified.json`. There is no contract behind it.

## What the site does with it
- A token listed there gets a green **Verified** badge on its card, its token page and in battles, plus a panel with the project's
  official links and, if it has one, the address of its original token on another market or chain.
- Any other token whose name or symbol matches a verified project (ignoring case, punctuation and a leading "w") gets a red
  **Lookalike** warning that points at the real one.
- `/pad/verified/` lists every entry, the home page has an "All / Verified" filter.
- All text from the file is length-limited and escaped, and only https links are kept.

## Entry format
```json
{
  "version": 1,
  "projects": [
    {
      "name": "Example Project",
      "symbol": "EXP",
      "padToken": "0x...checksum address of the pad token (the war version)...",
      "original": { "address": "0x...checksum address of the original token...", "chain": "Robinhood Chain", "symbol": "EXAMPLE" },
      "links": { "x": "https://x.com/...", "telegram": "https://t.me/...", "website": "https://..." },
      "verifiedOn": "2026-11-16",
      "by": "Pad token address posted from the official X account (link kept in our notes)"
    }
  ]
}
```
`original` and each link are optional. Addresses must be in checksum case.

## Process for adding a project
1. The project launches its token on the pad and posts the contract address from its official account.
2. They send us the post link and the address.
3. We check: the account really is the project's (history, followers, the project's own site links back to it), the address in the
   post equals the token, and the token's creator address is the one that launched it.
4. Add the entry, run `node tools/check-verified.js` (it must print OK), commit, deploy.
5. To remove an entry: delete it, run the check, commit, deploy. Do this as soon as an entry turns out to be wrong.

## What verified means (keep this wording)
It means we confirmed the project's official account posted that address. It is not an audit, not an endorsement and not a promise
about price. A verified token can still lose most or all of its value.
