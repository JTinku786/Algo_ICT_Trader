# ICT Core Content: chapter implementation plan

Prepared 2026-09-30. Scope: website and integration roadmap; no trading or deployment changes performed.

## Outcome

Build one connected workspace where a user can learn a concept, see exactly when it becomes known in candle replay, inspect the setup checklist, run the same rules in research, and follow an approved strategy through monitoring. Each trade must explain its source rules, context, entry, invalidation, target and outcome. A concept label alone must never approve an entry.

## Source coverage and evidence boundary

Inventoried 12 PDFs, 1,246 physical pages. Extracted available text from every page and reviewed representative rendered pages across the collection. This is a first-pass curriculum and architecture map, not a claim that every chart or condition has been fully interpreted. Many later slides have chart/text images that extraction misses. Each chapter begins with full visual review of its source pages before its detector specification is finalized.

PDFs stay in the supplied local folder. Build original explanations and our own native-candle charts in the website; source links identify month, physical PDF page and hash. Do not put copies of the PDFs or extracted slide text in public website assets. The notes are evidence to interpret, not operational instructions or automatic authority to place trades.

`ICT_CORE_CHAPTER_REGISTRY.json` contains proposed implementation chapters and verified first-pass page anchors. These are engineering work units, not a claimed official table of contents. `output/core-content/manifest.json` records exact paths, page counts and SHA-256 hashes; local extraction and contact sheets are supporting research artifacts.

## Reuse and ownership

| Capability | Evidence inspected now | Action and canonical owner |
| --- | --- | --- |
| Charts and replay | `reversal-chart.tsx`, `weekly-replay-chart.tsx`, `weekly-bias-replay.tsx` | Retain native Lightweight Charts interaction; standardize one rendering contract in Algo_ICT_Trader. |
| Daily/weekly bias | `daily-bias.ts`, `weekly-replay.ts`, existing replay documentation | Validate and reconcile table scoring versus explanatory carry rules; do not silently merge different models. |
| Sessions | `ict-sessions.ts` | Retain timezone machinery; validate source-specific windows and market adapters. Existing Silver Bullet/macros are separate extensions. |
| Strategy creation | `sict-strategy-builder.tsx`, `strategy-workspace.tsx` | Modernize to consume versioned chapter rules and full strategy checklists, preserving existing contracts. |
| Backtesting | Website backtest API/UI; Automation backtest runner files present | Execution/research runner belongs in ICT_Automation; UI schedules or reads run artifacts through explicit APIs. Runtime and parity still need audit. |
| Monitoring and broker truth | Live/realtime/account UI and `scripts/broker_sync` present | Retain reconciliation interfaces; audit actual order transitions and fills before integration. Broker scripts present do not prove live readiness. |
| ML | Website ML UI; ICT_DataScience training/research artifacts present | Dataset/features/models belong in ICT_DataScience. Audit provenance and causal inputs; ML follows rule validation. |
| Historical concepts | `historical-ict/route.ts` reads historical execution table | Map stored events to original rule versions and known-at timestamps; latest snapshots cannot prove historical availability. |

Local code and file presence were inspected. Database completeness, current broker state, cron operation, model quality and live profitability were not re-audited for this plan. The older six-month roadmap contains dated operational metrics; do not use them as current acceptance evidence.

## Website experience

Add an **ICT Core** workspace with Month -> Chapter navigation and five views: Learn, Replay, Checklist, Research, Integration. Use the same symbol, date, timezone and replay cursor across all views. Existing Daily Bias, Reversal, Builder, Backtest, ML and Monitoring remain reachable through context-preserving links.

- Learn: short original explanation, a simple drawing, prerequisites, applicable market/timeframe and source-page reference. Distinguish a source rule from our chosen mechanical adaptation.
- Replay: daily and weekly charts side by side; switch the execution pane among 1h/30m/15m/5m. Reveal completed candles only, rewind safely, and select a candle for its explanation. Monthly/4H are added once their aggregation contracts are validated.
- Checklist: PASS / FAIL / UNKNOWN / NOT_APPLICABLE per condition, with observed value, required value, originating candle, known-at time and rule version. UNKNOWN never acts as PASS.
- Research: concept occurrence counts and setup/entry counts separately; all neutral, missing, rejected and unresolved cases remain inspectable. Link each result to replay at that cutoff.
- Integration: show which strategies consume the concept and separate Learn, Replay, Detector, Backtest, Paper and Live readiness. One green chapter badge cannot imply live readiness.

Keep the chart easy to read: green/black price candles, thin levels, short labels and a plain-language sentence below the selected candle. For example: "Price took yesterday's low and returned inside the range. The checklist is waiting for confirmation." Do not imply that we observe institutional intent directly.

## First delivery: fix the current foundation

1. Remove the silent three-zone total cap. Use a visible layer manager grouped by timeframe/type, relevance controls and an explicit count of hidden/off-screen/historical zones. FVG, OB, breaker and IFVG must be individually discoverable; selecting one focuses its originating candles and bounds. Preserve a simple default view rather than drawing every historical zone at once.
2. Keep every valid completed candle, including NEUTRAL. Add visible neutral annotations and an all-days evidence view. Distinguish market holiday, missing data, invalid candle and unrevealed candle. Never fabricate a candle to fill a gap.
3. Separate confirmed raw three-bar pivots from the alternating display path. Show the confirmation time and disclose that the most recent display endpoint can update. HH/HL/LH/LL must reference immutable confirmed events available at the decision cutoff.
4. Label existing OB/breaker and bias heuristics as local candidates until audited. Preserve existing strategy/backtest versions while replacing or adding rules.
5. Establish one replay/event contract and golden native-candle cases, starting with AAPL around Jan 6 and the prior user-reported discrepancies. Re-read current candle values rather than relying on chat numbers.

Acceptance: neutral days can be selected, each of the four zone types can be located if detected, absence is explained, weekly levels roll at the correct time, and appending future candles does not change any event that was already known at the tested cutoff.

## Chapter implementation sequence

Follow the source learning sequence. Risk controls and event infrastructure begin immediately; cross-asset modules can wait for their data adapters without blocking candle-only learning. Page references below are source anchors, not exhaustive chapter ranges.

### Month 01: Foundations

Source: 32 pages.

- **CC-M01-C01: Price delivery and the four market conditions.** Start from PDF pages 4, 6, 9, 11, 13, 15.
- **CC-M01-C02: Liquidity, three-bar swings and equilibrium.** Start from PDF pages 17, 20, 24.
- **CC-M01-C03: Fair valuation and replay practice.** Start from PDF pages 28, 32.

Deliver market-condition explanations, three-bar swings, liquidity levels, equilibrium and original replay exercises. Acceptance includes bullish, bearish, neutral, equal-price and ambiguous outside-bar examples.

### Month 02: Risk and trade framing

Source: 121 pages.

- **CC-M02-C01: Reward, drawdown and expectancy.** Start from PDF pages 4, 8, 10.
- **CC-M02-C02: HTF location and LTF risk refinement.** Start from PDF pages 25, 38, 44.
- **CC-M02-C03: Stops, loss recovery and position sizing.** Start from PDF pages 54, 57, 63, 65, 73.

Deliver position sizing, cost-aware R, drawdown, partial exits and explicit stop/invalidation policies. Source performance illustrations are examples, never promised returns. Validate losing streaks, invalid stops and insufficient buying power.

### Month 03: Market structure and institutional context

Source: 71 pages.

- **CC-M03-C01: Monthly to weekly to daily structure.** Start from PDF pages 4, 12.
- **CC-M03-C02: Institutional sponsorship and lower-frame inspection.** Start from PDF pages 49, 51.
- **CC-M03-C03: SMT and retail-pattern context.** Start from PDF pages 55, 58, 64, 68.

Deliver structural hierarchy and HTF/LTF context. SMT needs synchronized related instruments and their availability times; absent comparison data must be UNKNOWN. Candle-only structure can ship first.

### Month 04: Liquidity and PD-array definitions

Source: 105 pages.

- **CC-M04-C01: Interest-rate triad and intermarket confirmation.** Start from PDF pages 4, 6, 18.
- **CC-M04-C02: Internal/external liquidity and bullish order blocks.** Start from PDF pages 19, 20.
- **CC-M04-C03: Bias, breakers, rejection and liquidity voids.** Start from PDF pages 27, 53, 66, 79.

Audit full source checklists for OB, breaker, mitigation/rejection blocks, FVG and liquidity voids. Keep each distinct; an OB that closes through its boundary is not automatically a fully validated breaker. Validate origin, eligibility, bounds, confirmation, retest and invalidation separately.

### Month 05: Long-term analysis

Source: 147 pages.

- **CC-M05-C01: Quarterly shifts and anchored IPDA ranges.** Start from PDF pages 4, 11, 12, 15, 19.
- **CC-M05-C02: Top-down intermarket and seasonal context.** Start from PDF pages 55, 79, 92.
- **CC-M05-C03: HTF risk and order execution.** Start from PDF pages 110, 128, 147.

Deliver anchored historical ranges, quarterly context and top-down analysis. Monthly/weekly/4H aggregation needs exact session anchors and complete-bar availability. Macro, yields and seasonal data use publication timestamps.

### Month 06: Swing trading

Source: 92 pages.

- **CC-M06-C01: Market selection and profile.** Start from PDF pages 4, 5, 6, 7.
- **CC-M06-C02: Monthly/weekly/daily PD-array alignment.** Start from PDF pages 25, 26, 35, 41.
- **CC-M06-C03: Trade objectives, partials and execution.** Start from PDF pages 46, 57, 69, 80, 89.

Deliver a versioned swing-trade template with market selection, monthly/weekly/daily PD-array location, entry, stop, targets, partials, overnight handling and cancellation. Test both directions and no-trade cases.

### Month 07: Short-term trading

Source: 133 pages.

- **CC-M07-C01: PD-array hierarchy and HTF sequence.** Start from PDF pages 4, 6, 11, 12.
- **CC-M07-C02: Weekly profiles and reversal scenarios.** Start from PDF pages 22, 34, 50, 99, 108.
- **CC-M07-C03: Time/price alignment and failure handling.** Start from PDF pages 67, 95, 115, 116, 133.

Deliver weekly-profile scenarios and short-term templates. Monday-Wednesday observations must not use the eventual weekly high/low. Explain profiles as developing scenarios and retain failed cases.

### Month 08: Day trading

Source: 85 pages.

- **CC-M08-C01: Daily framing, time of day and weekly context.** Start from PDF pages 4, 5, 6, 7, 10.
- **CC-M08-C02: Killzones, CBDR and range qualification.** Start from PDF pages 22, 32, 38, 43.
- **CC-M08-C03: Intraday profiles and entry/exit planning.** Start from PDF pages 52, 53, 64, 74, 85.

Deliver market-specific day-trading sessions, prior-day/week levels, Asian/CBDR ranges, ADR projections and daily plans. Validate DST, crossing midnight, holidays and shortened sessions. Do not copy Forex pip/range rules directly to equities or NSE.

### Month 09: Advanced day trading and scalping

Source: 106 pages.

- **CC-M09-C01: Sentiment, entries and daily projections.** Start from PDF pages 4, 5, 6, 14, 21.
- **CC-M09-C02: Consolidation, intraday and intraweek reversals.** Start from PDF pages 34, 40, 53, 66.
- **CC-M09-C03: Accumulation/distribution and London-close exits.** Start from PDF pages 58, 60, 77, 79, 92, 106.

Deliver advanced day-trading/scalping templates with precise entry/exit timing and program-state evidence. With only 5m OHLC, same-bar execution order can be ambiguous; report it instead of inventing intrabar prices.

### Month 10: Asset-specific trading

Source: 201 pages.

- **CC-M10-C01: Commodity selection, seasonality and COT.** Start from PDF pages 4, 51, 63, 69, 73.
- **CC-M10-C02: Open interest and news-aware analysis.** Start from PDF pages 74, 75, 76, 99, 101.
- **CC-M10-C03: Index SMT, index sessions and equity context.** Start from PDF pages 126, 147, 148, 151, 155, 176, 186, 201.

Deliver separate commodity/index/equity research adapters. COT, open interest, contract rolls, fundamentals and news require additional historical datasets. Unsupported requirements show DATA_REQUIRED, not approximate stock-price substitutes.

### Month 11: Higher-conviction asset selection

Source: 52 pages.

- **CC-M11-C01: Commodity sectors and fundamentals.** Start from PDF pages 4, 5, 6, 7, 13, 18.
- **CC-M11-C02: Forex strength and currency selection.** Start from PDF pages 21, 29, 39.
- **CC-M11-C03: Stock screens and bond-market context.** Start from PDF pages 45, 48, 51, 52.

Deliver asset ranking, relative-strength comparisons and watchlists linked to qualifying HTF setups. Validate each sector/pair mapping and screen as-of time; selection alone is not entry approval.

### Month 12: Integrated top-down models

Source: 101 pages.

- **CC-M12-C01: Monthly-to-weekly decision flow.** Start from PDF pages 4, 11, 20.
- **CC-M12-C02: Weekly-to-daily decision flow.** Start from PDF pages 21, 29, 38.
- **CC-M12-C03: Daily-to-4H decision flow.** Start from PDF pages 39, 47, 56.
- **CC-M12-C04: 4H-to-5m execution flow.** Start from PDF pages 57, 65, 75, 76.
- **CC-M12-C05: Asset adapters and four model examples.** Start from PDF pages 83, 84, 88, 97, 98, 99, 100.

Deliver an integrated top-down decision tree, with separate swing/short-term/day/scalp strategy contracts. Source pages 97-100 anchor four worked model directions; reverse-direction implementation needs independent verification. Compare checklist -> replay -> backtest -> paper evidence for the same setup.

## Extensions already requested

IFVG, OTE, liquidity sweeps and bread-and-butter models remain explicit tracked work. Source-check every definition and model before claiming this collection supports it. IFVG is currently a local close-through adaptation; do not attach a fabricated PDF reference. Bread-and-butter naming is unresolved until a precise source/model is pinned. Existing Silver Bullet and other later concepts stay separately versioned.

## Shared engineering contracts

**Source registry:** source hash, physical page, visual-review status, paraphrased definition, exact ambiguities and rule/adaptation classification. A rule cannot be SOURCE_VERIFIED from keywords or a library method name alone.

**Concept event:** event_id, concept_id, rule_version, dataset_version, symbol, market, timeframe, direction, origin_at, known_at, geometry, prerequisite_event_ids, source_refs and lifecycle events. Preserve raw library payload unchanged; derived states belong in a separate event/enrichment layer. State at time T is reconstructed from events available by T.

**Strategy contract:** mandatory context, setup sequence, entry mode, fill policy, stop, target hierarchy, management, expiry/cancellation, market adapter, risk policy and permitted data resolution. Version every change and preserve original research rows. Bias -> location -> setup -> confirmation -> entry -> management are separate stages.

**Data contract:** native OHLC provenance, adjusted/unadjusted policy, exchange calendars, session timezone, duplicate/invalid handling, symbol history and available date/frame coverage. Add deterministic completed weekly/monthly and session-aware 4H bars with completeness metadata. Do not synthesize unavailable intraday history.

**Job/result contract:** run_id, immutable strategy/dataset hashes, requested window, availability window, status/progress/errors, costs, event/trade IDs and result artifact locations. Dashboard calls bounded APIs; runners remain in their canonical project.

Proposed storage: source_documents, chapter_specs, concept_rule_versions, concept_events, strategy_versions, dataset_versions, research_runs, replay_fixtures and validation_reports. Reuse equivalent existing tables after schema audit; these are proposed logical entities, not SQL migrations already approved or applied.

## The delivery loop for every chapter

1. Visually review all relevant source pages and diagrams; record unresolved ambiguities.
2. Write original explanation and source-linked deterministic specification. Parameters absent from source are explicitly local adaptations.
3. Audit existing implementation condition by condition; classify retain, modernize, merge, validate or retire.
4. Create positive, negative, neutral, boundary and unavailable-data replay fixtures.
5. Implement the canonical rule and causal events, then render those same events in the website.
6. Connect the rule to a versioned strategy only where a complete entry/management contract exists.
7. Compare fixture expectations, UI evidence and backtest/realtime shadow output.
8. Publish the chapter's readiness report and remaining limitations. Move to the next chapter only after its stated deliverables pass.

No discretionary phrase such as "significant", "near support", or "strong displacement" becomes an arbitrary ATR threshold without an explicit, tested adaptation record. Conflicting source examples remain review items, not silently averaged rules.

## Backtesting and 2026 research

Start with AAPL and EURUSD, plus the first available liquid NSE instrument; expand to the nine requested instruments only after the coverage report confirms each required frame. Use 1d/1h/30m/15m/5m. Show exact testable date intersections per setup; missing SPY/QQQ or early intraday history means insufficient data until rechecked/backfilled.

Treat 2026 as a prospective holdout where feasible. Dates already examined or used to tune rules are marked exposed and do not qualify as untouched holdout. Fit parameters/features on earlier periods, validate with time-based folds, and evaluate untouched later windows. Report results by market, symbol, regime and setup version, not only a pooled win rate.

Keep concept occurrences, eligible setups, confirmations, submitted entries and fills separate. Report no-trade/neutral counts, coverage, rejection reasons, costs, expectancy in net R, drawdown, losing streaks, MAE/MFE, holding time, target/stop ambiguity and sensitivity to fill/cost assumptions. OHLC-only replay uses completed candles and causal next-bar eligibility; finer execution requires finer data.

## ML and execution integration

ML starts after the deterministic checklist and labels are stable. Create features only from information available at the prediction timestamp; preserve complete strategy_json and feature provenance. Compare against a no-ML baseline, use time-based validation and calibration, track drift and evaluate incremental net performance. ML scores can rank eligible setups; they cannot convert failed mandatory rules into passes.

Historical and realtime shadow replay must produce the same events and eligibility for identical completed candles. Then paper-test fills, cancellations, retries, stop/target updates, partials, reconciliation and restart behavior. Live promotion requires explicit strategy/account authorization, current broker readiness and independent risk controls. Reading the PDFs or approving this roadmap does not authorize new live orders.

## Milestones and completion gates

| Milestone | Deliverable | Gate |
| --- | --- | --- |
| 0. Baseline | PDF manifest, current code/strategy/dataset inventory, chapter registry | All sources and reused components identified; unknown readiness disclosed. |
| 1. Repair | Neutral visibility, layer manager, causal event contract, source-linked Chapter 1 replay | Candle and zone evidence matches fixtures in the actual browser. |
| 2. Foundation | Months 1-4 learning/replay and independently audited primitives | Source checklist coverage and causal tests pass; heuristics remain labelled. |
| 3. First full strategy | One complete candle-only template with risk and management | Reproducible cost-aware backtest; failures/no-trades explained. |
| 4. Model expansion | Months 5-9 templates and HTF/session infrastructure | Each template has its own version, fixtures and coverage report. |
| 5. Asset context | Months 10-11 data adapters and selection | Required macro/fundamental/contract data available as of historical timestamps. |
| 6. Integrated workspace | Month 12 flow across learning, builder, backtest and monitoring | Every decision traces to source rule, dataset and known events. |
| 7. ML and paper | Validated scoring and reconciled paper runs | Measured incremental benefit and historical/realtime parity; unresolved risk blocks promotion. |

Use gated delivery slices rather than a promised calendar date. Estimate each chapter after visual review and its code/data gap audit; the chart-heavy PDFs and new cross-asset feeds are the main uncertainties.

## Immediate work queue

- P0: Full source review/specification of Month 1; current chart neutral/layer fixes; pivot/event timing reconciliation.
- P0: Coverage/calendar/adjustment audit and common event schema.
- P1: Month 2 risk contract and Month 3 structure/HTF replay.
- P1: Month 4 independent OB/breaker/FVG/mitigation/rejection validation, including bullish and bearish counterexamples.
- P2: One integrated setup linked to the builder and reproducible backtest, followed by its shadow monitor.
- P2: Continue Months 5-12 in order; build missing data adapters when prerequisites are reached.

This plan is complete as an implementation roadmap. Full chapter specifications, source-diagram interpretation, new detector validation and integration work are still to be delivered.
