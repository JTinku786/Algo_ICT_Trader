# Daily context and chart indicators

Implemented October 1, 2026. Available in Daily Bias and ICT Core > Daily context. Paired daily/weekly replay also plots daily explanation references by default.

## Daily observations

Select EURUSD, AAPL, AXP, Nifty, BankNifty, SPY, QQQ, RELIANCE or TCS, date window and a completed daily candle. All available valid sessions remain selectable, including neutral/unclassified days. Missing source data is disclosed. Invalid source dates and audit counts are shown; exchange-calendar completeness is not proven by the source loader.

Four independent conditions appear with evidence; primary-label priority is Reversal, Expansion, Retracement, Consolidation, otherwise unclassified. These are explicit local adaptations of Month 1 concepts, not a finalized source-certified strategy or observed institutional intent:

- Expansion: body >= prior ATR14 and directional close beyond previous bar wick range.
- Retracement: body opposite the preceding three-bar close movement and close inside the previous bar range.
- Reversal: body opposite prior three-bar close movement, plus close through opposite previous-bar extreme or a previous-bar sweep/rejection with a close beyond the previous close.
- Consolidation: four-bar range <= 2 times prior ATR14 and open-to-close efficiency <= 0.35.
- Insufficient or invalid baseline => UNKNOWN. Label is known at the observed bar close; it does not predict or approve the next-day entry.

Completed-week charts use the same mechanical conditions on completed weekly bars, with bar-relative language. The forming week remains withheld.

## Price references

Daily reference groups: existing replay OB candidates; FVG/IFVG; separate liquidity-void candidates; prior-day/week and unswept confirmed swing/equal liquidity references; named prior-day/week equilibrium.

Price evidence shows origin, known-at, prior availability versus newly confirmed at current close, partial overlap or full interval coverage. Current-day touch cannot approve an entry earlier in that day. Default chart references are touched levels, new structures, prior-day/week highs/lows, latest clean high/low pools and named equilibrium; other untouched references remain in the tables. Default explanation levels are independent of optional historical ICT layers.

Chart labels include old highs/buy stops, old lows/sell stops, clean high/low pools, three-bar swings, stop-run candidate arrows, order blocks, FVG, void candidates and equilibrium. Pending stops/open float cannot be verified from OHLC; these are conceptual reference labels. Three-bar pivots depend on neighboring highs/lows, not candle body colour. Displayed alternating path can update its last endpoint after a new confirmed same-type extreme.

Liquidity void is distinct from FVG: one to three same-direction bodies, net first-open to last-close displacement >= 2 times ATR14 known before impulse, and net/range >= 0.8. Largest eligible same-end impulse is retained. Bounds span first open to last close. Invalid baseline or impulse data rejects the candidate. Subsequent candle-range intersections accumulate; full union coverage marks filled on that day's close, and retires it on following days. Candle data cannot establish actual thin trading. Search window is 60 bars; existing OB/FVG detector window is 240 bars.

## Visuals

Framework label appears inside the white native chart. References use thin edges, soft OB/FVG/void areas and short on-chart names, with full terminology in the reference list. Shaded areas begin at confirmation, not at an earlier origin. Newly confirmed single-point structures appear at their close. Overlays use native time/price coordinates and track pan, zoom, resize and crosshair interaction.

## Fibonacci

Each chart has separate Fibonacci range and Fib retracement / OTE checkboxes. Default off. Range anchors at latest causally confirmed three-bar swing and runs to the extreme observed since that pivot through the current replay candle. A LOW anchors an upward leg and running high; a HIGH anchors a downward leg and running low. The anchor may update when a new swing is confirmed.

0/50/100 percent range with Premium/Discount shading; 62/70.5/79 percent retracement levels and OTE band. Bullish retracement measures downward from running high, bearish upward from running low. Equilibrium is the midpoint of this explicitly named running range; it differs from prior-day/week equilibrium. An indicator is not validated OTE execution. No confirmed swing or invalid data in the leg => no fabricated Fibonacci. Rewinding recomputes on the revealed prefix.

## Verification

TypeScript, targeted ESLint, existing weekly replay regression and scripts/test-daily-context.cjs. New fixtures cover the four classifications, insufficient/invalid context, strict equal touches, confirmation timing, future invariance, one-bar sharp-run creation, partial/complete accumulated void rebalance and retirement, Fibonacci dynamic extrema and rewind.

Browser verification: AAPL January 6/7 selection and rewind; Nifty January 6 context; honest SPY no-data; paired daily/weekly labels and default reference plots; Fibonacci and OTE on both native charts; no captured console errors. Artifacts: output/core-content/daily-weekly-labels-fibonacci.png.
