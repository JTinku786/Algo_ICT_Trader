"""Publish the audited, source-isolated S16 forex snapshot as a local web artifact."""
import hashlib
import json
import re
import shutil
from pathlib import Path

import pandas as pd

from reports_dir import REPORTS

REPO = Path(__file__).resolve().parents[1]
SOURCE = Path(r"C:\Users\saite\Desktop\ICT_Automation\artifacts\s16_forex_live_replay_20261020_v2")
DEST = REPORTS / "s16-forex-20261020"


def main():
    validation = json.loads((SOURCE / "final_validation.json").read_text())
    assert validation["status"] == "passed"
    assert json.loads((SOURCE / "targets_status.json").read_text())["status"] == "done"
    manifest = json.loads((SOURCE / "manifest.json").read_text())
    raw = pd.read_csv(SOURCE / "all_target_outcomes.csv")
    research = pd.read_csv(SOURCE / "forex_s16_research_dataset_audited.csv")
    assert len(raw) == validation["target_outcomes"] == 3 * len(research)
    flags = research.set_index(["source", "signal_hash"])["feature_history_crosses_major_gap"].to_dict()
    # Use the same named, potentially overlapping session definitions as Backtest.
    definitions = (REPO / "src/lib/ict-sessions.ts").read_text(encoding="utf-8")
    sessions = []
    for line in definitions.splitlines():
        if 'clock: "NEW_YORK"' not in line or 'id: "' not in line:
            continue
        label = re.search(r'label: "([^"]+)"', line).group(1)
        times = re.findall(r'(?:start|end)Minute: minutes\((\d+)(?:,\s*(\d+))?\)', line)
        if len(times) == 2:
            sessions.append((label, *[int(h)*60 + int(m or 0) for h,m in times]))
    records = []
    for row in raw.to_dict("records"):
        stamp = pd.Timestamp(row["detected_at"]).tz_convert("America/New_York")
        minute = stamp.hour * 60 + stamp.minute
        named = [label for label, start, end in sessions if (start <= minute < end if end > start else minute >= start or minute < end)]
        record = {k: row.get(k) for k in ["source", "ticker", "signal_hash", "direction", "target_no", "state", "realized_r", "detected_at", "filled_at", "filled_price", "stoploss", "target_price", "close_ts", "close_price", "hold_hours", "s16_variant", "net_r_cost_1pip", "net_r_cost_2pip", "net_r_cost_3pip"]}
        record.update(asset="metals" if row["ticker"] in ("^XAUUSD", "^XAGUSD") else "forex", date=stamp.strftime("%Y-%m-%d"), hour=stamp.hour, sessions=named, gap_review=bool(flags[(row["source"], row["signal_hash"])]))
        records.append(record)
    DEST.mkdir(parents=True, exist_ok=True)
    evidence = {f"{r.source}:{r.signal_hash}": json.loads(r.strategy_json) for r in research.itertuples()}
    (DEST / "evidence.json").write_text(json.dumps(evidence, separators=(",", ":")), encoding="utf-8")
    inventory = []
    for item in json.loads((SOURCE / "run_status.json").read_text())["finished"]:
        inventory.append({k:item[k] for k in ("source","symbol","signals","bars_scanned","status")})
    review_path = REPO / "artifacts/s16-forex-review/review.json"
    review = json.loads(review_path.read_text(encoding="utf-8")) if review_path.exists() else None
    payload = dict(rows=records, validation=validation, review=review, contract=manifest["contract"], coverage=pd.read_csv(SOURCE / "coverage_audit.csv").to_dict("records"), inventory=inventory, cutoff=manifest["arguments"]["end"])
    # pandas normalizes missing numeric values to null, not invalid JS NaN tokens.
    clean = json.loads(pd.Series(payload).to_json(date_format="iso", default_handler=str))
    serialized = json.dumps(clean, separators=(",", ":"), ensure_ascii=False).replace("<", "\\u003c")
    html = (REPO / "scripts/s16-forex-report.html").read_text(encoding="utf-8").replace("__PAYLOAD__", serialized)
    (DEST / "index.html").write_text(html, encoding="utf-8")
    files = ["forex_s16_currency_pairs_research_dataset.csv", "forex_s16_research_dataset_audited.csv", "all_target_outcomes.csv", "currency_pair_target_summary.csv", "coverage_audit.csv", "final_validation.json", "major_history_gaps.json", "targets_report.md"]
    for filename in files:
        shutil.copy2(SOURCE / filename, DEST / filename)
    # Publish only the methodological contract and engine fingerprints; omit machine paths.
    (DEST / "methodology.json").write_text(json.dumps(dict(contract=manifest["contract"], cutoff=manifest["arguments"]["end"], engine_sha256=manifest["engine_sha256"]), indent=2), encoding="utf-8")
    audit = dict(status="passed", signals=len(research), currency_pair_signals=int((research.asset_class=="currency_pair").sum()), target_outcomes=len(raw), source=str(SOURCE), published=str(DEST), files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in DEST.iterdir() if p.is_file()})
    (DEST / "publication_audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
    print(json.dumps({k:v for k,v in audit.items() if k!="files"}, indent=2))


if __name__ == "__main__":
    main()
