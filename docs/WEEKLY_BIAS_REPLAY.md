# Previous-week ICT replay

Open Daily Bias → Previous week. Default AAPL replay starts before the 2026-01-06 candle. Select a source timeframe; Next/Previous reveal or rewind one completed native candle. Play/Pause and timeline share the same cutoff with the weekly chart. Reset applies the chosen date. The default view shows 20 daily/intraday candles and 14 weekly candles. Native Lightweight Charts (the same engine as Reversal) supports drag, scroll zoom, +/− and Reset view. White background, green/black candles and two clear weekly levels are the default. Zones and equilibrium are opt-in. Click a candle to select its daily explanation; detailed evidence and the 40-row daily table are collapsed by default. Each chart shows two recent active events per enabled category plus any selected event as thin edges, with no stacked fills. A zone browser lists every retained event in enabled categories, including historical events; counts disclose drawn versus retained events. Detection remains bounded to 240 candles per frame.

## Evidence and local adaptations

All annotations below are LOCAL_ADAPTATION rules, derived from native candles. They are explanatory candidates, not complete ICT entry approval, and do not change the existing FVG entry simulation or table statistics. Stored latest ict_* snapshots are deliberately excluded from historical replay because their historical known-at/status contract was not established.

- Previous week: exact prior Monday–Sunday from observed native daily sessions. High/low and midpoint roll automatically. Invalid daily weeks fail closed; missing exchange-calendar sessions cannot be conclusively detected without an authoritative calendar. Holidays remain observed sessions, never fabricated bars.
- Chart narrative: weekly close breakout → continuation toward latest daily extreme; one-sided weekly rejection → opposite weekly extreme; both-sided rejected sweep → neutral. Carry an unmet draw within the same reference week; reaching it without a new event clears it. A new reference week resets direction. This explanatory carry model is explicitly different from independently scored daily table signals.
- Displayed swing highs/lows and daily HH/LL: strict three-candle pivots, one completed candle on each side; known after the right candle closes. Consolidate consecutive same-type pivots by retaining the more extreme high/low, following the SMC source cleanup approach. The latest endpoint can update when a more extreme same-type pivot becomes confirmed, until the opposite swing is confirmed. No first/last endpoint is fabricated. Outside candles satisfying both pivot tests are omitted because OHLC does not establish intrabar price order. Intraday detection skips gaps; weekly detection requires adjacent calendar weeks. Three-bar blue ticks and High/Low labels are displayed. HH/LL uses only swings known before the selected daily session.
- The pre-existing advanced OB/BOS/equal-liquidity candidate detector retains its documented five-bar pivot model and datapoints; its optional pools are distinct from the cleaned three-bar display path. Daily reason swing-pool hunting/generation uses the three-bar path, while optional EQH/EQL evidence retains the existing equal-level detector. Backtest rules are unchanged.
- Primary implementation reference for consolidation: https://github.com/joshyattridge/smart-money-concepts/blob/master/smartmoneyconcepts/smc.py (`swing_highs_lows`). This is a causal local adaptation, not a call to the retrospective library; library endpoint synthesis is not copied.
- FVG: three consecutive bars, no overlap between first and third wicks, directional middle candle. Known at third close. IFVG: subsequent close through original FVG. Invalidation is not backdated.
- OB candidate: last opposite candle within six bars before a confirmed swing close-break; break body ≥ prior 14-bar ATR. Full wick zone. Breaker candidate: subsequent close through that OB. These simplified candidates do not implement a complete breaker or order-block checklist.
- Equal highs/lows: two confirmed, interveningly unswept pivots within 0.1 prior ATR, min price × 0.00001 tolerance. Swing lines are BSL/SSL. Close-through marks BOS/CHOCH relative to last observed break direction.
- Zone touch counts only start after detection. Chart zones begin at known-at, although selected evidence records the original candle. Detection is bounded to 240 source candles per timeframe.
- Weekly candles aggregate native daily OHLC from 2023 onward. Only weeks before the current replay week appear; the forming week is withheld. Weekly zones use the same causal candidate detector on completed weeks. Current candle overlap with an already-known weekly zone is shown separately from completed-week touch history.

## Daily reason categories

These labels describe observed evidence, not proven algorithmic intent. Several may apply; no matching rule produces `No qualifying event`.

| Category | Mechanical evidence |
| --- | --- |
| Hunt Liquidity | Daily high/low touches a previously known unswept swing/equal pool, or exceeds PWH/PWL |
| Rebalanced inefficiencies | Daily range overlaps an existing active FVG/IFVG; overlap does not imply full fill |
| generate liquidity | A swing/equal pair becomes confirmed on this day's close; original pivot date remains in event evidence |
| rebalance equilibrium | Daily range crosses the previous completed week's 50% midpoint |

## Verification

Run `node scripts/test-weekly-replay.cjs`, `npx.cmd tsc --noEmit`, and targeted ESLint. The script tests causal future invariance, FVG/IFVG detection, delayed pivot confirmation, invalid-week rejection, weekly aggregation/rollover, neutral visibility, daily reasons, and live API behavior across all five native frames.

Native AAPL Jan 6 reference: PWH 277.8399963378906, PWL 269, observed Dec 29–Jan 2 four sessions. Jan 12 reference: PWH 271.510009765625, PWL 255.6999969482422. January 6 daily/hourly exist; 30m/15m/5m begin Jan 21 in this stored dataset. SPY/QQQ have no candles in this snapshot; the UI reports no data. Read-only transactions exclude conflicting/invalid OHLC rows and expose audit counts. End cutoff excludes today's unfinished daily session.

`output/daily-bias/weekly-replay-aapl-jan06.json` contains the Jan 6 causal snapshot and reason evidence. Browser checks cover the Jan 6 step, Jan 12 rollover, timeline/frame switches, overlay selection/toggles, playback/rewind/reset, and no-data behavior.
