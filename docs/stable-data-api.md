# Stable Data API Plan

The production data path should not expose the workstation Postgres directly to the internet.
With no paid domain, the current zero-cost path is a zrok public share in front of the local REST API.

## Recommended No-Domain Architecture

```text
Browser -> Vercel Next API -> zrok reserved public proxy -> local REST API -> local Postgres -> candles_5m
```

Run services:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-rest-api.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-zrok-share.ps1
```

Reserved zrok endpoint:

```text
https://algoicttraderapi.share.zrok.io
```

Set Vercel production env:

```powershell
"https://<zrok-share-host>" | npx vercel env add CANDLES_REST_API_URL production
"<backend\api-token.local>" | npx vercel env add CANDLES_REST_API_TOKEN production
npx vercel deploy --prod --yes
```

## Local REST API

Endpoints:

- `GET /health`
- `GET /api/candles/5m?market=us&tickers=AAPL,MSFT&limit=100`

The candle endpoint requires `x-api-key: <ALGO_API_TOKEN>` when the token is configured.

## Permanent Cloudflare Tunnel Setup

This option needs a Cloudflare account plus a domain/zone, so it is not the current no-domain plan.

One-time interactive setup:

```powershell
cloudflared tunnel login
cloudflared tunnel create algo-ict-trader-api
cloudflared tunnel route dns algo-ict-trader-api api.<your-domain>
```

Then create `cloudflared/config.yml` from `cloudflared/config.example.yml`.

Run services:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-rest-api.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-named-cloudflare-tunnel.ps1
```

Set Vercel production env vars:

```powershell
"https://api.<your-domain>" | npx vercel env add CANDLES_REST_API_URL production
"<ALGO_API_TOKEN>" | npx vercel env add CANDLES_REST_API_TOKEN production
npx vercel deploy --prod --yes
```

## Why Not Direct Postgres

Directly exposing port `5432` creates a larger attack surface and complicates network controls.
The REST layer gives us auth, input validation, row limits, and room to add caching and observability.
