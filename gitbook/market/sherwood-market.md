# Sherwood Market (Trade Tokens P2P)

**Sherwood Market** is a peer-to-peer marketplace for tokens on Robinhood Chain — think **"eBay for tokens."** One person posts what they want to sell and names their price; another person buys it directly. No liquidity pool, no slippage, no market maker — just a direct trade between two people.

It lives at **stagwifhood.fun/market** and works for **any standard token on Robinhood Chain**, not just $STAG.

> 🏹 **Why it exists:** sometimes you want to sell a token at *your* price, or buy one that isn't on a chart yet. Sherwood Market lets you post an offer and wait for a buyer — like a classified ad, but the trade settles automatically and safely on-chain.

## How it works (the important part)

When you post a sell order, your tokens are **moved into the marketplace contract (escrow)** right away. They sit there, locked, until either a buyer fills your order or **you** cancel it.

This one design choice makes the whole thing safe:

- **You can't "sell it twice."** The moment you post, the tokens leave your wallet and go into escrow. You physically can't sell them somewhere else while the order is open — so a buyer can never pay into an empty order.
- **A buyer always gets exactly what the order shows.** The tokens are already sitting in escrow when they hit "Buy."
- **One order can never touch another order's tokens.** Each order's escrow is tracked separately.

> 💡 **"What if I change my mind?"** Just **Cancel** — you get your full escrow back instantly. If a cancel happens at the same second someone tries to buy, the buy simply fails and refunds them. Nobody loses funds.

## Fees

A **1% fee on each side** of every completed trade goes to the $STAG marketing wallet:

- **1% from the seller's side** (taken from the token being sold)
- **1% from the buyer's side** (taken from the payment)

Fees are collected **in-kind** — in whatever token each side used — and the team burns or reinvests them. The fee is **locked in when the order is posted**, so it can never be changed on you after the fact, and it's **hard-capped at 3%** in the contract — nobody can ever set it higher.

## How to SELL (post an order)

1. Go to **stagwifhood.fun/market** and **Connect Wallet** (be on Robinhood Chain, chain 4663).
2. Tap **Post an Order**.
3. Pick the **token you're selling** and the **amount**.
4. Pick what you want to be **paid in** — **ETH**, or another token — and the **price** (total amount you want).
5. **Approve** the token, then **Confirm** the post. Your tokens move into escrow.
6. ✅ Your order is now live for anyone to fill. You keep custody-by-contract until it sells or you cancel.

> You'll need a little **ETH on Robinhood Chain** for gas on each step.

## How to BUY (fill an order)

1. Go to **stagwifhood.fun/market** and **Connect Wallet**.
2. Browse the **open orders**. Each one shows what's for sale, the price, and what you pay in.
3. Tap **Buy** on the one you want.
4. **Confirm** in your wallet (pay in ETH as the transaction value, or approve + pay the token).
5. ✅ Done — in a single transaction you receive the tokens (minus the 1% fee) and the seller gets paid (minus their 1% fee).

## How to CANCEL

1. Open the **market** page and find **your** order.
2. Tap **Cancel** and confirm.
3. ✅ Your full escrow returns to your wallet. Only you (the maker) can cancel your own order.

## Which tokens are supported?

**Standard ERC-20 tokens and native ETH.** That covers the vast majority of tokens on Robinhood Chain, including $STAG.

> ⚠️ **Not supported: rebasing / elastic-supply tokens and "sender-tax" tokens** (exotic tokens whose balance changes on its own, or that charge the *sender* extra on every transfer). The marketplace UI warns you if a token looks unusual. Stick to normal tokens and you're fine.

## Is it safe?

- **Escrow-based** — funds are held by the contract, not by a stranger's promise.
- **Independently audited + fuzz-tested** before going live (reentrancy-guarded, checks-before-transfers, per-token escrow isolation, 200-op randomized invariant simulations).
- **Owner powers are minimal** — the owner (the $STAG dev wallet) can only *retune fees within the 3% cap* and *change the fee wallet*. The owner **cannot** touch, move, or cancel anyone's escrowed orders. Ever.
- **Verified on-chain** — read the full source on the [explorer](https://robinhoodchain.blockscout.com/address/0x6Dfb9800864Bd483Ffe17052B28e9a50EE81B6E7).

## Contract

| Item | Value |
|---|---|
| **Sherwood Market** | `0x6Dfb9800864Bd483Ffe17052B28e9a50EE81B6E7` |
| Network | Robinhood Chain (4663) |
| Fees | 1% buy / 1% sell (3% hard cap) |
| Verified | ✅ Blockscout |

> Paste the address into the [explorer](https://robinhoodchain.blockscout.com) to verify it yourself before trading — always a good habit.
