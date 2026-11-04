# Breakout-day Daily close and failed consolidation fades

The user hypothesis is symmetric: after the consolidation high is taken, a Daily
close above the frozen high contradicts the SELL fade at that close. After the low
is taken, a Daily close below the frozen low contradicts the BUY fade. The comparison
is to consolidation edges, not to the breakout candle's own high or low.

This is `USER_HYPOTHESIS / LOCAL_ADAPTATION`, not a claimed source-literal ICT rule.
A high/low raid alone does not establish a reversal. Existing legacy Sweep Fade
already requires a wick reclaim or a failed body break reclaimed within three native
bars; the research panel also tests first-raid, close-break, reclaim and MSS entries
separately. No existing trade or entry rule was rewritten by this analysis.

## Measured comparison

Audited canonical raw-candle ledger, 31 US symbols, 2017 onward, frozen at
2026-10-13 00:58:50 America/New_York. 944,742 full-hold fade variants represent
175,962 distinct model-entry events. Different targets, stops, range configurations
and models overlap; this is not a portfolio. The expansion-direction model and
session-flat duplicate outcomes are excluded.

Representative selection: **tight Daily ranges, first 5m raid -> next-open fade,
2R target, 5m closing stop / wick target, both HTF directions, before costs**.

| Side | Breakout-day close | Scored trades | Positive R | Average R |
|---|---|---:|---:|---:|
| SELL | Above consolidation high | 66 | 19.70% | -0.6263R |
| SELL | Inside consolidation | 67 | 61.19% | +0.6860R |
| BUY | Below consolidation low | 61 | 26.23% | -0.5022R |
| BUY | Inside consolidation | 52 | 61.54% | +0.7474R |

Across both sides, continuing pressure averages -0.5667R (127 scored), compared
with +0.7129R (119 scored) for an inside-range close. At 5bps round-trip sensitivity
these averages are -0.7086R and +0.5788R. The unfiltered baseline averages +0.0757R
gross and -0.0618R at 5bps over 249 scored trades. These are conditional historical
associations; they do not demonstrate a deployable positive edge.

## Causal interpretation

The breakout day is the New York session containing the first completed raw 5m
raid, not necessarily the entry day. A day's close becomes known at its official
exchange close, including early-close sessions. Complete raw constituents are
required; partial days, changed raw fingerprints and edge touches that never
confirm an actual break are unverified. The edge tolerance is the existing box
detector's 0.001% of midpoint, with at-edge closes kept separate.

Only 2 of the 127 continuing-pressure entries had this Daily close available at
decision/entry; 119 had already closed by the Daily close, including earlier winners.
29 of the 127 ultimately won. Therefore this close cannot retrospectively make
every earlier BUY/SELL setup invalid, or erase an already completed trade. It is
a pressure warning at the time it becomes known. Waiting for the Daily close,
re-entering later, or exiting still-open trades then requires a separate causal
execution replay; none is claimed here.

For intraday ranges the day may also touch the opposite edge before closing.
Such closes are a separate `THROUGH_OPPOSITE_EDGE` group. No final box-fate field
is used to select the opportunities.

## Tab and verification

The Consolidation tab's Daily-close panel follows the selected range timeframe
and compression. Model, target, stop policy, side and period controls are independent
of the legacy trade tables. Symbol, fate and legacy HTF-bias filters do not apply
to this panel. Legacy feed fidelity limits remain; this panel uses the independently
audited research ledger rather than asserting those old trades are validated.

Seven contract tests passed. TypeScript and scoped ESLint passed. All 31 frozen
raw fingerprints matched. Independent validation reconciled 175,962 event labels,
12,296 metric cells and 19 Daily OHLC samples reconstructed directly from complete
raw 5m constituents. 172,275 events have verified Daily evidence; 3,687 lack verified
Daily/break evidence. These excluded events are not classified as winners or losers
in the Daily-close comparison. The existing audited exit ledger is reused; the
19 samples are Daily-source checks, not a new full exit replay.

Outputs:
- `public/reports/consolidation-day-close.json`: summary and selected examples.
- `public/reports/consolidation-day-close-events.csv.gz`: complete distinct event evidence.
- `public/reports/consolidation-day-close-validation.json`: independent checks and raw samples.
- `tmp/consolidation-day-close/*.csv.gz`: annotated outcome variants.

Reproduce: `python scripts/consolidation/analyze_daily_close.py --workers 4`, then
`python scripts/consolidation/validate_daily_close.py`. `--assemble` rebuilds the
summary from already reconciled annotations; use a fresh full run after source changes.

Current-universe survivorship, corporate-action continuity, unknown intrabar fill
ordering and model-selection effects remain limits. The 2022+ control is a historical
split, not an untouched prospective test. No live or broker route was changed.
