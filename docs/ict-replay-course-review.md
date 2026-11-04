# ICT replay course review

The replay tools use six categories: Macro Bias & Range Matrix; Institutional PD Arrays; Liquidity Pools & Stop Hunt Dynamics; Market Structure & Intermarket Analysis; Time, Killzones & Execution Filters; UI Controls & Chart Maintenance. Focus buttons open relevant groups without changing selections. Unsupported concepts are listed as coverage gaps rather than working detectors.

## Source and review method

Source: the user's `Downloads/All Core Content Months/All Core Content Months` folder, twelve monthly PDFs. All 1,246 unique pages have native extraction and full-page OCR coverage, checked against the source inventory. Page numbers below are PDF page numbers, including disclosure/title pages. Native text extraction alone misses much of the rasterized slide text. The review therefore combines full-page OCR, native text, a topic index, and visual inspection of selected critical pages. OCR is a discovery aid, not an executable strategy specification. Extracted transcripts remain in local temporary review files; the course is not copied into public application assets. The machine-readable topic index is `src/app/data/ict-replay-course-coverage.json` and is included in decision exports.

| Month | Pages | Main coverage |
|---|---:|---|
| 01 | 32 | Price delivery states, liquidity, equilibrium and imbalances |
| 02 | 121 | Risk, drawdown, low-risk/high-reward and top-down perspectives |
| 03 | 71 | Timeframe/model selection, sponsorship and SMT |
| 04 | 105 | Internal/external liquidity, blocks, voids, FVGs and raids |
| 05 | 147 | Position trading, IPDA, macro analysis and management |
| 06 | 92 | Swing trading, MWD nesting, failure and management |
| 07 | 133 | Short-term trading and weekly range/profile context |
| 08 | 85 | Day trading, session ranges and projections |
| 09 | 106 | Scalping, market maker models and intraday confluence |
| 10 | 201 | Commodities, bonds, indices, equities and asset-specific analysis |
| 11 | 52 | Longer-horizon mega-trade frameworks |
| 12 | 101 | Integrated top-down framework and practical model templates |

## Course-backed additions and boundaries

| Concept | Evidence | Replay treatment |
|---|---|---|
| Internal/external range liquidity | Month 04 p19; Month 12 p97–98 | Working optional boundary overlay and exported internal candidates. Basis is a completed reference range, not a certified active dealing range. |
| Delivery states | Month 01 p6–16 | Classifier pending. A trend or BOS label alone does not establish consolidation/expansion/retracement/reversal. |
| Orderblock validation | Month 04 p20 | Current mechanical candidates must remain labeled candidates; course validation requires reaction and structural context. |
| Mitigation and breaker sequencing | Month 04 p29–32, p51–53 | Mitigation detector pending; breakers retain explicit sweep-before-break timing and limitations. |
| Rejection blocks | Month 04 p60–70 | Wick highlights are local approximations; not certified rejection-block signals. |
| Vacuum blocks | Month 04 p71–75 | Add to PD coverage backlog. Event-driven discontinuities need source/event context; do not relabel every FVG as a vacuum block. |
| Liquidity voids and FVGs | Month 04 p76–95 | FVG candidates available; certified void classification pending. |
| IPDA lookbacks | Month 05 p30–42; Month 06 p68 | Existing 20/40/60-session references are observations, not a guarantee of institutional delivery. |
| Swing failure protocol | Month 06 p29, p33 | Reassess premise and a new array; reduced subsequent size is a planning rule, not automatic loss recovery. |
| Swing trade management | Month 06 p71–72 | Milestones need an explicit objective, partial-fill accounting and stop policy. The source contains quarter-objective profit-taking and one-third stop language; resolve their sequencing explicitly before automating management. |
| Weekly profiles | Month 07 p23–36, p122; Month 12 p51, p85–96 | Template classifier pending; developing profiles cannot use the eventual weekly high/low. |
| Power of 3 | Month 07 p121 | Model classifier pending; do not infer a complete sequence from a single sweep. |
| Midnight open | Month 08 p20, p76; Month 09 p25–28 | Separate opening-price overlay pending; source session and timezone must be explicit. |
| CBDR, Asian range, FLOUT | Month 08 p33–43; Month 12 p69–71 | Pending session-completeness and market-specific implementations. Regular-session US data cannot supply overnight FX-style ranges. |
| ADR | Month 12 p74 | Pending five-day range context. Projections are conditional, not guaranteed extremes. |
| IPDA True Day | Month 12 p67–68 | Distinct from midnight open. Existing session windows are timing references, not entry confirmation. |
| Macro and intermarket context | Month 12 p13–19, p31, p49, p83–84; Month 10 | Seasonality, quarterly timing, interest rates, COT, open interest and relative strength require aligned external data. |

Silver Bullet, propulsion blocks and volume-imbalance terminology require separate verified source coverage. A text-search miss is not proof that a concept is absent from every diagram. IFVG is an application mechanic and should not be presented as a verified rule of this supplied course without a specific source.

## Decision workflow

Use premise → range/array → reaction → entry trigger → invalidation → opposing objective → risk → management. Allow a neutral/unavailable premise (Month 12 p84). Distance to the nearest array is not proof that it drives order flow. Draw on Liquidity currently groups reference visibility; it does not certify the primary objective. Checkbox count must not become an invented confidence score.

The course's swing progression uses Monthly → Weekly → Daily → 4H. The separate Swing view contains 4H; the Backtest playground currently has Monthly, Weekly, Daily, 1H, 30m, 15m and 5m. Treat missing 4H in that playground as an explicit coverage gap, not an equivalent substitution.

## ML and LLM data contract

`Export decision snapshot · JSON` produces `ict-replay-decision-v1` locally. It includes the replay clock, source provenance, completed candles, array/reference candidates, structure, rolling-80 range, independent selected price ranges, nearest arrays, Fibonacci, liquidity sweeps, session windows, IPDA and paper position results.

- Every predictor must have `knownAt <= replayClock`; use completion time, not the candle's opening timestamp.
- Keep predictor context separate from paper outcomes and original trade metadata. Selected historical trades create selection bias; this export is not an unbiased training population.
- Visibility choices do not define detector availability. Preserve missing/unsupported/partial coverage, rather than imputing a false zero.
- Join asset-specific comparison series as of the clock, with timezone/session/source metadata. Do not fabricate SMT from one ticker.
- Paper results use completed 5-minute OHLC, adverse opening gaps for stops, and stop-first ordering when both stop and target occur in one bar. Intrabar path is unresolved; costs are excluded.
- No model training, predictive accuracy, automatic strategy certification or broker execution is implied by the export.

## Validation

TypeScript and focused lint checks passed. Existing regression checks passed for nearest-array causality, paper exits/rewind/gaps, rolling-80 range with 2% padding, synchronized crosshair boundaries, completed intraday aggregation, DST-aware timing windows and liquidity-sweep ordering. Initial browser verification confirmed grouped controls and a downloaded causal snapshot. A later browser reconnection was unavailable, so the final added range-liquidity checkbox and expanded export fields still need a fresh browser check.
