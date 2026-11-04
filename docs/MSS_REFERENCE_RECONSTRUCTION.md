# Reference reconstruction — October 5, 2026

The previous 22 unmatched files included a June 3 image/video duplicate. Full-resolution review found incorrect reference dates (May 26 instead of May 28, August 19 instead of August 10), incorrect/cropped entry windows, a midnight rollover from August 12 to August 13, and entry-array label assumptions. Corrected dates/windows are in public/reports/icy-tea/corrected-references.json. Body-pixel alignment is a ranking aid, not exact price/candle certification; weak fits and annotation differences remain explicitly marked.

Final verification: all 22 selected presets returned entry candidates in the actual tested window and direction. Array knownAt and shift knownAt are <= entry.at; HTF knownAt <= touch.t. Source/year/weekday ambiguities and annotation differences are not erased. This is not proof of identical hand-drawn stop/target, fill, or outcome, and the native defaults were not relaxed to obtain these candidates.

## Explicit local adaptations

- LOCAL and LOCAL_WICK: opposing pivot break after a reversal pivot, confirmed at a completed candle. Default local pivots are native 3-left/3-right confirmed SMC pivots. Optional 1-left/1-right fixed-width pivots are separately identified. A new reversal extreme cancels the pending pivot candidate. These events are LOCAL_SHIFT, never relabelled native CHOCH.
- CONTINUATION array timing: valid existing/continuation arrays are allowed before retest. Entry waits for max(array activation, shift knownAt). Candidates end on reversal-extreme breach or TF1 invalidation. FORMATION and EXISTING retain their prior definitions.
- Carry-in HTF touches: optionally include observed touches in the already-loaded warmup, supporting overnight formation. No extra/synthetic candles are loaded.
- ALL retests: one entry candidate per distinct OHLC visit, not each consecutive overlapping bar. CANDLES explicitly exposes every eligible retest candle for research; it does not submit orders. FIRST is unchanged.
- Optional TF1 candle-delivery OB: last opposite candle followed by two advancing directional closes beyond its open; full source wick range; activation at second close, invalidation at close through far edge. This is a separately identified local interpretation, not native SMC volume/structure OB output. It is unchecked by default.
- Optional research entryWindowMinutes restricts outputs while preserving first/visit definitions; it cannot move knownAt backward or skip an earlier visit to call a later one first.

## Website

Market Structure Shift has a Reference reconstruction selector and Load reference setup action. Presets apply exact tested filters/window and focus the intended context, array and entry rather than selecting an unrelated opposite-direction row. Multiple retests use unique entry identities; plotted boxes are deduplicated by zone ID. Table identifies candle-delivery TF1 OB provenance. Normal Investigate uses the user's normal unrestricted date selection.

Reports: /reports/icy-tea/reconstruction.html and reconstruction-cases.json. Historical screening remains in index.html. All 22 full verification results: final-reconstruction.json. Loadable filters: final-reconstruction-filters.json. Arrays may be native consecutive segments while the screenshot draws a combined box; OB/breaker terminology differs in some references and is documented, not silently renamed.

## Checks

- test-mss-local-shift.py: pivot availability/no backdating, new extreme cancellation, missing opposing pivot, scope separation, distinct visits, per-candle research mode, invalidation/cap, candle OB activation/retirement and close/wick separation.
- test-mss-bpr.py: existing overlap/source timing coverage.
- test-mss-september-confirmation.cjs: default native investigation hash unchanged, optional CISD and causal September evidence.
- TypeScript no-emit and ESLint for changed UI/API.
- Final live API verification for all 22 presets plus browser preset/report checks.

No strategy/order tables were written; no live or paper orders submitted. Exact hand-drawn performance reproduction remains outside the verified entry-candidate claim.
