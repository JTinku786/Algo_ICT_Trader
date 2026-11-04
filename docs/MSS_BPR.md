# Balanced Price Range candidates

BPR is selectable in both TF1 level and TF2 entry groups in Market Structure Shift, and has its own Institutional PD Arrays chart toggle. Labels use +BPR / −BPR, with bullish green and bearish red zones. TF1 projections retain the TF1 BPR prefix. Removal/undo uses the existing shared zone controls.

Detection is a derived candidate rule, not a native smartmoneyconcepts datapoint: pair each newly confirmed native FVG with every previously confirmed opposite-direction FVG that has a positive-width overlap. Keep each source pair separately; a newer narrow overlap must not suppress an earlier wider overlap. Range bounds are max(bottoms) to min(tops); direction follows the later FVG. Mere boundary contact, same-direction gaps and simultaneously known gaps do not create BPR. The earlier gap must not have been invalidated before the opposite three-candle leg starts. It may be invalidated during that displacement while the overlap forms. Pair selection has no future input. Both source IDs and known times are retained in raw evidence; activation is the later knownAt and the box anchor is the later gap's origin candle.

After activation, close beyond the opposing BPR edge invalidates the candidate. Entry selection waits for both shift confirmation and BPR activation, respecting invalidation and the selected array-timing mode. In existing/displacement mode the later source FVG may finish its third candle after the break, provided its middle belongs to that shift. No BPR is inferred from IFVGs, touched OBs or equal-height boundary lines.

Verified with causal overlap/unit checks, live August 3 EURUSD 1h → 1m API run with BPR-only entries (452 derived lower-frame BPR candidates; 273 entry contexts, not independent trades), TypeScript and ESLint. Evidence exported to public/reports/mss-bpr-evidence.json. This validates implementation; it does not certify the particular screenshot's complete entry sequence.


October 5 reference regression: the August 3 02:09 NY bearish FVG (1.15363–1.15372) overlaps both the 01:57 bullish FVG (1.15362–1.15367) and a newer narrow bullish FVG (1.15370–1.15371). Both BPR candidates are retained. The earlier overlap is 1.15363–1.15367; first stored retest is 02:12. This fixes overlap enumeration, without bypassing the HTF context requirement.
