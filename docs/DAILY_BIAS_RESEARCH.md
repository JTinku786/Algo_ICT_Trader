# Daily Bias research — corrected 2026 run

Run version: 2026-09-30-v2. Snapshot generated: 2026-09-30T23:36:33.075Z. Evaluation: 2026-01-01 to 2026-09-30 exclusive.

## Correction and withdrawal

The original “Close correct” field compared daily close with that day's OPEN. Presenting that as confirmation of the liquidity bias was incorrect. Original close-accuracy claims are withdrawn. That calculation is now a separate “Body aligned” diagnostic. The primary close-confirmation metric is “Close beyond draw”: BUY closes strictly ABOVE the forecast liquidity draw; SELL closes strictly BELOW it. Equality is not confirmation. Touching the draw intraday is a separate result.

For AAPL January 8, 2026: January 7 low = 259.80999755859375; January 8 open = 257.0199890136719; January 8 close = 259.0400085449219. The bearish daily bias reached its draw and closed beyond it (both YES), although its candle body was bullish (Body aligned NO). Daily evidence now includes the actual prior high/low and evaluation-day open/close for direct review.

## Three concepts and timing

The user-supplied TTrades transcript (g3oDYq4P9ZE) frames previous-day liquidity at 00:53, previous-week liquidity at 04:30, swing rejection / next-day model at 07:52, and intraday examples at 14:16. This implementation is a deterministic research adaptation; it does not reproduce every discretionary example.

Daily decisions use the completed signal candle. Close beyond its reference high/low means continuation; one-sided sweep and rejection means reversal. Two-sided rejected sweeps and inside bars are neutral. Weekly references are the week completed before the SIGNAL day: its last-day narrative is retained for next-session evaluation, including Monday. This is distinct from recomputing Monday's levels before that daily candle completes. Swing pivots need two completed bars on either side, a 60-bar lookback and retirement after sweeps. Bias is recomputed daily; discretionary carry-forward, order-block selection and actual high-before-low candle sequencing are not modeled.

## Data quality

Read-only, repeatable-read Postgres snapshot across candles_1d, candles_1h, candles_30m, candles_15m and candles_5m. Exchange-local dates use America/New_York or Asia/Kolkata. Warmup begins September 2025; evaluation is confined to 2026 and excludes the current New York day. Exact duplicate timestamps are deduplicated; conflicting OHLC duplicates are excluded, not arbitrarily selected. Invalid daily observations block the affected immediate context instead of silently substituting an older prior day. Source audits, affected dates and coverage are exported.

SPY and QQQ have no data under their symbols. EURUSD has daily data through June 25 and no intraday data. RELIANCE and TCS miss regular-session bars, so trade economics are excluded. All four intraday timestamp grids must be complete for replay; early-close sessions are excluded. Native daily/intraday corporate-action adjustment consistency remains unverified.

## Mechanical entry and fill assumptions

Require the 5m signal to overlap a same-direction, uninvalidated FVG on EACH native 1h, 30m and 15m frame. This additional alignment is an analyst choice, not a video requirement. FVGs require consecutive trading candles: a missing candle while the market is open is excluded; normal closed-session breaks are allowed only between the final session candle and the next daily session's opening candle. Partial final hourly bars become known at session close.

A directional-middle-body 5m FVG midpoint limit activates after its third candle closes. Stop is the last six bars' extreme. The untouched liquidity draw must offer at least 2R. Target is fixed 2R, expiry is six bars, only the first qualifying setup is considered per concept/symbol/day, and remaining positions close at session end. Signals use the first 150 equity regular-session minutes or the FX London/NY windows in New York time.

Opening gaps through a limit are recognized as marketable fills. Fill price is conservatively kept at the limit; favorable opening-price improvement is not credited. Opening gaps through the stop count as losses at the worse open instead of being dropped as invalid setups. Stop wins simultaneous stop/target touches. Touched-limit fill-bar target ordering is unknown, so it is flagged and TP is deferred; marketable opening fills can hit TP during the same bar. Pending limits cancel when the liquidity draw is reached without a fill. These are OHLC research estimates, not confirmed execution. Constant 0.05R/0.10R friction is a sensitivity, not broker costs. Overlapping concepts are not an additive portfolio.

## Corrected previous-day results

| Symbol | Bias days | Draw touched | Close beyond draw | Body aligned | Trades | Gross R |
|---|---:|---:|---:|---:|---:|---:|
| EURUSD | 90 | 37.8% | 10.0% | 43.3% | 0 | — |
| AAPL | 152 | 65.1% | 38.8% | 53.3% | 4 | 2.00 |
| AXP | 149 | 55.0% | 31.5% | 45.6% | 7 | 2.76 |
| Nifty | 160 | 61.3% | 34.4% | 43.8% | 9 | 3.10 |
| BankNifty | 162 | 63.0% | 37.7% | 43.8% | 8 | 1.00 |
| SPY | 0 | — | — | — | 0 | — |
| QQQ | 0 | — | — | — | 0 | — |
| RELIANCE | 154 | 61.0% | 33.8% | 48.1% | 0 | — |
| TCS | 161 | 57.1% | 32.3% | 45.3% | 0 | — |

Counts can differ from the original snapshot because invalid daily contexts are now excluded. Full weekly/swing results and monthly breakdowns are in report-2026.json. Sample sizes remain too small to establish a durable edge.

## Reproduction and verification

- Dashboard: Daily Bias sidebar tab; Rerun analysis forces a fresh read and shows the report version/timestamp.
- API: GET /api/daily-bias?refresh=1 bypasses the 15-minute cache; responses use Cache-Control: no-store.
- Snapshot: node scripts/run-daily-bias.cjs saves full JSON, summary and evidence CSVs plus SHA-256 manifest.
- Regression and replay checks: node scripts/test-daily-bias.cjs.
- Independent raw-row reconciliation: node scripts/audit-daily-bias.cjs saves database-audit.json.
- TypeScript and targeted ESLint pass. Browser checks confirm AAPL January 8, distinct definitions and rerun control.

Artifacts: output/daily-bias/report-2026.json, summary-2026.csv, daily-evidence-2026.csv, manifest.json and database-audit.json. Older report and exports have been replaced by this corrected version.
