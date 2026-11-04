# some_icy_tea reference audit and minute aggregation

Source: C:/Users/saite/Downloads/some_icy_tea (36 images, 31 videos). The source folder is read-only; final video chart frames and image previews are saved under public/reports/icy-tea. All 67 files are catalogued in references.json. Approximate entry windows and directions are visually transcribed, not authoritative broker fills.

Market Structure Shift now supports TF1/TF2 2m and 3m. These load native 1m and aggregate consecutive, completed OHLCV candles on the local session-day minute grid. Duplicate, missing, partial and incomplete buckets are excluded. Activation is the last underlying minute close; chart indicator and replay durations use the aggregated timeframe. No synthetic candles or 5m-to-1m upsampling.

Audit filters: the stated lower timeframe; stated TF1 where visible, otherwise 1h explicitly assumed; all TF1 categories including swings; only the reference entry-array kind; EITHER (native close CHOCH or separately labelled CISD candidate); EXISTING arrays. 2026 is assumed from context except the Friday April 4 reference, whose weekday suggests 2025 and remains uncertain. Three charts do not show an identifiable date. Four NQ references are not mapped to ETF prices; a read-only historical 1m symbol query found no NQ/NDX/NAS/IXIC match.

A candidate means an entry of the drawn direction and array type inside an approximate visual window. It does not certify the screenshot's exact HTF, candle, price, stop, target or outcome. Unmatched windows do not prove the illustrated setup invalid or absent under every possible configuration. The report distinguishes these from actual missing data. The interactive audit is linked from the MSS heading and served at /reports/icy-tea/index.html.

## August 3 correction

The former newest-opposite-FVG-only BPR pairing suppressed the earlier overlap drawn in reference #57. The final detector preserves all qualifying source pairs, excluding an older gap already invalidated before the opposite three-candle leg starts. Invalidation during the opposite leg is allowed. Source IDs and known times remain explicit.

For the stored EURUSD candles: bullish FVG 1.15362–1.15367 (known 01:57 NY), bearish FVG 1.15363–1.15372 (known 02:09) produce bearish BPR 1.15363–1.15367; first retest 02:12, entry 1.15363. Separately labelled CISD closes at 02:08, known 02:09; reversal high 02:05 at 1.15387. The 30m TF1 bearish FVG provides qualifying context; the earlier 1h-only test excluded it. The image says HTF without identifying its exact frame, so the complete screenshot context remains a comparison rather than a certified identical HTF box. Evidence: aug03-30m-reference-match.json; dashboard proof: aug03-bpr-dashboard.png.

## Verification

- Minute rollup unit checks cover OHLCV, knownAt, missing/duplicate/incomplete buckets, sorted input.
- Live 3m API reconciliation checked 474 July 13 candles against native 1m OHLCV and activation.
- Browser loaded EURUSD 1h → 2m August 12 and the corrected August 3 BPR story.
- BPR tests cover both directions, multiple simultaneous overlaps, stale-source exclusion, source timing and retirement.
- Default native September CHOCH investigation payload hash stays unchanged (29 investigations); EITHER still supplies 441 contexts and causal entries.
- TypeScript, Python compilation and changed-file ESLint pass.

The primitive scan cache now fingerprints the scan implementation and primitive kernels independently of downstream BPR/matching code. Repeated event/array retest calculations and structural plans are cached within a request; the plan key includes HTF touch time. No database strategy/order tables are changed.
