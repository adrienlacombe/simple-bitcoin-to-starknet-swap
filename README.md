# BTC to Starknet Swap

Simple client-side web app to swap Bitcoin to wrapped BTC on Starknet. Enter a Starknet address, get a Bitcoin deposit address with QR code, send BTC from any wallet.

## Providers

- **Garden Finance** — swaps BTC to WBTC on Starknet via [Garden](https://garden.finance) REST API. Requires an API key.
- **tBTC** — mints tBTC on Starknet via [Threshold Network](https://threshold.network) SDK. No API key needed. Minting takes ~1-3 hours (optimistic minting + L1→Starknet bridging).

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your credentials:

```
VITE_GARDEN_API_KEY=your-garden-api-key
VITE_ETHEREUM_RPC=https://your-ethereum-rpc-url
VITE_STARKNET_RPC=https://your-starknet-rpc-url
```

- **Garden API key**: get one at [garden.finance](https://garden.finance)
- **Ethereum RPC**: any mainnet RPC (e.g. Alchemy, Infura, Dwellir) — needed for tBTC only
- **Starknet RPC**: any mainnet RPC — needed for tBTC status tracking

## Development

```bash
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## How it works

1. Pick a provider (Garden WBTC or tBTC)
2. Enter your Starknet recipient address and a Bitcoin refund address
3. For Garden: enter a BTC amount and confirm the quote
4. Scan the QR code or copy the deposit address
5. Send BTC from any wallet
6. The app polls for status and notifies you when the swap completes

Orders are saved to localStorage so you can resume tracking after a page refresh.

## Tech stack

- Vite + vanilla TypeScript
- Garden Finance REST API
- tBTC SDK (`@keep-network/tbtc-v2.ts`)
- QR codes via `qrcode`
