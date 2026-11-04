# Top Down Analysis

The new main navigation tab defaults to AAPL, 2026-01-06 at the daily close.

Source: Month 02 October study notes page 84 lists monthly, weekly, daily top down analysis. Page 25 describes refining higher timeframe setups; pages 80-86 place this in broader macro, COT, sentiment and correlation context. Month 01 provides the reference point categories. The private PDF is not served by the application.

## Behavior

- One daily-close cursor limits every panel to completed bars.
- Monthly and weekly aggregate the available native daily rows and exclude the forming calendar period. Invalid source periods are excluded. Full exchange-calendar completeness is not certified.
- Daily and selected 1h/30m/15m/5m candles retain valid neutral sessions and source prices.
- Monthly/weekly highs, lows and equilibrium project into daily and lower charts after confirmation.
- Confirmed three-candle swing paths compare the last two highs and lows. Only three BUY or three SELL structure results produce an alignment label; mixed/unknown does not.
- Existing local FVG/IFVG/OB/breaker and liquidity detectors are reused on each completed prefix. Monthly detectors require adjacent calendar months.
- Charts contain no text annotations. Price/time axes and OHLC readouts remain; explanations and zone inspection stay below each chart.
- Fibonacci range and OTE controls remain independent, off by default, indicator only.
- Macro/COT/sentiment/intermarket inputs are explicitly unavailable. Equity use is an adaptation, not a source-validated strategy.
- No entries, stops, targets, orders or backtest performance are fabricated.

## Validation

`node scripts/test-top-down.cjs`, existing weekly replay and daily context regressions, TypeScript, targeted ESLint, browser AAPL Jan6/Jan7 rewind and 5m coverage check.

## Wick rejection highlights

Weekly and monthly charts now have a default-on, independent wick rejection layer, shaded brown with explanations below. Candidates require a confirmed three-bar swing, a wick at least 25% of the source candle range and at least as large as its body, and a completed close beyond the source candle within three subsequent bars. Departure must be at least 0.5 prior ATR from the source body edge, with eight preceding candles available. These explicit local thresholds approximate the supplied illustration; they are not asserted to be ICT's published numerical rules.

Zone bounds are the body edge to the wick extreme. Availability begins at the later departure-confirmation close, never the source candle. Return visits start afterwards; consecutive intersecting bars count as one visit. A close beyond the adverse wick extreme invalidates the candidate. Four most recent unbroken candidates are shaded; all retained candidates and invalidations remain in the explanation. No wick text label is added inside the canvas. The forming week/month remains excluded.

Validation: `node scripts/test-wick-rejections.cjs`, TypeScript, targeted ESLint, and browser AAPL monthly/weekly toggle and rendering checks.

## Intraday playback and S16-V2

Play/Pause, single-bar stepping, speed, completed-candle time selection, end-date bounds and a seek slider use native 5m/15m/30m/1h histories. Changing the frame retains the replay clock; each panel filters `knownAt <= cutoff`. Date selection starts at the first stored completed bar of that date; absent intervals are disclosed and not fabricated. Daily explanation uses the last completed daily candle, never the selected day's eventual OHLC before its close.

S16-V2 records are read from the latest published run containing the instrument, scoped to 2026. Orders join setups for the original decision timestamp and PD array. Run/spec lineage is displayed. Placement arrows appear only after decision and placement are known. Fill arrows require a later recorded fill and a revealed containing candle. Equal or earlier fill/decision timestamps are flagged as timing-unverified and withheld; this is not a full strategy invalidation verdict. Final cancellation status has no causal timestamp in this contract and is not portrayed as an as-of pending/cancelled state. Recorded outcomes are omitted; planned targets may be inspected after placement.

This is replay of published historical records, not recomputation of S16 signals, full signal validation, or live broker execution. Currently only BUY records are enabled. The S16 model is independent of local chart candidate detectors.

Validation: pure event-gating tests; monthly aggregation regressions; TypeScript and targeted ESLint; browser Play/Pause, Feb3 AAPL 5m at 11:20 versus 11:35, placement/fill markers and completed higher timeframe cutoffs. First sample: setup `992e6634ce8b43897b829f94`, decision/placement 2026-02-03 16:20 UTC, historical fill 16:30 UTC at 268.595; marker becomes visible on completed 16:30–16:35 bar.
