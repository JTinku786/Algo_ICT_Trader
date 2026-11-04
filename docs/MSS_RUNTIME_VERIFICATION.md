# MSS one-minute runtime verification

Verified locally on 2026-10-03 against stored EURUSD candles. Daily TF1, native one-minute TF2, all HTF checkbox categories except standalone swing highs/lows; OB, breaker, FVG and IFVG entry arrays enabled.

The former engine exceeded the existing 120-second request timeout for August 27–29. Profiling 400 TF2 candles attributed 11.17 of 25.15 instrumented seconds to liquidity and 4.94 seconds to OB calculations. These calculations ran repeatedly on completed prefixes and repeatedly accessed pandas inside their inner loops.

The revised scanner retains completed-prefix inputs and the original package swing calculation. Liquidity, close-break BOS/CHOCH and close-mitigation OB use array kernels matching smartmoneyconcepts 0.0.24. OB updates visit existing slots instead of empty candle slots. The native FVG calculation consumes the newest three candles, since only that middle candle's FVG bounds are used. Origin, activation, retirement, formation filtering, retest entry and structural risk rules are unchanged. The result exposes phase timings and the execution implementation.

| Selection | TF2 candles including warm-up | Measured wall time | Investigations | Result |
| --- | ---: | ---: | ---: | --- |
| 2026-08-27–2026-08-29 | 2,710 | 24.30 s | 6 | Completed; verified in browser, entry selection and minute replay |
| 2026-08-26–2026-08-30 | 4,588 | 65.38 s | 15 | API completed |
| 2026-08-24–2026-08-30 | 7,468 | 111.27 s | 23 | API completed with final OB slot optimization |

Timings are local measurements, not guarantees for other symbols, dates, workload or machine load. The first two measurements preceded the additional OB slot optimization. Repeated identical primitive inputs can use the existing deterministic disk cache. The full-week result is close to the 120-second limit. Capacity is now 10,000 TF2 candles; timeout remains 120 seconds. Larger requests receive an explicit capacity error. One Python worker per investigation; no DB rows, strategy tables or broker orders written.

Validation commands:

```
python scripts/test-mss-primitives.py
python scripts/test-mss-structural-plan.py
node scripts/test-mss-risk-buckets.cjs
node scripts/test-mss-one-minute.cjs
node scripts/test-forex-one-minute-source.cjs
python -m py_compile scripts/market-structure-shift.py scripts/mss_primitives.py scripts/test-mss-primitives.py
npx tsc --noEmit
npx eslint src/app/api/market-structure-shift/route.ts src/app/components/market-structure-shift.tsx
```

All checks passed. Primitive parity checks compare every column exactly across 572 prefixes with random, tied, flat and forex-scale prices, plus complete scanner parity for each fixture. An additional comparison against the saved original scanner matched all zones and events for 400 real EURUSD minute candles and 160 real daily candles. Real-data native primitive comparisons also matched at 8, 30, 100, 400, 1,000 and 2,710 candles before the equivalent OB slot optimization. The full-week test first exposed another timeout, prompting that final optimization and a successful rerun. Browser proof is `public/reports/mss-forex-three-day-performance.png`.
