# Reversals updated

Implemented 2026-10-16. Open `/?tab=reversals-updated` in the existing application. The original Reversal tab is retained.

## Scope

This is a read-only research and evidence workspace. It does not regenerate signals, repair omitted opportunities, change broker filters, submit orders or promote a strategy. Pending same-bar completeness and cost validation are visible in the product.

## Contracts

- Historical: newest `k1_reclaim3` run for the exact timeframe and `FULL` (US) or `FX_FULL` (Forex). No alternate-market fallback. Cohort is OTE62 / 2R / legacy hard identity. Headline metrics additionally require primary, risk_ok, setup_valid, exit_verified and a finite recorded closed result.
- Paper: `realtime_production_reversal_k1_setups`, exact market/timeframe. Duplicate setups and non-true risk_ok are excluded from eligible rows. Certified closed results require VALID_PAPER_FILL.
- Practice: `reversal_k1_live_orders`, exact Forex/timeframe, including skipped decisions. Closed metrics require a broker trade reference and recorded R. Realized P&L and financing are displayed separately; no additive net-P&L assumption is made.
- The effective exit policy comes from persisted evidence. `hard` is not presented as the active exit policy.
- Date bounds are inclusive New York entry dates; practice uses fill time or decision time for unfilled decisions. Historical naive timestamps are displayed as New York wall clock, without browser-local timezone interpretation.

## API and evidence

`GET /api/reversals-updated?lane=history&market=us&tf=1h&symbol=&start=&end=&costBps=0&page=1`

All database queries use a repeatable-read, read-only transaction and parameterized filters. Metrics and yearly slices cover the complete eligible closed cohort; only the ledger is paginated (50 rows). `format=csv` exports all eligible matching rows, including evidence, independent of the current page. The response has a generated timestamp, source run, coverage, policy counts and exclusion reasons. Unavailable datasets and query errors are separate states.

The Cost reconstruction dropdown switches the complete cohort between gross, round-trip bps sensitivity and a configurable component estimate. Selection updates headline expectancy, positive/non-positive result counts, average and worst losses, tails, yearly bars, trade rows and exports. Original gross R remains available alongside the selected-cost R.

- Bps sensitivity subtracts `roundTripBps / (risk_pct * 100)` per trade. `risk_pct` is in percentage points.
- Component estimate: Forex spread is entered in pips (JPY 0.01, other pairs 0.0001), equities in bps. Charge one full spread per round trip. Add round-trip commission/fees and slippage in bps, plus financing/borrow bps per day times recorded elapsed holding days. Divide each price-cost component by the corresponding planned risk distance.
- Defaults are assumptions, not measured broker rates. Missing required holding/risk data remains unpriced, with costed/closed coverage shown. Linear financing does not reconstruct historical rollover calendars, triple charges, credits or rate changes. Entry and exit prices are not re-simulated.
- Practice fills already incorporate bid/ask execution. Estimated cost controls are disabled for that lane and API requests attempting to apply them are rejected, preventing a second spread charge. Recorded P&L and financing remain separate.
- CSV includes gross R, selected-cost R, cost R, holding days and the complete cost assumptions. Exact historical broker-cost reconstruction remains unverified.

Historical chart requests include both run and trade identifiers, preventing a chart from accidentally loading the same trade ID from another run. Paper charts reuse the existing raw-five-minute chart. The evidence dialog exposes actual exit price and distinguishes candle knowledge/fill observation from unrecorded actual first discovery.

## Verification

- `npx tsc --noEmit --pretty false`
- Targeted ESLint on new UI, API and shared contract.
- `node scripts/test-reversals-updated.cjs`: parameter validation, cost units, full-population counts, reconciled waterfall, yearly totals, non-overlapping pagination, sensitivity, empty states, market/contract isolation and full CSV export.
- `npx --yes --package @playwright/cli playwright-cli -s=reversals-updated run-code --filename scripts/test-reversals-updated-browser.js`: deep link, metrics, walkthrough, validation, run-bound historical chart, native-dialog Escape dismissal, practice/paper separation and 390px mobile overflow.
- Screenshots: `output/playwright/reversals-updated/`.
- `scripts/test-reversal-cost-controls.js`: browser verification that selecting component costs changes expectancy, financing changes it again, switching off restores gross results, and practice estimates remain disabled.

## Remaining research

Replay omitted same-bar candidates with order activation and raw-five-minute chronology. Preserve indeterminate cases; do not automatically add losses. Compare stop policies on identical entries, reconstruct complete costs, persist actual detection/submission clocks and verify account-wide risk enforcement. None of these outcomes is represented as completed by this UI change.
