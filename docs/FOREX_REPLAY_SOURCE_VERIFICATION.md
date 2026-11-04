# Forex replay source correction

Verified on 2026-10-03 for EURUSD, August 27–29, 2026. The `candles_5m`, `candles_15m`, `candles_30m`, `candles_1h` and `candles_1d` tables contained no forex rows for this window; their `historical_candles_*` counterparts contained the stored timeframe OHLC. The shared replay loader now reads the historical forex tables for every supported timeframe, including Daily context. US and India source routing is unchanged. No candle rows were created or modified.

The selected window contains 492 five-minute, 164 fifteen-minute, 82 thirty-minute and 41 hourly bars, with `derived_1m` provenance. The loader consumes the stored timeframe rows directly; it does not fabricate bars from an empty native table. Completion times remain timeframe-specific, and existing invalid/conflicting OHLC exclusions remain active.

`node scripts/test-forex-replay-timeframes.cjs` passed all eight combinations: each of 5m, 15m, 30m and 1h as TF1 above 1m, and as TF2 beneath Daily. Tests assert the exact selected-window bar counts, completion intervals, August daily context and successful investigations. `npx tsc --noEmit` and the replay-route ESLint check passed. Browser verification loaded 1 Hour → 1 Minute with 20 investigations and confirmed replay advanced from 04:15 to 04:16 America/New_York. Proof: `public/reports/forex-hourly-source-fixed.png`.
