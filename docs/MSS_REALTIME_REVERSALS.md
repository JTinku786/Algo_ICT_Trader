# Realtime MSS reversals

The Realtime Orders tab now includes an isolated paper lane using the exact Market Structure Shift engine. Click **View last-month MSS reversals**, then **Run**. This selects September 6–October 5, 2026, all markets, and the Paper Trading strategy `MSS-REVERSAL-D1-M5-CLOSE`.

The **Reversal** tab's realtime view now uses the user's corrected **k1_reclaim3** detector, documented in [Reversal k1 realtime](REVERSAL_K1_REALTIME.md). The MSS rows described here remain available in Realtime Orders for research. The prior MSS scheduled scan is disabled; daily alerts now use k1_reclaim3. **MSS signals** retains the latest manual investigation, and **Historical study** retains its historical reversal detector.

## Detection and execution contract

- Daily HTF → 5-minute execution, native SMC CHOCH close break.
- Sweep reversal playbook requires the sweep and a usable liquidity target; existing OB, breaker, FVG, IFVG and BPR arrays are eligible. First retest, edge entry, all sessions and both directions.
- Target/stop use the existing dashboard structural plan. Every array/risk-plan combination is a separate setup. Several may share an entry time. The aggregate is a setup investigation, not an independently allocated portfolio.
- A completed retest candle is observed at its `knownAt`; the stored entry time is its opening timestamp. This is OHLC paper evidence, not a broker-confirmed fill.
- Outcomes start on later candles, continue beyond the investigation end date, and use the first stop/target hit. A candle touching both uses stop first. Entries still awaiting either level remain open.
- Full native proof, selected filters, HTF contexts, engine hash, source coverage and outcome candle are retained. Identical signal hashes are idempotent.

## Runtime

Canonical scripts: `C:\Users\saite\Desktop\ICT_Automation\realtime_execution\mss_reversals.py`, `mss_reversal_data.py`, `mss_refresh_us.py`, and `mss_reversal_schema.sql`.

Windows Scheduled Task `ICT-MSS-Reversal-5m` invokes Python directly every five minutes. US scans are gated to weekdays 09:30–16:10 New York; forex to Sunday 17:00–Friday 17:00. The computer must be awake and the user session available. Overlapping jobs are skipped with both Task Scheduler and a PostgreSQL advisory lock.

The Codex automation **MSS reversal daily Discord and Slack summary** runs at 17:10 New York. The native dispatcher also checks for the daily summary after 17:10; its database delivery key prevents duplicate summaries.

New signals must be observed within 15 minutes, and stale feeds fail closed. Existing candle ingestion is preferred; the scanner refreshes US and currency-pair Yahoo 5-minute OHLC into the isolated supplement table, never by replacing historical source tables. Currency pairs map to their matching `PAIR=X` symbol; metals are not substituted with futures. Daily supplementation requires complete regular sessions; partial sessions are excluded. Metals with unavailable data are skipped.

## Delivery and audit

Discord and Slack use existing configured destinations. BACKFILL never sends entry/exit alerts. REALTIME sends fresh signals and paper exit events; summaries distinguish backfill from realtime. Each destination has a durable delivery key and safe receipt. Unknown transport outcomes or interrupted SENDING records require reconciliation rather than blind resend.

Tables are `realtime_production_mss_reversal_{candles,orders,events,alerts,runs}`. The paper execution constraint prevents this lane from representing broker execution. Existing broker lanes and frozen original backtests are untouched. Superseded preliminary backfills retain their original evidence and are excluded from dashboard counts.

Latest complete coverage/counts and accepted delivery receipts: [rollout evidence](../public/reports/mss-realtime-rollout.json). Runtime logs: `realtime_execution/logs/mss-reversals-cron.log`. Scan reports: `realtime_execution/artifacts/mss_reversals/`.

## Commands

From the canonical `realtime_execution` directory, with the existing Python 3.10 runtime:

```powershell
python mss_reversals.py backfill --start 2026-09-06 --end 2026-10-05 --markets us,forex --workers 4 --refresh-us
python mss_reversals.py dispatch
python mss_reversals.py digest
python mss_verify_rollout.py
Get-ScheduledTaskInfo -TaskName ICT-MSS-Reversal-5m
```

The historical report's PARTIAL status means the two metal feeds had no usable requested-month data; the 31 US symbols and 12 currency pairs completed without scan errors. CAT produced no qualifying setup. Realtime PARTIAL also reports stale feeds individually; it does not authorize alerts from old candles.

## Verified rollout on October 6, 2026

- Historical window: 11,336 setups, 10,617 closed, 719 open through available completed candles, including October 6 outcomes. These counts include distinct overlapping array/risk plans.
- US: 2,599 setups. Forex: 8,737 setups. Six superseded preliminary AAPL records are retained but excluded.
- Scheduler completed successfully (`LastTaskResult=0`); latest refreshed scan took 44.3 seconds.
- Three fresh USDJPY paper signals were accepted by both Discord and Slack. The daily summary was accepted by both, and subsequent summary checks were deduplicated.
- No premature entry observation, premature exit, out-of-window historical entry, missing closed-order evidence, or invalid exit-price/outcome was found. Twenty independent first-hit samples passed.
- Website count equals the database's active historical count. SPY chart returned 156 candles; its filtered API and CSV both returned 56 rows, each retaining full strategy JSON. TypeScript, targeted ESLint, and Python compilation passed.
