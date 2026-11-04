# ICT consolidation research — 2026-10-13

Verdict: positive edge not established in tested automatic variants.

Primary source: [ICT Month09 Trading in Consolidations](https://www.youtube.com/watch?v=g7jchu4g31c).
Original YouTube auto-generated transcript was exported and checked. At0:36–1:21 the lesson introduces Daily/4H context and lower-timeframe ranges. At6:01–7:13 it discusses fading expansion from equilibrium toward the other side. At12:08–13:23 the outside-low bullish example takes the return to equilibrium instead of assuming the opposite edge. Exact numeric stops, ATR box thresholds and the swing-break context proxy used here are LOCAL_ADAPTATION.

## Measured scope

31 current symbols,2017–2026;9 entry families;4 box timeframes;2 compression configurations;4 context comparisons;4 stop/holding policies. 1,916,876 overlapping variants and179,245 distinct model-entry records. These are not a portfolio or broker fills. The original consolidation/reversal production runs are untouched.

958,434 valid base entries had clock, geometry and raw fingerprint checks. 937,154 full-hold outcomes and938,175 session-flat outcomes passed independent first-exit/R replay. Eight impossible negative-target variants were rejected. Ten execution-contract unit tests passed. Remaining uncertain target/fill ordering and missing paths are unscored. Intrabar fills with a stop but no target are known losses; resting orders filled at open can exit in the opening bar.

## Representative comparison

1H tight boxes,CE target,Daily+4H aligned swing-break proxy,5m-close SL,flat at official session close,minimum initial risk0.2%,5bps round-trip sensitivity:

| Entry | Closed | Net win% | Avg net R | Total net R |
|---|---:|---:|---:|---:|
| Resting10% beyond edge |1038|34.7|-0.297|-308.03|
|5m reclaim |658|47.3|-0.182|-119.55|
|5m MSS next open |246|58.1|-0.137|-33.65|
|15m MSS next open |68|55.9|-0.167|-11.37|
|5m MSS,FVG midpoint limit |83|44.6|-0.269|-22.32|

The5m MSS/CE cohort averaged0.335R on positive trades and-0.742R on negative trades. Its average planned reward was0.532R; late confirmation leaves little distance to equilibrium. Win rate alone is insufficient.

The1H tight,both-context,15m MSS,2R session-flat cohort returned+8.51R gross over327 closures,about+4.84R at1bps, -9.83R at5bps and-28.17R at10bps. Its estimated break-even round-trip friction is2.32bps. This is a fragile research result, not established alpha.

Annual train-only parameter selection was checked for2022–2026(80 folds across4 timeframes/4 exit policies). Every aggregated timeframe/policy path had negative net R at5bps. The shortlisted2022+ month-block confidence intervals included zero; they are not corrected for model-selection multiplicity.

## Reproducibility and limits

Code lives in scripts/consolidation/research_models.py,research_edge_limits.py,validate_research.py andbuild_research_report.py. Outputs record frozen asof,raw fingerprints,code hashes and exact rules. Producers use canonical complete raw5m candles and session-aware rollups,without clipped prices or invented tails. Source snapshots are retained in tmp/consolidation-research andtmp/consolidation-prearmed. The independent audit resolves fill cases and reconstructs session-flat counterparts in tmp/consolidation-research-audited.

Current-universe survivorship,corporate-action economic continuity,quote execution and full ICT PD-matrix context remain limits. Historical walk-forward is not an untouched prospective test. Inside-range internal-swing fades were not implemented in this study.

Interactive report: public/reports/consolidation-research-results.html
Metadata: public/reports/consolidation-research-results.json
Independent evidence: public/reports/consolidation-research-validation.json
Compressed complete ledger: public/reports/consolidation-research-all-trades.csv.gz
