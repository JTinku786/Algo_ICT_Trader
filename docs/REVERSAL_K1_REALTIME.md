# Reversal realtime: k1_reclaim3

The Reversal tab's default realtime view now uses the existing `trend_reversal_2026/reversal_engine.py` detector, imported without changing the historical study. `k1_reclaim3` means a 1-bar confirmed internal fractal swing with failed breaks reclaiming within 3 bars. It is separate from the Market Structure Shift detector.

Preset: **OTE 62% limit · 2R · 5m close SL / wick TP**. The limit is the displacement-leg extreme plus 62% of the distance back to the sweep extreme. The sweep extreme is the stop; target is 2 times actual entry risk. The native 10-bar limit expiry/cancellation rules and one-primary-entry-per-MSS grouping are retained. Forex intraday extends the same bar-based rules to 1H and 30m; scaled audit/risk flags remain metadata.

Default scope:

- Both US and forex: 31 stored US watchlist symbols including SPY/QQQ, and 12 currency pairs.
- Entry timeframes: Daily, 1 hour and 30 minutes. The Entry timeframe control independently selects them, including a timeframe with zero current entries.
- The feed shows Signal timeframe by default (Daily, 1 Hour or 30 Minutes), read from the saved setup's `strategy_json.timeframe`. API rows and CSV use the corresponding `signal_timeframe` value (`1d`, `1h`, `30m`). It describes the signal's native timeframe, independent of the chart timeframe selected for viewing.
- ICT Entry Sessions applies immediately in Realtime Reversals. Multiple sessions match any selected window in New York time, Clear all returns zero entries, and Select all restores the full population. Auto-refresh, pagination and CSV retain the applied selection; older requests cannot overwrite a newer result. Other filters retain the Run action.
- The feed's Entry time order selector chooses Newest first or Oldest first. The Entry time table header also toggles direction. Sorting resets to page 1 and updates the saved query so later session changes retain the chosen order. Column visibility buttons have separate labels and do not sort.
- History begins **July 1, 2026**, with the end date advancing at New York midnight. Manual date changes suspend the advancing end date until Reset. Startup catch-up and fresh observations are both shown, with source labels.
- Entry charts reuse the Historical Study's `DailyForwardChart`: Daily / 1H / 30m / 15m, ±20/40/60 bars, anchored at the sweep and entry, with the same evidence notes and ICT controls. Its source now supplements native/archive gaps with the isolated completed 5m feed. Forex entry/stop/target prices show five decimals.
- Each chart links to Market Structure Shift with the ticker, native entry timeframe, higher context timeframe, sweep-to-entry dates, direction and exact entry timestamp. Local close-break with one-bar pivots is selected. A completed-candle handoff carries the same validated sources to MSS, so recent US entries do not lose their candle history. MSS recomputes its own array/retest investigation; the saved k1 trade proof remains unchanged.

The scanner refreshes validated raw 5-minute sources and forms complete intraday candles. US 1H candles anchor at 09:30 and include the completed final half-hour of a regular session. Missing constituent bars exclude a rolled-up candle. Daily uses completed native bars or complete-session supplements. Forex Sunday daily stubs merge into Monday as in the existing study. Current incomplete Daily, 1H and 30m bars never enter detection.

An entry is observed at the limit-fill candle's close. Paper outcomes use completed 5-minute candles after entry observation. A BUY stops only when the close is strictly below its set stop; a SELL stops only when the close is strictly above it. A wick crossing SL alone keeps the trade open. The stop exits at the confirming candle's actual close and records its full signed R, including losses exceeding -1R. BUY target hits use the high; SELL target hits use the low. A target touch wins before a same-candle closing stop breach, because the stop triggers only at the close. No 60-bar timeout is applied. These are candle-based paper outcomes without spread/costs or broker execution claims.

Runtime files live in `C:\Users\saite\Desktop\ICT_Automation\realtime_execution`: `reversal_k1_realtime.py`, `reversal_k1_schema.sql`, `install_reversal_k1_schedule.ps1`, `verify_reversal_k1.py`.

Windows task `ICT-Reversal-k1-5m` runs every five minutes. The earlier `ICT-MSS-Reversal-5m` task is disabled and its XML retained. Existing MSS rows are retained for research, excluded from this Reversal view. The daily Codex automation now invokes the k1 digest at 17:10 New York. Discord and Slack use the existing destinations and per-destination database delivery deduplication. Fresh alerts require observation within 15 minutes; initial catch-up entries produce no stale alerts. The computer must be awake with its scheduled user session available.

Orders and runs use isolated `realtime_production_reversal_k1_orders` and `_runs` tables; full native signal/trade proof, engine hash and candle evidence are preserved. The exit correction also re-evaluates historical Reversal rows while preserving their original baseline and trade identities. Broker lanes are unchanged.

Legacy touch-stop verification, before the 5m closing-stop correction (July 1–October 6, 2026): **735 entries**. US: 15 Daily, 91 on 1H, 137 on 30m. Forex: 7 Daily, 156 on 1H, 329 on 30m. Of these, 728 closed and seven remain open. Every native OTE price, sweep stop, 2R target and all 728 first-hit outcomes passed independent checks. The full API and CSV each returned 735 entries with complete proof. July backfill took 43.44 seconds. The five-minute scanner continues a short recent scan and monitors older open trades, retaining the complete July-onward history.

To populate or refresh historical entries without stale alerts:

```powershell
python realtime_execution/reversal_k1_realtime.py scan --start 2026-07-01 --end 2026-10-06 --no-refresh --no-alerts
```

Evidence: [persisted verification](../public/reports/reversal-k1-realtime.json). Log: `realtime_execution/logs/reversal-k1-cron.log`. Latest report: `realtime_execution/artifacts/reversal_k1/latest.json`.


Earlier exit-only replay snapshot on October 11, 2026 (New York), superseded by the canonical candle/setup rebuild: the July 1–October 11 realtime population contains **776 entries: 340 target wins, 399 stop losses, 10 open and 27 unverified**. Verified closed results total **+158.2527469831475R**; the dashboard rounds the aggregate to **+158.25R**. The mean stop loss is **−1.31R**. Unverified rows have no asserted close price, close time or realized R, and do not enter closed performance statistics. The full API and CSV each returned 776 entries, with CSV preserving actual R precision and complete strategy proof. These are archived exit-only results, not the final rebuilt cohort results. Consult the newly generated report after the canonical source/setup rebuild.

Both Reversal chart feeds use raw validated completed 5m OHLC without clipping highs/lows to daily ranges. Conflicting native timestamps are omitted; the isolated feed supplements only timestamps absent from both native feeds. ETF and forex sources follow the same rule. Historical exit charts use actual verified exit prices and 5m confirmation timestamps. Original historical touch/close cohort identities remain for comparison; both use the corrected exit policy. Missing verified coverage is shown explicitly and excluded from performance.

The current paper replay also verifies the complete liquidity-lookback, sweep and
MSS candle window against raw 5m rollups. An attainable limit price alone does not
validate its setup's price basis. Unsupported native setup OHLC is excluded;
missing, conflicting or incomplete setup windows remain unscored with explicit
reasons in `strategy_json.entry_validation`. Source loading retains 550 days of
warmup. Current counts and independent reconciliation are in
[realtime verification](../public/reports/reversal-k1-realtime.json) and
[ICT step validation](../public/reports/reversal-ict-validation.json).

Both historical OTE and realtime paper exits start after the first confirmed raw
5m fill candle. The native `observed_at` records when the setup was discovered;
it does not delay exits to a later 1H/30m close. Fresh entry alerts use the raw 5m
fill-observation time and are suppressed when the paper trade has already closed.
