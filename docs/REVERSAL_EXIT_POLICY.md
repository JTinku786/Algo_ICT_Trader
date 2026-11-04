# Reversal exit policy

Policy: `M5_CLOSE_SL_WICK_TP_V1`. Generated 2026-10-12T23:37:39.441313-04:00.

All saved reversal study rows and current realtime k1 paper rows use completed
5-minute candles for exits, independently of their signal timeframe.

- BUY stops only on a close strictly below the configured stop; SELL stops only
  on a close strictly above it. An equal close or wick crossing alone does not stop.
- BUY targets use high >= target; SELL targets use low <= target. A target touch
  precedes a same-candle close-stop. Exit timestamps record completed-bar observation,
  not an invented intrabar touch time.
- Target price is the configured target. Stop exit price is the actual confirming
  candle close. Realized R uses the original entry-to-stop distance, with no loss cap.
- No exit timeout. Missing, invalid or conflicting source paths are unverified;
  their returns and closing fields are null and excluded from performance.

Historical market entries start at native bar open. Historical limits start after
the first validated 5m fill candle; that fill candle is excluded because pre-fill
and post-fill target ordering is unknown. Realtime paper monitoring starts at its
confirmed raw 5m fill observation; native observed_at records later discovery. These entry boundaries must be checked against decision-known-at evidence; exit verification alone does not validate the setup. The boundaries are recorded explicitly
in evidence and are not claims of live broker fills.

Historical replay: 1,673,962 saved variants across 34 runs;
70,204 unverified. Original rows are preserved in
`reversal_trades_exit_baseline_v1`. Realtime originals are preserved in each
row's `strategy_json.original_exit_outcome`.

Future persisted reversal engine runs invoke the shared replay; standalone native
CSV diagnostics without a 5m source are unverified. Realtime scheduled scans use the
same stop/target evaluator and retain unresolved source gaps for later rechecking.

Charts retain raw validated source OHLC; isolated supplements fill only timestamps
absent from native/archive feeds. Legacy hard/close cohort labels remain for comparison; regenerated trade IDs can differ from the baseline;
both cohorts now use this exit rule. Old native bars-held/MFE/post-stop metrics are
cleared because they no longer describe the replayed exit path.

These are research/paper returns before fees, spread, slippage and financing.
See [results](../public/reports/reversal-exit-rule-results.html) and
[exact evidence](../public/reports/reversal-exit-rule-results.json).
