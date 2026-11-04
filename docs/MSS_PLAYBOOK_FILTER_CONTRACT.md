# MSS playbooks and source evidence

Implemented 2026-10-06 in the existing Market Structure Shift workspace. Native SMC CHOCH remains a separate detector. Playbooks do not change the selected confirmation method.

## Contract

`src/lib/mss-strategy-filters.ts` defines version 1 of the shared request contract. The API validates every enum, requirement and numeric bound before loading candles. `scripts/mss_strategy_requirements.py` evaluates independent requirements after native matching and plan construction. The response retains the request and each entry's checklist.

Selected array kinds use OR. Required evidence uses AND. Chart visibility is a presentation choice and does not change eligibility. Unselected evidence is informational. A required FAIL or UNVERIFIED holds the candidate; it does not silently pass. Held entries remain in `rejectedEntry` with their original candle, price, plan and blockers. Their replay inspection does not create an automatic paper plan.

Default additional requirements are empty. Native detector output, array activation, confirmation, stops and targets remain separately inspectable. AAPL Daily to 5m close-CHOCH, 2026-01-16 through 2026-01-23, returned the same 104 raw entry contexts before and after empty requirements. These are contexts, not distinct trades or a performance claim.

## Timing and pricing

HTF activation must precede the touch; shift and array activation must precede the entry candle. Evidence uses completed candle clocks. Future pivots and arrays cannot qualify overlap. MFE/MAE are subsequent outcomes, not entry requirements.

EDGE retains the existing open-inside/near-edge entry convention. CE rebuilds retest visits using the midpoint before FIRST/ALL/CANDLES selection. It waits for an actual midpoint touch, so an earlier edge touch cannot consume the first midpoint visit. Retirement and context caps still apply.

R:R is reward divided by entry-to-stop distance; it is not a percent of entry. Minimum is inclusive, maximum exclusive. Session windows use America/New_York with timezone conversion: London 01:00–05:00, New York 07:00–10:00, London lunch 05:00–07:00; end excluded. These named windows are explicit research choices, not a universal interpretation of every caption.

## Supported requirements

| Requirement | Evidence and boundary |
| --- | --- |
| Sweep/reclaim | Existing structural-plan sweep sources and observed extreme |
| Displacement | Directional body >=60% range and >=1.5 times prior 20-body median; local threshold |
| Premium/discount | TF2 formation range midpoint; endpoints recorded |
| OTE | 62–79% retracement of that TF2 formation range; not an inferred HTF dealing range |
| Unicorn | Entry inside active same-direction breaker/FVG overlap, both known before entry |
| Three drives | Last three confirmed native pivots progressively extend; local interpretation |
| HTF CE | Selected TF1 FVG/IFVG midpoint crossed at the recorded touch |
| Midnight opening | Same-day NY midnight candle; missing candle is UNVERIFIED |
| Structural target | Existing unswept opposing liquidity from the original plan |
| SMT/news | Inputs absent; explicitly UNVERIFIED and blocking when required |

Playbooks cover sweep reversal, Unicorn, inversion/BPR, post-shift continuation and three drives. Manual changes produce a custom checklist. IFVG, BPR and breaker activation remain distinct engine primitives.

Four-hour candles can be derived from four consecutive completed hourly bars on a local midnight grid. Missing/duplicate/incomplete hours are rejected. This is not a session-anchored US 4h implementation.

## Source intake and reproduction boundary

Source Downloads files remain read-only. `scripts/intake-icy-tea.py` records SHA256, stable IDs, OCR, previews and checkpoints. `public/reports/icy-tea/intake/new-source-register.json` contains 349 unique new images visually triaged in contact sheets. The folder has 422 files, including six exact-content duplicates; all 385 unique still images have OCR.

323 new charts omit a full date; 25 have partial dates with publication-year candidates; one prints a full 2023 date. Publication time is not entry time. OCR family hints are annotation hints, not mandatory strategy classifications. Visual direction is the drawn trade direction, not candle certification.

26 approximate date-window probes are saved with full selections and candidate evidence. Results: one native candidate window, 24 without a native entry in the tested window, one unmapped futures contract. The candidate has five HTF contexts for one EURUSD SELL IFVG entry at 13:08 on the inferred 2026-03-10 date. This does not certify the screenshot's precise entry or all its conditions. Assumed dates, HTF and windows remain explicit.

NQ/ES require actual contracts and source history; QQQ/SPY are not replacements. Separate rejection/mitigation/propulsion blocks, session/Asian liquidity, opening/weekend gaps, HTF body/quadrant/dealing ranges, deviation targets, synchronized SMT and calendar filters remain unsupported by this common-filter layer. Retain these as source features; do not mark them verified or claim every image reproduced.

## Resume and validation

Run intake again to skip completed OCR. Run `node scripts/probe-new-icy-tea.cjs` to skip completed probes. Rebuild the source page with `python scripts/build-icy-tea-library.py`. Progress lives in `public/reports/icy-tea/intake/progress.json`; no token-renewal assumption or scheduled automation is needed.

Validation: TypeScript, targeted ESLint, native close-CHOCH regression, requirement unit checks, live AAPL empty-filter/SMT/CE API checks, completed-minute/hour rollup checks, and browser inspection of playbook requirements, held-entry evidence and replay focus.

## Metrics, multiselect and outcome history

The header has direct links to metrics and heatmaps. Optional playbook controls start collapsed. Zero-trade runs retain metric cards and blank heatmaps with the reason shown.

Analytics supports independent multiselect R:R bands: 0–1, 1–2, 2–3, 3–4 and 4+. These filter existing planned ratios across every metric, heatmap and table. Bounds include the lower value and exclude the upper. Selecting no bands means no matching trades. The separate chart target-bucket selector can still choose a different existing liquidity target; the analytics multiselect does not move levels.

`UNTIL_HIT` is the default outcome mode. Entries and signal evidence remain confined to the original selected dates. Only unresolved plans are sent to the read-only `/api/market-structure-shift/outcomes` endpoint. It loads validated native OHLC in 30-day chunks, respecting completed rollups, and scans until all plans hit SL/TP or currently available historical coverage is exhausted. Same-candle ambiguity remains stop first. No future candle is passed into the MSS detector. Outcomes at an exhausted boundary remain OPEN.

Future TF2, TF1 and daily candles are retained separately for replay. Existing selected setup annotations are not redetected from future candles. Playback stops at the selected structural plan's exit or an active paper trade's exit. `CLOSE_BY_END` instead records an END exit at the last available completed candle on or before the selected end date; future replay is disabled for that mode. END P&L is included among closed-trade metrics according to its sign.

Live regression: ten unresolved AAPL 4+ plans from an investigation ending 2026-01-21 resolved using 707 future 5m candles through 2026-02-04. Source selections and entry evidence were unchanged. Unit tests cover end-date closure, later target resolution, BUY/SELL symmetry, entry-candle exclusion for SL/TP, ambiguous stop first and history exhaustion. Browser verification covers multiselect, automatic future loading and explicit END closures.
