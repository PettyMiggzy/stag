# Buying with Solana (SOL)

You **can** buy $STAG (or bridge to ETH) using **Solana** — but there's one thing that trips people up, so read this once and you'll be fine.

## The key idea
- **Solana** wallets (Phantom, Solflare) use a totally different address format than Robinhood Chain.
- **Robinhood Chain is EVM** — it uses **0x… addresses** (MetaMask-style).
- So when you pay with SOL, the $STAG/ETH has to land at an **EVM (0x) address**.

👉 **That means: to buy with Solana, you also need an EVM wallet (like MetaMask) to *receive*.** You pay from Solana; you receive on Robinhood Chain.

## How it actually works (simple version)
1. You sign a transaction in your **Solana wallet** that sends your SOL.
2. Behind the scenes, a "solver" instantly delivers the equal value as **$STAG (or ETH) on Robinhood Chain** to your **0x address**. They take the SOL, they front the delivery — takes seconds.
3. You end up with **$STAG (or ETH) on Robinhood Chain**, at your EVM address.

You are **not** putting SOL "onto" Robinhood Chain — you're swapping SOL *for* $STAG that lands there.

## Step by step
1. Go to **stagwifhood.fun/bridge**, pick the **🦌 Buy $STAG** tab.
2. **Connect your Solana wallet** (Phantom/Solflare) — this is the *source* (what pays).
3. When asked, **connect your EVM wallet (MetaMask)** or paste your **0x address** — this is the *destination* (where $STAG lands).
4. On **Sell**, choose **SOL** and an amount. **Buy** shows **$STAG**.
5. Confirm in your Solana wallet. Done — $STAG appears at your 0x address on Robinhood Chain.

## Don't have an EVM wallet yet?
Get one first — [Set Up Your Wallet](../getting-started/wallet-setup.md). It's free and takes 5 minutes. Then come back here.

> **This isn't a $STAG quirk** — bridging *into any EVM chain from Solana* always works this way. You always need an address on the receiving side.
