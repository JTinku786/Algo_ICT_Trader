# ICT Smart Money Concepts — Framework Reference

Source: "Trading Framework: ICT Smart Money Concepts" (CandelaCharts, TradingView education post on NAS100, May 2025),
saved by Reddy as ICT_Concepts.pdf on 2026-10-13. Condensed into a structured reference for Titania, with notes on how
each concept is implemented in the Algo ICT Trader codebase (engines under ICT_Automation\trend_reversal_2026 and
Algo_ICT_Trader\scripts\consolidation, scripts\expansion).

## 1. Core premise
- ICT (Michael J. Huddleston): price is algorithmically delivered by an interbank algorithm (IPDA) that seeks liquidity,
  engineers stop runs and delivers price from one draw on liquidity to the next. SMC is the retail interpretation.
- Retail stops and entries are the fuel for institutional orders. Time matters as much as price. Structure is fractal.
- IPDA delivery cycle: Consolidation -> Expansion -> Retracement -> Reversal (and back to consolidation).
- IPDA look-back windows: 20, 40 and 60 trading days. The algorithm reprices to liquidity pools, fills imbalances,
  seeks equal highs/lows and balances buy-side vs sell-side delivery.

## 2. Market structure
- Swing high: a candle high flanked by lower highs on both sides. Swing low: a candle low flanked by higher lows.
  (Codebase: 3-candle swing, high > previous high and >= next high; known only after the next bar closes.)
- Bullish structure = higher highs + higher lows (long bias). Bearish = lower lows + lower highs (short bias).
- BOS (break of structure): price takes a previous swing in the direction of the prevailing trend -> continuation.
- CHoCH (change of character): the first break of a recent swing against the trend -> first reversal signal.
  Bullish CHoCH = in a downtrend, first break of a recent swing high; bearish CHoCH = first break of a swing low in an uptrend.
- Rule: trade in the direction of HTF structure; use LTF structure breaks only to time entries.

## 3. Liquidity
- BSL (buy-side liquidity) rests above swing highs, equal highs, trendline highs, round numbers: short sellers' stops,
  breakout buy stops, institutional sell limits.
- SSL (sell-side liquidity) rests below swing lows, equal lows, trendline lows, round numbers: long stops, breakdown
  sell stops, institutional buy limits.
- EQH / EQL: two or more swing highs (lows) at about the same price. Retail sees resistance/support; smart money sees
  resting liquidity — a magnet.
- Inducement (IDM): a minor swing engineered to pull traders the wrong way; it is taken before the deeper draw.
- Liquidity void: an area price crossed so fast that little trading occurred; price tends to return to fill it.
- Stop hunt / liquidity grab: price reaches a pool, stops trigger, institutions absorb the orders, price reverses toward
  the real target.
- Draw on liquidity (DOL): the target of the current move. Before any trade ask: what liquidity is price drawn to, is the
  pool big enough to justify the move, does the HTF narrative support reaching it?

## 4. Imbalances (full classification)
Imbalances are inefficiencies where one side of the market was not properly represented; algorithms return to balance them.
- Fair Value Gap (FVG): 3-candle gap between candle 1's wick and candle 3's wick. Bullish = BISI, bearish = SIBI.
- Inverse FVG (IFVG): an FVG that price closes through; it flips polarity (bullish FVG closed below -> resistance).
- Liquidity void: a large one-directional, thinly traded range.
- Volume imbalance: gap between consecutive candle bodies (wicks overlap, bodies do not).
- Balanced Price Range (BPR): overlap of a bullish and a bearish FVG — price is "balanced" there.
- Redelivered Rebalanced (RDRB): a price range delivered in both directions and rebalanced.
- Opening gaps: NDOG (new day opening gap) and NWOG (new week opening gap).
- Consequent Encroachment (CE): the 50% of an FVG (or of any range). Key internal reaction level; used for partials or
  to tighten stops.

## 5. Blocks (full classification)
Blocks are candles/zones where institutional orders were placed and may rest again.
- Order Block (OB): the last opposite-colour candle before a displacement. Only valid if the displacement created an
  FVG and a BOS/CHoCH — not every opposing candle is an OB.
- Breaker block: an OB that failed (price closed through it after a liquidity run); it flips to the opposite role.
- Mitigation block: a failed OB without the liquidity run; price returns to it to mitigate losing positions.
- Rejection block: zone defined by long wicks at a swing extreme (from the wick to the body).
- Propulsion block: a candle that trades into an earlier OB and propels price — continuation block.
- Vacuum block: a gap created by a volatility event (news) that price returns to.
- Reclaimed order block: an OB that price returns to and re-uses after it already reacted once.
- IOFED (Institutional Order Flow Entry Drill) / optimal OB: entering on the partial fill of an FVG inside the OB instead
  of waiting for the full OB retest.

## 6. Premium & discount (PD arrays)
- Take any significant swing range; its 50% midpoint is equilibrium (EQ). Above 50% = premium (sell in a bearish
  context); below 50% = discount (buy in a bullish context).
- Fibonacci in ICT is a filter, not support/resistance: OTE = 0.618-0.786 retracement (0.705 sweet spot) — buy discount
  in an uptrend (fib swing low -> high), sell premium in a downtrend (fib swing high -> low).
- Projection targets: standard deviations -0.5 (conservative), -1.0 (equal move), -2.0 (extended), -2.5 (runner).
- PD array matrix, bullish example ranked top to bottom: old highs (BSL pool, draw target) -> bearish breaker ->
  bearish OB -> bearish FVG/SIBI -> equilibrium -> bullish FVG/BISI (entry) -> bullish OB (entry) -> bullish breaker ->
  old lows (SSL pool). Premium arrays: old high/low, rejection block, bearish OB, FVG, liquidity void, bearish breaker,
  bearish mitigation block. Discount arrays: old high/low, rejection block, bullish OB, FVG, liquidity void, bullish
  breaker, bullish mitigation block.

## 7. Kill zones (New York time) & OTE
- Asian 20:00-00:00: usually a range; its high/low is the reference the London session sweeps.
- London open 02:00-05:00: one of the highest-probability windows; often sets the high or low of the day; watch for a
  sweep of the Asian range followed by a reversal.
- New York AM 07:00-10:00: often reverses or extends the London move; NFP/CPI/FOMC land here — avoid 15 min either side
  of high-impact news. Silver Bullet window 09:00-11:00 (NY Silver Bullet 10:00-11:00).
- New York lunch 12:00-13:00: low volume, choppy — do not trade.
- New York PM 13:30-16:00: can give a second directional leg (index futures); lower probability; end-of-day rebalancing.
- OTE entry needs all of: a confirmed HTF draw on liquidity; price in discount (long) / premium (short); a PD array
  (OB/FVG/breaker) at the 0.618-0.786 retracement; entry inside a kill zone; LTF confirmation (CHoCH, displacement or
  OB formation on 1m/5m).
- US-equity note (codebase): regular-session data starts 09:30 ET, so Asian/London kill zones and pre-market models
  cannot be simulated on the equity feeds.

## 8. Power of Three (AMD)
- Accumulation: consolidation, smart money builds positions; retail sees "no trend".
- Manipulation (Judas swing): a false move in the wrong direction to trigger stops — in a bullish day a move below the
  previous low / Asian low, in a bearish day a move above the previous high / Asian high.
- Distribution: the real move, opposite the manipulation, to the draw on liquidity.
- Daily: accumulation = overnight, manipulation = early AM move, distribution = main session trend.
  Intraday 15m: accumulation = before the kill zone, manipulation = false break at the kill-zone open, distribution = the run.

## 9. Trading models (named in the source)
Silver Bullet; 2022 Model (flagship); Unicorn (breaker + FVG overlap); Breaker + FVG; New Day Opening Gap (NDOG);
London Swing; Market Maker Buy/Sell Model (program); OTE Retracement; Turtle Soup (false breakout of an old high/low);
Power of Three Daily (high/low of day formation); Judas Swing. All express the same logic: raid liquidity, create
imbalance, deliver to the next draw. The source lists the models; it does not give step-by-step rules for each.

## 10. Additional concepts
- CBDR (Central Bank Dealers Range) 14:00-20:00 NY: a small CBDR suggests the next day's directional move; its
  standard-deviation projections give targets for the next session.
- FLOUT (failure to launch outside): an attempt to break a CBDR extreme that fails and reverses inside — a trap; expect
  the opposite direction in the next kill zone.
- True Day Open = 00:00 NY. Prior day high/low remain key. A day that opens inside the prior range, expands to one
  extreme and reverses to the other is a classic delivery pattern.
- Time & price: a perfect PD array outside a kill zone means little; TIME (kill zone) + PRICE (PD array) + NARRATIVE
  (HTF direction) is the highest-probability confluence.
- PDH/PDL (previous day high/low) and PWH/PWL (previous week high/low) are liquidity references; the algorithm often
  visits them the next day/week.
- Daily opening price (00:00 NY) and weekly opening price (Sunday 18:00 NY) act as reference S/R; a displacement away
  from the open that leaves an FVG often retraces back toward the open (OTE).

## 11. HTF narrative & multi-timeframe alignment
- Monthly/weekly: macro bias (what is IPDA targeting over the next 20-60 days). Daily: session narrative (bullish or
  bearish candle today?). 4H: intermediate trend. 1H: intraday structure. 15m: entry timeframe and kill-zone moves.
  5m/1m: precision entry (OB, FVG, MSS).
- Top-down: monthly direction (accumulation/markup/distribution/markdown) -> weekly draw (PWH/PWL, weekly OB/FVG) ->
  daily bias (buy day or sell day) -> 4H structure and key levels -> 1H origin zone -> execute 5m/1m inside the kill zone.
- Golden rule: never take a trade that conflicts with the HTF narrative; the LTF is only for timing.

## 12. Risk management (as stated)
Max 1% risk per trade; 3% daily loss limit; 6-10% weekly loss limit; stop beyond structural invalidation (below the OB,
beyond the FVG extreme, beyond the sweep low/high); minimum 2:1 reward-to-risk, models often 3:1 to 10:1; scale out 50% at
the first target (initial draw, 1R or FVG CE) and run the rest; journal every trade.

## 13. Common mistakes
Marking OBs without displacement; ignoring the HTF narrative; trading outside kill zones; chasing entries after price
runs through the OB/FVG; overcomplicating the model; trading the 12:30 lunch window; moving (widening) the stop.

## 14. How this maps to the Algo ICT Trader phase studies (2017-2026, 29 Dow + SPY + QQQ, 1d/1h/30m)
- Reversal tab (reversal_engine.py): external 20/40/60-bar liquidity sweep -> MSS (close through the internal swing);
  OTE 62% / FVG CE / MSS-next-open entries. Tables reversal_*.
- Consolidation tab (scripts/consolidation/consolidation_engine.py): box = >= 8/10/12 bars spanning <= 2-3x ATR20 with
  >= 2 EQH swings and >= 2 EQL swings; sweep = wick or 2B reclaim within 3 bars; break = 3 closes beyond. Findings:
  the first sweep was followed by a same-side break ~62% of the time (sweep usually NOT the reversal); sweep-fade 2R
  +0.12R daily / +0.06R 1H / ~0 30m (tight). HTF bias direction did not behave as ICT predicts on daily.
- Expansion tab (scripts/expansion/expansion_engine.py): displacement = body >= 1.0/1.5x ATR20, >= 60% of range,
  closing through the last swing (BOS); leg origin -> first confirmed swing, >= 2/3x ATR with an FVG; entries FVG CE,
  OTE 70.5%, discount sweep + rejection, chase baseline. Findings: legs that retraced into OTE (>= 62%) failed through
  the origin 51-57% of the time; ~45-55% never retraced to 50%; OTE limit flat/negative on every timeframe; sweep +
  rejection on 30m (strong) +0.13R at 3R, OOS +0.20R, better WITH HTF bias.
- Each engine has an independent validator (validate_*.py) that re-derives every rule from raw bars; results are
  stored in <study>_runs.summary.validation and shown on the tab.
