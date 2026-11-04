# Consolidation end-to-end review

Verdict: FAIL_SOURCE_FIDELITY.

{
  "runs": 6,
  "symbols": 31,
  "variants": 292199,
  "api_combinations": 252,
  "source_sample_symbols": [
    "GE",
    "DD",
    "SPY"
  ],
  "rule_audit": "sampled boxes and closed trades; exact sample sizes in run evidence",
  "full_population": "geometry, timestamp labels and R arithmetic; not a full native-candle strategy audit",
  "realtime": "No consolidation realtime route exists; this is historical research only",
  "date_labels": "US exchange wall time; native bar labels do not prove exact intrabar exit times"
}

Corrections:
- Filtered performance now follows symbol and fate selections
- CSV downloads full selection, not the 1500-row display cap, and preserves JSON
- Invalid negative-target geometries excluded from performance and labelled in rows/CSV; future engine guard
- 1H chart follows FULL engine 30m session-hour lineage
- Exit markers use actual R-implied fill prices including gaps; open marker is labelled MARK
- Audit badge explicitly describes sampled feed conformance; source limitations and retrospective filters disclosed

Full evidence: public/reports/consolidation-end-to-end-review.json
Report: public/reports/consolidation-end-to-end-review.html
