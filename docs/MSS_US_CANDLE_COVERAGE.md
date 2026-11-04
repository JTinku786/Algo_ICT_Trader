# US MSS candle coverage

The historical replay loader previously restricted US intraday data to `historical_candles_5m` with `source='barchart'`. JNJ July 7–24, 2026 has no rows in that archive, but has 1,092 valid stored `candles_5m` rows from yfinance. The resulting missing-TF2 error was a source-selection defect.

US historical intraday replay now prefers the Barchart archive at each timestamp, fills missing timestamps from `candles_5m`, then uses the isolated completed 5-minute supplement. Duplicate/conflict validation remains active within the preferred source. The same selected 5-minute candles form 15-minute, 30-minute and hourly bars; rollups require contiguous complete constituent candles and anchor at 09:30 New York time. No candles or strategy rows are written, and no 1-minute candles are synthesized.

Verified for JNJ July 7–24: 1,092 five-minute bars, 364 fifteen-minute bars, 182 thirty-minute bars and 98 hourly bars. The 1H → 5m close-CHOCH MSS API completed with 132 investigations, 231 HTF bars including warmup, and 1,342 lower bars including 250 warmup bars. The loader audit reports one invalid daily-context source row, which remains excluded; no duplicate conflicts were reported.

Checks: `node scripts/test-us-replay-gap-sources.cjs`, `node scripts/test-replay-aggregate.cjs`, TypeScript and replay-route ESLint.

The website also completed the four selected confirmation modes (CHOCH, wick CHOCH, CISD and either), carry-in warmup and candle-delivery OBs for the same dates: 1,239 investigations and 108 distinct shifts. These are investigation contexts, not a count of independent trades. Browser evidence: `public/reports/mss-jnj-july-candle-fix.png`.
