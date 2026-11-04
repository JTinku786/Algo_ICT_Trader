"""Final reconciliation and explicit raw-history gap flags; no DB mutations."""
import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd


def audit(root):
    run=json.loads((root/"run_status.json").read_text())
    target=json.loads((root/"targets_status.json").read_text())
    assert run["status"]==target["status"]=="done", "backtest or target reporting remains incomplete"
    assert len(run["finished"])==target["enriched_tasks"]==run["tasks"]==24
    manifest=json.loads((root/"manifest.json").read_text())
    code=Path(__file__).resolve().parent
    for name,expected in manifest["engine_sha256"].items():
        assert hashlib.sha256((code/name).read_bytes()).hexdigest()==expected, f"engine changed: {name}"
    gate=json.loads((root/"mirror_gate.json").read_text())
    assert gate["status"]=="passed" and gate["outcomes_read"] is False
    assert hashlib.sha256((code/"detector_updated.py").read_bytes()).hexdigest()==gate["detector_sha256"]
    assert hashlib.sha256((code/"replay_updated.py").read_bytes()).hexdigest()==gate["replay_sha256"]
    prereg=json.loads((root/"preregistration.json").read_text())
    assert prereg["target_results_not_inspected"] is True
    for name,expected in prereg["files"].items():
        assert hashlib.sha256((code/name).read_bytes()).hexdigest()==expected
    gaps=[]
    coverage=[]
    rows=[]
    n_signals=0
    for task in run["finished"]:
        assert task["status"]=="done"
        folder=root/task["source"]/task["symbol"].lstrip("^")
        c=json.loads((folder/"coverage.json").read_text())
        bars=pd.read_parquet(folder/"reconstructed_5m.parquet",columns=[]).index
        weekly=pd.read_parquet(folder/"reconstructed_weekly.parquet",columns=[]).index
        assert len(bars)==task["bars_scanned"]==task["total_bars"]
        major=[]
        for i in (bars.to_series().diff()>pd.Timedelta(days=7)).to_numpy().nonzero()[0]:
            start=bars[i-1]
            end=bars[i]-pd.Timedelta(minutes=5)
            gap=dict(source=task["source"],symbol=task["symbol"],last_observed_close=start.isoformat(),next_observed_open=end.isoformat(),gap_days=(end-start).total_seconds()/86400)
            gaps.append(gap)
            major.append((start,end))
        coverage.append(dict(source=task["source"],symbol=task["symbol"],bars=len(bars),first_open=c["first_open"],last_close=c["last_close"],major_gaps_over_7_days=len(major),invalid_ohlc_excluded=c["invalid_ohlc_excluded"],incomplete_5m_excluded=c["incomplete_5m_excluded"],off_session_excluded=c["off_session_excluded"]))
        signals=[json.loads(s) for s in (folder/"signals.jsonl").read_text().splitlines() if s]
        assert len(signals)==task["signals"]
        if not signals:
            continue
        base=pd.read_csv(folder/"trades.csv").set_index("signal_hash")
        outcomes=pd.read_csv(folder/"target_outcomes.csv")
        assert len(base)==len(signals) and len(outcomes)==3*len(signals)
        assert not outcomes.duplicated(["signal_hash","target_no"]).any()
        t2=outcomes[outcomes.target_no==2].set_index("signal_hash")
        assert (t2.loc[base.index,"state"]==base.state).all()
        for signal in signals:
            key=signal["signal_hash"]
            assert signal["strategy_json"]["no_lookahead"]["passed"] is True
            det=pd.Timestamp(signal["replay_provenance"]["detected_at"])
            fill=base.loc[key,"filled_at"]
            if pd.notna(fill):
                assert pd.Timestamp(fill)>=det
            if pd.notna(base.loc[key,"realized_r"]):
                assert abs(t2.loc[key,"realized_r"]-base.loc[key,"realized_r"])<1e-9
            for t in (1,2,3):
                o=outcomes[(outcomes.signal_hash==key)&(outcomes.target_no==t)].iloc[0]
                assert abs(float(o.target_price)-float(signal[f"target_{t}"]))<1e-8
                json.loads(o.strategy_json)
            end=weekly.searchsorted(det.normalize(),side="right")
            first=weekly[max(0,end-160)] if end else det
            crossing=any(first<gap_end<=det for _,gap_end in major)
            rows.append(dict(source=task["source"],signal_hash=key,feature_history_crosses_major_gap=crossing,
                asset_class="precious_metal" if any(x in task["symbol"] for x in ("XAU","XAG")) else "currency_pair"))
        n_signals+=len(signals)
    data=pd.read_csv(root/"forex_s16_research_dataset.csv")
    detected=pd.to_datetime(data["detected_at"],utc=True).dt.tz_convert("America/New_York")
    assert (((detected.dt.hour>=2)&(detected.dt.hour<5))|((detected.dt.hour>=7)&(detected.dt.hour<10))).all()
    trading_dates=(detected.dt.tz_localize(None)-pd.Timedelta(hours=17)).dt.date
    assert not data.assign(trading_date=trading_dates).duplicated(["source","ticker","trading_date"]).any()
    for s in data.strategy_json.map(json.loads):
        assert s["sweep"]["close_back_inside"] is True
        assert s["research_revision"]["id"]=="S16-FX-R1"
        assert s["research_revision"]["buffer_pips"]==2

    assert len(data)==n_signals and target["outcome_rows"]==3*n_signals
    assert not data.duplicated(["source","signal_hash"]).any()
    for t in ("t1","t2","t3"):
        known=data[t+"_label_known_at"].notna()
        assert (pd.to_datetime(data.loc[known,t+"_label_known_at"],utc=True)>=pd.to_datetime(data.loc[known,"features_asof_at"],utc=True)).all()
        for state,label in (("CLOSED_TP",1),("CLOSED_SL",0)):
            selected=data[t+"_state"].eq(state)
            assert data.loc[selected,t+"_target_before_stop_label"].eq(label).all()
        unknown=~data[t+"_state"].isin(["CLOSED_TP","CLOSED_SL"])
        assert data.loc[unknown,t+"_target_before_stop_label"].isna().all()
    data=data.merge(pd.DataFrame(rows),on=["source","signal_hash"],validate="one_to_one")
    data.to_csv(root/"forex_s16_research_dataset_audited.csv",index=False)
    data[data.asset_class.eq("currency_pair")].to_csv(root/"forex_s16_currency_pairs_research_dataset.csv",index=False)
    target_data=pd.read_csv(root/"all_target_outcomes.csv")
    fx=target_data[~target_data.ticker.str.contains("XAU|XAG",regex=True)]
    fx_summary=[]
    for (source,target_no),f in fx.groupby(["source","target_no"]):
        values=f.realized_r.dropna().astype(float)
        losses=-values.clip(upper=0).sum()
        decisive=f.state.isin(["CLOSED_TP","CLOSED_SL"]).sum()
        fx_summary.append(dict(source=source,target=f"T{target_no}",signals=len(f),closed=len(values),
            target_win_pct=100*f.state.eq("CLOSED_TP").sum()/decisive if decisive else None,
            gross_r=float(values.sum()),expectancy_r=float(values.mean()) if len(values) else None,
            profit_factor=float(values.clip(lower=0).sum()/losses) if losses else None))
    pd.DataFrame(fx_summary).to_csv(root/"currency_pair_target_summary.csv",index=False)
    pd.DataFrame(coverage).to_csv(root/"coverage_audit.csv",index=False)
    (root/"major_history_gaps.json").write_text(json.dumps(gaps,indent=2),encoding="utf-8")
    result=dict(status="passed",research_revision="S16-FX-R1",classification="LOCAL_ADAPTATION",mirror_gate="passed before outcome generation",source_instrument_runs=24,signals=n_signals,target_outcomes=3*n_signals,
        currency_pair_signals=int(data.asset_class.eq("currency_pair").sum()),
        major_source_history_gaps=len(gaps),signals_requiring_gap_context_review=int(data.feature_history_crosses_major_gap.sum()),
        checks=["all tasks complete","engine hashes unchanged","blind direction and scale mirror gate verified before replay","three original targets per signal","T2 reconciles with base replay","fills after detection","unique source/signal keys","complete strategy JSON","causal label availability","unknown outcomes remain unlabeled"])
    (root/"final_validation.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
    report=root/"targets_report.md"
    marker="\n## Final reconciliation and coverage\n"
    text=report.read_text(encoding="utf-8").split(marker)[0]
    text+=marker+f"\nAll 24 runs passed reconciliation: {n_signals} signals and {3*n_signals} independent target outcomes. "
    text+=f"The coverage audit found {len(gaps)} source gaps longer than seven days; {result['signals_requiring_gap_context_review']} signals have feature history crossing such a gap and require review before modeling. "
    text+="Missing raw candles were not synthesized. The configured forex universe includes currency pairs and precious metals; a separate currency-pair-only research export is provided.\n"
    text+="\n| Source | First available open | Last available close | Valid 5m bars scanned |\n|---|---|---|---:|\n"
    for source,g in pd.DataFrame(coverage).groupby("source"):
        first=pd.to_datetime(g.first_open,utc=True).min().tz_convert("America/New_York").isoformat()
        last=pd.to_datetime(g.last_close,utc=True).max().tz_convert("America/New_York").isoformat()
        text+=f"| {source} | {first} | {last} | {g.bars.sum()} |\n"
    text+="\n### Currency pairs only\n\n| Source | Target | Signals | Closed | Target win % | Gross R | Mean R | PF |\n|---|---|---:|---:|---:|---:|---:|---:|\n"
    fmt=lambda v: "—" if v is None else f"{v:.2f}"
    for s in fx_summary:
        text+=f"| {s['source']} | {s['target']} | {s['signals']} | {s['closed']} | {fmt(s['target_win_pct'])} | {fmt(s['gross_r'])} | {fmt(s['expectancy_r'])} | {fmt(s['profit_factor'])} |\n"
    report.write_text(text,encoding="utf-8")
    print(json.dumps(result,indent=2))


if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("root");a=p.parse_args();audit(Path(a.root).resolve())
