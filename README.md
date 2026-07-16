# StripChain Testnet Bot

Automated testnet interaction for StripChain — intent-based interoperability protocol.

## What is StripChain?

StripChain is a full-stack intent-based interoperability protocol that enables cross-chain operations through unified accounts. One wallet = native addresses on 15+ chains (BTC, ETH, SOL, SUI, ARB, etc.).

- **Token:** STRIP (confirmed, no TGE yet)
- **Score:** 72/100 — worth farming
- **Cost:** FREE (testnet tokens only)

## Features

- **Bridge Info** — Get deposit addresses for all supported chains
- **Pure API Deposit** — Send testnet ETH directly to bridge (no browser needed)
- **Browser Automation** — Full cycle with Playwright (connect, mint, swap, bridge)
- **Multi-Wallet** — Rotate through multiple wallets
- **Intent Polling** — Track intent status until completion

## Requirements

| Requirement | Details |
|------------|---------|
| Node.js | v18+ |
| npm | v8+ |
| MetaMask | Browser extension (for browser mode) |
| Testnet ETH | Arbitrum Sepolia faucet |

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your config
```

Create `wallets.txt` with one private key per line:
```
abc123...
def456...
```

## Usage

```bash
# Show bridge info & endpoints
node src/bot.js info

# Connect wallets & generate addresses (browser)
node src/bot.js connect

# Deposit testnet ETH to bridge (pure API, no browser)
node src/bot.js deposit

# Full cycle: deposit + mint + bridge + convert
node src/bot.js full-cycle
```

## API Endpoints (Reverse-Engineered)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/getBridgeAddress` | GET | Bridge deposit addresses per chain |
| `/createIntent` | POST | Submit signed intent |
| `/getIntent?id=xxx` | GET | Poll intent status |
| `/oauth/sign` | POST | Google OAuth sign |
| `/oauth/verifySignature` | POST | Verify signature |

**Base URL:** `https://seq.stripchain.xyz`

## Intent Flow

1. `GET /getBridgeAddress` → get bridge deposit address
2. Send native tokens to bridge address (on-chain TX)
3. Build unsigned intent with operations
4. Sign with wallet's `signMessage`
5. `POST /createIntent` → returns intent ID
6. `GET /getIntent?id=xxx` → poll until COMPLETED

## Supported Chains

ETHEREUM, SOLANA, BITCOIN, SUI, ARBITRUM, APTOS, ALGORAND, DOGECOIN, STELLAR, CARDANO, RIPPLE, POLKADOT, SONIC, BERACHAIN, ICP

## Operation Types

TRANSACTION, SEND_TO_BRIDGE, BRIDGE_DEPOSIT, SWAP, BURN, BURN_SYNTHETIC, WITHDRAW

## Faucets

- **Arbitrum Sepolia:** https://faucet.quicknode.com/arbitrum/sepolia
- **Ethereum Sepolia:** https://www.alchemy.com/faucets/ethereum-sepolia
- **Solana Devnet:** https://faucet.solana.com
- **Sui Testnet:** https://faucet.sui.io
- **Bitcoin Testnet3:** https://coinfaucet.eu/en/btc-testnet/

## Risk Level

LOW — Free testnet, no real funds, confirmed token (STRIP), ITTC sale ongoing.

## References

- [Blog](https://blog.stripchain.xyz)
- [Testnet Announcement](https://blog.stripchain.xyz/post/announcing-stripchain-public-testnet-v1)
- [Whitepaper](https://blog.stripchain.xyz/post/introducing-stripchain-whitepaper-2025)
- [Roadmap](https://blog.stripchain.xyz/post/206-the-year-we-solve-unification)
