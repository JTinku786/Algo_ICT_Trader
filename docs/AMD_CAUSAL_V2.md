# AMD causal historical contract — amd-local-v2.1

Status: historical research only. No broker route or production promotion.

## Rule lineage

The sequence is liquidity raid/reclaim → displacement through confirmed structure → fresh three-candle FVG → subsequent retracement. The project framework remains a community reference. For this correction, the original ICT lesson [How To Trade ICT FVGs Correctly, September 16, 2024](https://www.youtube.com/watch?v=HhgWGduQZQY) was inspected through its auto-generated transcript. Around 25:33–26:27 it explains three-candle geometry and the following-candle retracement; around 40:17–41:54 it illustrates a near-edge entry and partial retracements. This verifies those limited concepts, not the entire AMD model or every local rule below.

The following are explicit `LOCAL_ADAPTATION` rules inherited or clarified for this equity study: 2/3 ATR accumulation span, minimum box length, two swings in the outer 20% of the box (liquidity clusters, not strict equal prices), 0.75 ATR displacement, 50% body/range, three-bar reclaim, 0.1/0.4 ATR stop buffers, CE entry, ten-bar expiry, minimum risk percentages and target/hold alternatives. No threshold was optimized on the rebuilt outcomes.

The 09:30 RTH session model is a separately named equity proxy. It does not contain midnight open or overnight accumulation. Do not call 09:30 the ICT true day open or infer missing Asian/London behavior from RTH candles.

## Discovery and entry

1. Freeze accumulation after its minimum completed bars and confirmed swings exist. ATR uses the completed bar before accumulation begins.
2. Require the raid to reclaim. Both-edge ambiguity is rejected. An unreclaimed break is not an AMD trade.
3. A new displacement close must cross a previously confirmed internal swing. The reclaim candle itself is eligible; it is only recognized after that candle completes.
4. At MSS close, choose the latest directional displacement FVG whose CE has not already traded after formation. If none is available, consider the FVG completed by MSS+1. Do not rank candidates by later returns or select a later gap after an already eligible order was chosen.
5. Set decision at the later required confirmation. Activate only on the following eligible source bar, never on an earlier FVG retest. A limit order expires after ten bars counted from activation.
6. Cancel before subsequent entry if the prior completed bar breached the stop or delivered to the opposite accumulation edge. A gap through the stop at a later open cancels the pending limit before an intrabar entry proxy. Conservative OHLC execution is not a guarantee of live cancellation latency.
7. FVG limit target ladders and planned 2R use the planned CE and frozen stop, not a later favorable opening fill. Market-model R brackets use the next open's actual price, an entry-time bracket proxy; they are not falsely represented as prices known at the prior close.
8. The original RETURN_CLOSE is a reference model without MSS; it must not be described as a confirmed MSS entry.

`MSS_FVG_EDGE` is a separate comparison for shallow retracements, not a replacement for CE. It uses the near gap edge with a local $0.01 offset in the trade direction, subject to the same completed MSS/FVG clock, fresh intended entry level, cancellation and expiry. The one-cent offset is not a venue-verified live tick size. Its per-trade FVG evidence is stored independently because it can choose a different fresh gap from CE. Models and targets are alternatives; do not add their overlapping positions together.

## Data and clocks

- AMD uses its own raw daily/30m loader. It does not alter the shared Reversal loader or frozen historical ICT pipelines.
- Daily inputs: candles_1d plus SPY/QQQ historical daily. Intraday: historical 30m before the existing cutoff, current 30m after it, and historical ETF coverage.
- Never clip an intraday candle to the completed day's range. Never invent missing session tails from daily OHLC.
- Quarantine invalid OHLC and conflicting duplicate keys. The inherited >60% close-jump guard truncates that symbol from the observed discontinuity; it does not certify corporate-action correctness.
- Build hourly bars only from all required 30m constituents. Genuine exchange-calendar short final bars remain valid. A missing interval resets detection state at the next observed bar. Positions not resolved before a gap remain open at the boundary, without fabricated exits.
- Use XNYS calendar closes, including holidays, DST and early closes. Session raid candles must be complete by 11:00; reclaim must complete strictly before noon. A coarse candle that straddles the raid deadline cannot establish when its extreme occurred.
- Session ATR and PDH/PDL use only prior completed daily bars with sufficient continuity. Today's daily row and its high/low/close are not prerequisites for discovering today's morning setup.
- Persist decision_known_at, mss_known_at, fvg_known_at, order_active_at, entry_not_before and exit_known_at. Bar labels remain separate. These are historical completed-bar availability bounds, not observed live scanner detection times or broker fills. Adjacent bar close/open boundaries may share a timestamp; the entry uses a subsequent bar. Subsecond ordering/latency is unproven from OHLC.

## Exit and publication

- Stop wins an ambiguous same-bar stop/target conflict; no target win is credited on a limit fill candle. Gap stops/targets retain the simulator's disclosed convention.
- Partial/gapped session tails remain open if no earlier stop/target resolved the position. An unresolved simulated position is not an executable carry instruction.
- Every new run has a unique identity, source/data fingerprints and a validation result. The API requires the corrected spec and refuses rows violating causal prerequisites. Old and intermediate runs remain audit history, outside accepted results.
- Statistics use closed risk-eligible rows. Lists can also show open rows. Profitable percentage counts positive R, including profitable timeouts. Costs are sensitivity assumptions, not measured execution costs.
- Historical outcome filters are explicitly hindsight diagnostics and must never enter trade selection. The fixed 2022 split is retrospective, not certified walk-forward evaluation. CSV downloads explicitly state that they contain displayed rows.
- AMD charts use the raw AMD source contract, not the repaired Reversal chart endpoint.

## Tests and remaining boundary

Regression tests cover pre-MSS fills, prior CE mitigation, fresh MSS+1 recovery, first subsequent touch, cancellation, short symmetry, raw gaps, early closes, and independence from today's daily values. Real-candle prefix and future-mutation checks compare recorded decisions before a cutoff. Chart parity checks compare actual HTTP chart output with the raw loader, including an early-close day.

Full stored-row timing/geometry checks and every FVG's raw geometry/first eligible touch are required. Exit replay is separately sampled and labelled. These finite checks do not establish live first discovery, vendor data publication latency, a complete ICT specification, portfolio profitability or readiness for live orders. Any later live route needs its own chronological shadow/paper evidence and broker reconciliation.
