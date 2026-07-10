# Algo ICT REST API

Local REST gateway for data that currently lives in the workstation Postgres database.

## Endpoints

- `GET /health`
- `GET /api/candles/5m?market=us&tickers=AAPL,MSFT&limit=100`

The candle endpoint reads `candles_5m` from `titania_trading`.

## Required Environment

- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_DATABASE`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_SSLMODE`
- `ALGO_API_TOKEN`

`ALGO_API_TOKEN` is expected in the `x-api-key` request header.
