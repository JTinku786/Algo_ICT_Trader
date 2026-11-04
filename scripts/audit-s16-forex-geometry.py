"""Reconcile the supplied S16 FX review against the completed v2 snapshot."""
import json
from pathlib import Path

import pandas as pd
from reports_dir import REPORTS

ROOT = Path(r"C:\Users\saite\Desktop\ICT_Automation\artifacts\s16_forex_live_replay_20261020_v2")
OUT = Path(__file__).resolve().parents[1] / "artifacts/s16-forex-review"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    wide = pd.read_csv(ROOT / "forex_s16_research_dataset_audited.csv")
    outcomes = pd.read_csv(ROOT / "all_target_outcomes.csv")
    coverage = pd.read_csv(ROOT / "coverage_audit.csv")
    metrics = []
    for (source, ticker), g in wide.groupby(["source", "ticker"]):
        pip = .01 if ticker.endswith("JPY") else .0001
        metal = ticker in ("^XAUUSD", "^XAGUSD")
        buffer = g.entry_price.abs().mul(.002).clip(lower=.01)
        risk = (g.filled_price-g.stoploss).abs()
        evidence = g.strategy_json.map(json.loads)
        metrics.append(dict(source=source, ticker=ticker, signals=len(g), buffer_price_median=buffer.median(), buffer_pips_median=None if metal else (buffer/pip).median(), filled_risk_price_median=risk.median(), buffer_share_risk_pct=(100*buffer/risk).median(), accepted_without_close_inside_flag=sum(not e["sweep"]["close_back_inside"] for e in evidence)))
    cohorts = []
    for (source, target, metal), g in outcomes.groupby(["source", "target_no", outcomes.ticker.str.contains("XAU|XAG")]):
        r = g.realized_r.dropna()
        loss = -r.clip(upper=0).sum()
        cohorts.append(dict(source=source, target=int(target), universe="metals" if metal else "currency_pairs", signals=len(g), closed=len(r), gross_r=r.sum(), profit_factor=r.clip(lower=0).sum()/loss if loss else None))
    findings = [
        dict(step="FX buffer geometry", verdict="CONFIRMED_FX_SUITABILITY_DEFECT", evidence="s16_strategy.py price_buffer and sweep/retest/execution call sites", verification="Non-JPY buffer is 0.01 = 100 pips. EURUSD has 12 Barchart signals; median filled risk is about 119 pips and buffer share about 84%. The price buffer controls sweep, stop, minimum target distance, target separation and retest tolerance."),
        dict(step="Sweep reclaim", verdict="CONFIRMED_NOT_A_REQUIRED_GATE", evidence="detect_5m_sweep sets passed=True at first wick-through regardless of close_back_inside", verification="The saved signal evidence includes accepted close_back_inside=False. Even a True flag compares the close with the buffered threshold, not the pool price. R1 requires a same-bar completed close strictly inside the pool; this is an explicit local rule revision."),
        dict(step="Trading-day clock and bias", verdict="CONFIRMED_REPLAY_LIMITATION", evidence="v2 bias_positions and 5m/15m windows use all5.index.normalize(); lock uses ts.date()", verification="This excludes the previous calendar date's evening context from London scans and holds completed bias at midnight until the next midnight. After 17:00, the just-completed daily candle is omitted. R1 uses the NY 17:00 trading day and current completed-candle availability."),
        dict(step="Killzones", verdict="LOCAL_ADAPTATION_NOT_AN_ESTABLISHED_UNIVERSAL_REQUIREMENT", evidence="Original S16 module describes a session-independent reversal model", verification="No killzone gate exists. The requested London 02:00–05:00 and NY 07:00–10:00 restriction is preregistered as a research variant. Losing hourly subgroups do not independently establish that this filter improves the strategy."),
        dict(step="Coverage equality", verdict="CLAIM_REQUIRES_CORRECTION", evidence="coverage_audit.csv and major_history_gaps.json", verification="Most Barchart FX pairs have about 707k–709k valid bars. GBPJPY has only 309,327 and a January 2021–June 2026 gap. Signal-count imbalance on similarly covered EURUSD/AUDJPY supports investigating geometry, but coverage is not equal across every pair."),
        dict(step="Aggregate result identity", verdict="CLAIM_REQUIRES_SOURCE_LABEL", evidence="all_target_outcomes.csv, target 2", verification="1,896 closed / -336.50R is Barchart including metals: FX 1,298 / -134.02R plus metals 598 / -202.48R. Including the newer source gives 1,922 / -352.38R. Sources and asset classes must remain separate."),
        dict(step="Database lineage", verdict="V2_IS_AN_ARTIFACT_ONLY_RUN", evidence="Read-only current table counts", verification="15 legacy S16 forex signal rows exist in historical_ict_strategy_met_execution; zero exist in its updated counterpart and the realtime strategy execution table. This does not establish a published database run for v2."),
        dict(step="Sessions and upstream timezone correction", verdict="PARTLY_VERIFIED", evidence="v2 reconstruction and stored coverage timestamps", verification="NY 17:00 daily and Sunday 17:00–Friday 17:00 weekly aggregation is explicit. Metals' first observed source open is 18:00, but the replay uses the shared 17:00 grouping boundary, not a distinct metal calendar. A past +1h database mutation cannot be independently proved from these artifacts alone."),
        dict(step="Execution and costs", verdict="MECHANICAL_CONTRACT_ONLY", evidence="v2 simulate and shared updated exit engine", verification="Entry is the first executable open at/after detection. Target touch and close-confirmed stop are mechanical replay choices, not broker realism. FX has 1/2/3 pip round-trip sensitivity; metals have no spread/cost model. Missing execution paths remain unresolved."),
        dict(step="Target provenance", verdict="MIXED_STRUCTURAL_AND_SYNTHETIC", evidence="compute_execution_plan pads sparse liquidity with rr_projection targets", verification="Original prices were preserved, but not every original T1/T2/T3 is a structural-liquidity target. R1 preserves and labels this existing behavior rather than silently calling all targets structural."),
        dict(step="Overall interpretation", verdict="NOT_VALIDATED_AS_AN_FX_MODEL", evidence="Scale-sensitive geometry, stale clock/context and source/cost limitations", verification="The replay accurately describes this implementation under its stated assumptions. It does not establish that a properly specified ICT forex setup has negative expectancy. Mechanical audit PASS is not strategy-fidelity or model-validity approval."),
    ]
    result = dict(status="FX_MODEL_NOT_VALIDATED", run="s16_forex_live_replay_20261020_v2", mechanical_reconciliation="passed", findings=findings, instruments=metrics, cohorts=cohorts, coverage=coverage[["source","symbol","bars","major_gaps_over_7_days"]].to_dict("records"), corrected_research=dict(id="S16-FX-R1", classification="LOCAL_ADAPTATION", buffer="2 pips fixed, JPY pip 0.01 / other currency pairs 0.0001", reclaim="same completed candle strictly inside pool", calendar="NY 17:00; latest available completed D/W", entry_windows="02:00–05:00 and 07:00–10:00 NY", limits="one accepted signal per FX trading day", costs="report 1/2/3 pip sensitivity; no observed spread claim", blind_gate="BUY/SELL reflection and quote-scale invariance before new target outcomes are inspected", metals="not accepted by FX adapter; separate tick/spread contract required"))
    text="# S16 Forex v2 — independent geometry and fidelity review\n\nMechanical reconciliation passed; FX model suitability is NOT validated.\n"
    for item in findings:
        text+=f"\n## {item['step']}\n\nStep: {item['step']}\n\nEvidence: {item['evidence']}\n\nVerification: {item['verification']}\n\nVerdict: **{item['verdict']}**\n"
    (OUT/"review.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
    (OUT/"review.md").write_text(text,encoding="utf-8")
    pd.DataFrame(metrics).to_csv(OUT/"instrument_geometry.csv",index=False)
    destination=REPORTS/"s16-forex-20261020"
    if destination.exists():
        for name in ("review.json","review.md","instrument_geometry.csv"):
            (destination/name).write_bytes((OUT/name).read_bytes())
    print(json.dumps(dict(status=result["status"], findings=len(findings), artifact=str(OUT)),indent=2))


if __name__=="__main__":
    main()
