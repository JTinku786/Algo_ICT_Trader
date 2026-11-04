"""Read-only, source-isolated S16 replay. Never imports a broker or writes DB rows.

The live S16 detector and shared updated exit engine are reused unchanged.
Inputs differ from the US/India live feed: forex HTFs are reconstructed from
each 5m source separately, and only completed HTF candles supply bias.
Artifacts contain full signal JSON, original targets, detection/fill times,
coverage counts, engine hashes, and an explicit research execution contract.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import time
import traceback

import numpy as np
import pandas as pd
import psycopg2

import sys
BASE = Path(r"C:/Users/saite/Desktop/ICT_Automation/Backtesting_ICT_2017")
sys.path.append(str(BASE))
from config import build_config, fallback_db_config, load_reference_module
from data_access import normalize_candles
from order_monitoring_updated import _first_exit_from_candles, _filled_price_sanity
import detector_updated as s16

TZ = "America/New_York"
HERE = BASE
REVISION_DIR = Path(__file__).resolve().parent
COLS = ["open", "high", "low", "close", "volume"]
LOOKBACK = {"5m": 288, "15m": 96, "30m": 120, "1h": 120, "daily": 220, "weekly": 160}
CONTRACT = {
    "strategy": "S16-FX-R1, LOCAL_ADAPTATION; two-pip buffer, strict same-candle reclaim",
    "actionable_target": 2,
    "classification": "LOCAL_ADAPTATION, pre-registered research; not live S16 parity",
    "entry_windows": "02:00 <= detection < 05:00 and 07:00 <= detection < 10:00 America/New_York",
    "pip_contract": "JPY quotes 0.01, other configured currency pairs 0.0001; two-pip price_buffer; fractional-pip target identity",
    "blind_gate": "BUY/SELL and quote-scale mirror tests must pass before simulation",
    "candidate_deduplication": "accepted identities only; rejected candidates are re-evaluated on later scans",
    "database": "read-only; no live tables, frozen tables, alerts, or broker writes",
    "sources": "isolated; no warmup or candle stitching between sources",
    "time_labels": "input 5m timestamps label opens; all detector frames label availability at close",
    "intraday": "15m/30m/1h derived from source 5m; missing constituent bars exclude bucket",
    "daily": "New York 17:00 boundary; observed shortened sessions retained and flagged",
    "weekly": "Sunday 17:00 to Friday 17:00 New York; no current partial week",
    "bias": "reference structure/bias; latest completed D/W at detection including the 17:00 close",
    "lookbacks": LOOKBACK,
    "ltf_date_filter": "5m/15m from the current New York 17:00 trading-day start; 288/96-bar bounds",
    "entry": "first 5m open at or after first detection, never retrospective retest fill",
    "stop_target": "shared order_monitoring_updated._first_exit_from_candles; close-confirmed stop, touch T2",
    "time_stop": "shared updated engine 10 trading dates (research policy)",
    "daily_limit": "first accepted signal per New York 17:00 trading day per symbol; S16-only",
    "off_session": "Saturday, Friday after 17:00, Sunday before 17:00 excluded and counted",
    "costs": "gross OHLC R; sensitivity in pips; no observed bid/ask or broker fills",
    "parity_limit": "forex is not enabled in live S16 routing; reconstructed HTFs and 5m fills are research inputs",
}


def atomic_json(path: Path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, default=str, indent=2, allow_nan=False), encoding="utf-8")
    for attempt in range(50):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            if attempt == 49: raise
            time.sleep(.1)


def connect_readonly():
    conn = psycopg2.connect(**dict(fallback_db_config(), connect_timeout=15))
    conn.set_session(readonly=True, autocommit=True)
    with conn.cursor() as cur:
        cur.execute("SET statement_timeout = '120s'")
    return conn


def reconstruct(raw: pd.DataFrame):
    """Return frames with CLOSE/availability indices, plus coverage metadata."""
    first, last = raw.index[0], raw.index[-1] + pd.Timedelta(minutes=5)
    frames = {"5m": raw.copy()}
    frames["5m"].index = raw.index + pd.Timedelta(minutes=5)
    coverage = {}
    for name, n in (("15m", 3), ("30m", 6), ("1h", 12)):
        r = raw.resample(f"{n * 5}min", label="left", closed="left")
        f = r.agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
        count = r["close"].count()
        end = f.index + pd.Timedelta(minutes=5 * n)
        good = (count == n) & (f.index >= first) & (end <= last)
        coverage[name] = {"retained": int(good.sum()), "incomplete_nonempty": int(((count > 0) & ~good).sum())}
        f = f.loc[good, COLS]
        f.index = end[good]
        frames[name] = f
    # Group in wall-clock local time, not UTC 24h durations across DST.
    wall = raw.index.tz_localize(None)
    shifted = wall - pd.Timedelta(hours=17)
    starts_naive = shifted.normalize() + pd.Timedelta(hours=17)
    day_end = (starts_naive + pd.Timedelta(days=1)).tz_localize(TZ)
    day_start = starts_naive.tz_localize(TZ)
    f = raw.groupby(day_end).agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
    counts = raw.groupby(day_end)["close"].count()
    good = (f.index <= last) & (f.index > first)
    # The first source session cannot be used if its opening history is absent.
    first_end = day_end[0]
    if day_start[0] < first:
        good &= f.index != first_end
    frames["daily"] = f.loc[good, COLS]
    expected = pd.Series([(ts - (ts.tz_localize(None) - pd.Timedelta(days=1)).tz_localize(TZ)).total_seconds() / 300 for ts in f.index], index=f.index)
    coverage["daily"] = {"retained": int(good.sum()), "shortened_or_gapped_sessions": int(((counts < expected) & good).sum())}
    # A Monday trading date starts Sunday 17:00; weekly availability is Friday 17:00.
    d = day_end.tz_localize(None).normalize()
    monday = d - pd.to_timedelta(d.weekday, unit="D")
    week_end = (monday + pd.Timedelta(days=4, hours=17)).tz_localize(TZ)
    wf = raw.groupby(week_end).agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
    week_start = (wf.index.tz_localize(None) - pd.Timedelta(days=5)).tz_localize(TZ)
    wg = (wf.index <= last) & (week_start >= first)
    frames["weekly"] = wf.loc[wg, COLS]
    coverage["weekly"] = {"retained": int(wg.sum())}
    # Preserve the source and number of observed constituents in exported bars.
    return frames, coverage


def reference_bias(frame: pd.DataFrame, tf: str):
    if frame.empty:
        return "neutral"
    ref = load_reference_module()
    highs, lows = ref.detect_swings(tf, frame, TZ, window=3)
    events = ref.detect_structure_events(tf, frame, highs, lows, TZ)
    progression = ref.derive_swing_progression(highs, lows)
    return ref.derive_bias(events, progression, frame.iloc[-1].to_dict())


def validate_live_signal(row):
    sj = row["strategy_json"]
    return (
        row.get("s16_variant") in {"S16_FVG_ENTRY", "S16_OB_ENTRY", "S16_FVG_OB_OVERLAP"}
        and sj.get("entry_retest", {}).get("passed") is True
        and sj.get("no_lookahead", {}).get("passed") is True
        and sj.get("execution_plan", {}).get("passed") is True
        and row.get("target_1") is not None and row.get("target_2") is not None
    )


def next_market_open(stamp):
    nxt = stamp + pd.Timedelta(minutes=5)
    if nxt.weekday() == 4 and nxt.hour == 17 and nxt.minute == 0:
        return (nxt.tz_localize(None) + pd.Timedelta(days=2)).tz_localize(TZ)
    return nxt


def simulate(row, raw, cfg, detection, source):
    record = {k: row.get(k) for k in ["signal_hash", "ticker", "direction", "entry_datetime", "entry_price", "stoploss", "target_1", "target_2", "target_3", "s16_variant"]}
    record.update(source=source, detected_at=detection.isoformat(), state="OPEN", realized_r=None)
    position = raw.index.searchsorted(detection, side="left")
    if position >= len(raw):
        record["state"] = "UNFILLED_END_OF_DATA"
        return record
    stamp = raw.index[position]
    fill = float(raw.iloc[position]["open"])
    record.update(filled_at=stamp.isoformat(), filled_price=fill, fill_delay_minutes=(stamp-detection).total_seconds()/60)
    # A gap in stored bars cannot support a fictional fill at the next observed bar.
    if stamp != detection:
        record.update(state="MISSED_DATA_GAP", close_reason="no_bar_at_next_executable_open")
        return record
    # Live maps original Target 2 to its actionable TP1 slot.
    missed = _filled_price_sanity(row["direction"], fill, float(row["stoploss"]), float(row["target_2"]))
    if missed:
        record.update(state="CLOSED_MISSED_ENTRY", close_reason=missed)
        return record
    risk = abs(fill - float(row["stoploss"]))
    record["risk_price"] = risk
    if risk <= 0:
        record.update(state="CLOSED_MISSED_ENTRY", close_reason="zero_risk")
        return record
    # Bound materialization, while retaining enough trading dates for the shared cap.
    end = raw.index.searchsorted(stamp + pd.Timedelta(days=25), side="right")
    window = raw.iloc[position:end]
    outcome = {"filled_at": stamp, "direction": row["direction"], "stoploss": row["stoploss"], "target_price": row["target_2"], "strategy_id": "S16"}
    close = _first_exit_from_candles(cfg, outcome, window)
    if close:
        record.update(state=close["state"], close_reason=close["close_reason"], close_ts=str(close["close_ts"]), close_price=float(close["close_price"]))
        observed = window.loc[window.index <= pd.Timestamp(close["close_ts"])]
        gaps = [(a,b) for a,b in zip(observed.index[:-1], observed.index[1:]) if b != next_market_open(a)]
        if gaps:
            record.update(observed_path_state=record["state"], state="UNRESOLVED_DATA_GAP", execution_gaps=len(gaps), first_execution_gap=str(gaps[0]))
            return record
        sign = 1 if row["direction"] == "BUY" else -1
        record["realized_r"] = sign * (record["close_price"] - fill) / risk
        record["hold_hours"] = (pd.Timestamp(close["close_ts"]) - stamp).total_seconds() / 3600
        pip = .01 if "JPY" in row["ticker"] else (.0001 if not any(x in row["ticker"] for x in ("XAU", "XAG")) else None)
        if pip:
            for pips in (1, 2, 3):
                record[f"net_r_cost_{pips}pip"] = record["realized_r"] - pips * pip / risk
        else:
            record["cost_sensitivity_note"] = "metals excluded from FX pip convention"
    return record


def replay(task):
    source, symbol, root_s, start, end = task
    root = Path(root_s) / source / symbol.lstrip("^")
    root.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    progress = {"source": source, "symbol": symbol, "status": "loading", "bars_scanned": 0, "signals": 0}
    atomic_json(root / "progress.json", progress)
    try:
        rawpath = root / "source_5m.parquet"
        if rawpath.exists():
            raw = pd.read_parquet(rawpath)
        else:
            c = connect_readonly()
            try:
                query = """SELECT candle_ts AS ts, open_price AS open, high_price AS high,
                    low_price AS low, close_price AS close, volume, bar_count
                    FROM historical_candles_5m WHERE market='forex' AND source=%s
                    AND yahoo_symbol=%s AND candle_ts >= %s::timestamptz
                    AND candle_ts + interval '5 minutes' <= %s::timestamptz ORDER BY candle_ts"""
                raw = pd.read_sql_query(query, c, params=(source, symbol, start, end))
            finally:
                c.close()
            raw = normalize_candles(raw, TZ)
            raw.to_parquet(rawpath)
        if raw.empty:
            raise RuntimeError("no source candles")
        valid = (raw["low"] <= raw[["open", "close"]].min(axis=1)) & (raw["high"] >= raw[["open", "close"]].max(axis=1)) & (raw["low"] > 0)
        bad_count = int((~valid).sum())
        incomplete5 = 0
        if source == "derived_1m":
            complete = raw["bar_count"].eq(5)
            incomplete5 = int((~complete).sum())
            valid &= complete
        raw = raw.loc[valid]
        active = (raw.index.weekday < 4) | ((raw.index.weekday == 4) & (raw.index.hour < 17)) | ((raw.index.weekday == 6) & (raw.index.hour >= 17))
        off_session = int((~active).sum())
        raw = raw.loc[active]
        frames, coverage = reconstruct(raw)
        for name, f in frames.items():
            f.to_parquet(root / f"reconstructed_{name}.parquet")
        atomic_json(root / "coverage.json", {"source": source, "symbol": symbol, "source_rows": len(raw), "invalid_ohlc_excluded": bad_count, "incomplete_5m_excluded": incomplete5, "off_session_excluded": off_session, "first_open": raw.index[0], "last_close": raw.index[-1]+pd.Timedelta(minutes=5), "timeframes": coverage})
        cfg = build_config("forex", start_date=str(raw.index[0].date()), end_date=str(raw.index[-1].date()), workers=1, dry_run=True)
        all5 = frames["5m"]
        # Precompute search positions to slice by integer offset, never scan future data.
        positions = {tf: f.index.searchsorted(all5.index, side="right") for tf, f in frames.items() if tf != "5m"}
        session_start = ((all5.index.tz_localize(None)-pd.Timedelta(hours=17)).normalize()+pd.Timedelta(hours=17)).tz_localize(TZ)
        bias_positions = {tf: frames[tf].index.searchsorted(all5.index, side="right") for tf in ("weekly", "daily")}
        day_start_5m = all5.index.searchsorted(session_start, side="right")
        day_start_15m = frames["15m"].index.searchsorted(session_start, side="right")
        last_bias_key = None
        wb = db = "neutral"
        rows = []
        trades = []
        seen = set()
        locked_days = set()
        bias_cache = {}
        warmup_skipped = bias_skipped = filtered = 0
        checkpoint_path = root / "checkpoint.json"
        start_bar = 0
        if checkpoint_path.exists():
            cp = json.loads(checkpoint_path.read_text())
            start_bar = int(cp["next_bar"])
            rows, trades = cp["rows"], cp["trades"]
            seen = set(cp["seen"])
            locked_days = {pd.Timestamp(x).date() for x in cp["locked_days"]}
            warmup_skipped, bias_skipped, filtered = cp["counters"]
        # Resume complete source-symbol tasks, not partial bar state.
        for i, ts in enumerate(all5.index):
            if i < start_bar:
                continue
            if i % 2000 == 0:
                progress.update(status="running", bars_scanned=i, total_bars=len(all5), signals=len(rows), as_of=str(ts), seconds=round(time.perf_counter()-started, 1))
                atomic_json(root / "progress.json", progress)
                atomic_json(checkpoint_path, {"next_bar":i,"rows":rows,"trades":trades,"seen":sorted(seen),"locked_days":sorted(locked_days),"counters":[warmup_skipped,bias_skipped,filtered]})
            if not ((2 <= ts.hour < 5) or (7 <= ts.hour < 10)):
                continue
            trading_day = session_start[i].date()
            if trading_day in locked_days:
                continue
            wi, di = bias_positions["weekly"][i], bias_positions["daily"][i]
            if i < s16.ATR_PERIOD or wi < 1 or di < 1 or positions["1h"][i] < 5 or positions["15m"][i] < 5:
                warmup_skipped += 1
                continue
            key = (int(wi), int(di))
            if key != last_bias_key:
                vals = []
                for tf, p in (("weekly", wi), ("daily", di)):
                    cache_key = (tf, int(p))
                    if cache_key not in bias_cache:
                        bias_cache[cache_key] = reference_bias(frames[tf].iloc[max(0,p-LOOKBACK[tf]):p], tf)
                    vals.append(bias_cache[cache_key])
                wb, db = vals
                last_bias_key = key
            if s16.resolve_bias(wb, db, "strict").direction not in ("BUY", "SELL"):
                bias_skipped += 1
                continue
            sliced = {"5m": all5.iloc[max(int(day_start_5m[i]),i+1-LOOKBACK["5m"]):i+1]}
            for tf in ("15m", "1h", "daily", "weekly"):
                p = positions[tf][i]
                lower = max(0,p-LOOKBACK[tf])
                if tf == "15m":
                    lower = max(lower, int(day_start_15m[i]))
                sliced[tf] = frames[tf].iloc[lower:p]
            row = s16.build_s16_signal(symbol=symbol, market="forex", source_market="forex", run_date=str(trading_day + pd.Timedelta(days=1)), as_of_ts=ts, frames=sliced, weekly_bias=wb, daily_bias=db, conflict_mode="strict")
            if row is None or row["signal_hash"] in seen:
                continue
            if not validate_live_signal(row):
                filtered += 1
                continue
            seen.add(row["signal_hash"])
            # Live claims its daily slot before creating/attempting an order.
            row["replay_provenance"] = {"source": source, "detected_at": ts.isoformat(), "weekly_bias": wb, "daily_bias": db, "contract": CONTRACT}
            rows.append(row)
            trade = simulate(row, raw, cfg, ts, source)
            trades.append(trade)
            locked_days.add(trading_day)
        with (root / "signals.jsonl").open("w", encoding="utf-8") as file:
            for row in rows:
                file.write(json.dumps(row, default=str) + "\n")
        signal_json = {r["signal_hash"]: json.dumps(r["strategy_json"], default=str) for r in rows}
        exported = [{**t,"strategy_json":signal_json[t["signal_hash"]]} for t in trades]
        pd.DataFrame(exported).to_csv(root / "trades.csv", index=False)
        r = [t["realized_r"] for t in trades if t.get("realized_r") is not None]
        wins = sum(v for v in r if v > 0)
        losses = -sum(v for v in r if v < 0)
        states = pd.Series([t["state"] for t in trades], dtype=str).value_counts().to_dict()
        progress.update(status="done", bars_scanned=len(all5), total_bars=len(all5), signals=len(rows), states=states, warmup_skipped=warmup_skipped, bias_skipped=bias_skipped, live_validation_rejected=filtered, closed=len(r), gross_r=sum(r), expectancy_r=float(np.mean(r)) if r else None, profit_factor=wins/losses if losses else None, positive_close_pct=100*sum(v>0 for v in r)/len(r) if r else None, seconds=round(time.perf_counter()-started, 1))
        atomic_json(root / "progress.json", progress)
        return progress
    except Exception as exc:
        progress.update(status="error", error=str(exc), traceback=traceback.format_exc(), seconds=round(time.perf_counter()-started, 1))
        atomic_json(root / "progress.json", progress)
        return progress


def write_report(root: Path, results, state):
    chunks = []
    for r in results:
        path = root / r["source"] / r["symbol"].lstrip("^") / "trades.csv"
        if r["status"] == "done" and path.exists() and path.stat().st_size > 2:
            chunks.append(pd.read_csv(path))
    trades = pd.concat(chunks, ignore_index=True) if chunks else pd.DataFrame()
    metrics = []
    if not trades.empty:
        trades.to_csv(root / "all_trades.csv", index=False)
        for source, group in trades.groupby("source"):
            for symbol, frame in [("ALL", group), *list(group.groupby("ticker"))]:
                closed = frame.loc[frame["realized_r"].notna()].copy()
                values = closed["realized_r"].astype(float)
                gain = values.clip(lower=0).sum()
                loss = -values.clip(upper=0).sum()
                decisive = int(frame["state"].isin(["CLOSED_TP","CLOSED_SL"]).sum())
                metrics.append({"source":source,"symbol":symbol,"signals":len(frame),"closed":len(closed),
                    "tp2_wins":int((frame["state"]=="CLOSED_TP").sum()),
                    "stops":int((frame["state"]=="CLOSED_SL").sum()),
                    "time_stops":int((frame["state"]=="CLOSED_EXPIRED").sum()),
                    "open":int((frame["state"]=="OPEN").sum()),
                    "data_gap_unresolved":int((frame["state"]=="UNRESOLVED_DATA_GAP").sum()),
                    "missed":int(frame["state"].isin(["CLOSED_MISSED_ENTRY","MISSED_DATA_GAP","UNFILLED_END_OF_DATA"]).sum()),
                    "tp2_win_pct":100*int((frame["state"]=="CLOSED_TP").sum())/decisive if decisive else None,
                    "gross_r":float(values.sum()),"expectancy_r":float(values.mean()) if len(values) else None,
                    "profit_factor":float(gain/loss) if loss else None})
    pd.DataFrame(metrics).to_csv(root / "summary.csv", index=False)
    lines = ["# S16 forex replay", "", f"Status: **{state}**. Completed source/instrument tasks: {sum(r['status']=='done' for r in results)}.", "", "Results use the unchanged live S16 signal detector and original Target 2, on reconstructed source-isolated forex candles. These are gross candle replay results, not broker returns or live forex deployment.", "", "| Source | Instrument | Signals | Closed | T2 win rate | Gross R | Mean R | PF |", "|---|---|---:|---:|---:|---:|---:|---:|"]
    for m in metrics:
        f = lambda v: "â€”" if v is None else f"{v:.2f}"
        lines.append(f"| {m['source']} | {m['symbol']} | {m['signals']} | {m['closed']} | {f(m['tp2_win_pct'])}% | {f(m['gross_r'])} | {f(m['expectancy_r'])} | {f(m['profit_factor'])} |")
    lines.extend(["", "T2 win rate = target exits / (target exits + stop exits). Mean R and gross R include time-stop closes. Missed entries, unresolved data gaps, and open trades are excluded from realized metrics. Metals retain their original instrument price units; FX pip sensitivities exclude metals.", "", "## Research contract", ""])
    lines.extend(f"- **{k}:** {v}" for k,v in CONTRACT.items())
    errors = [r for r in results if r["status"] != "done"]
    if errors:
        lines.extend(["", "## Task errors", ""] + [f"- {r['source']} {r['symbol']}: {r.get('error','unknown')}" for r in errors])
    (root / "report.md").write_text("\n".join(lines)+"\n", encoding="utf-8")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--output", required=True)
    p.add_argument("--start", default="2017-01-01T00:00:00-05:00")
    p.add_argument("--end", default="2026-10-21T00:00:00-04:00")
    p.add_argument("--sources", default="barchart,derived_1m")
    p.add_argument("--symbols")
    p.add_argument("--workers", type=int, default=4)
    args = p.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    engine_paths = [HERE/"s16_strategy.py", HERE/"order_monitoring_updated.py", HERE/"exit_rules.py", Path(__file__), REVISION_DIR/"detector_updated.py"]
    hashes = {str(path.resolve()): hashlib.sha256(path.read_bytes()).hexdigest() for path in engine_paths}
    gate_path = root / "mirror_gate.json"
    if not gate_path.exists(): raise RuntimeError("Blind mirror gate is required before replay")
    gate = json.loads(gate_path.read_text())
    if gate.get("status") != "passed": raise RuntimeError("Blind mirror gate did not pass")
    if gate["detector_sha256"] != hashes[str((REVISION_DIR/"detector_updated.py").resolve())]: raise RuntimeError("Detector changed after mirror gate")
    if gate["replay_sha256"] != hashes[str(Path(__file__).resolve())]: raise RuntimeError("Replay changed after mirror gate")
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest["engine_sha256"] != hashes:
            raise RuntimeError("Engine changed since this output snapshot; choose a new output directory")
        for key in ("start","sources","symbols"):
            if manifest["arguments"][key] != getattr(args,key):
                raise RuntimeError(f"Resume argument changed: {key}")
        args.end = manifest["arguments"]["end"]
    else:
        args.end = min(pd.Timestamp(args.end), pd.Timestamp.now(tz=TZ)).isoformat()
        atomic_json(manifest_path, {"contract": CONTRACT, "arguments": vars(args), "engine_sha256": hashes, "started_at": pd.Timestamp.now(tz=TZ)})
    inventory_path = root / "input_inventory.json"
    if inventory_path.exists():
        inventory = json.loads(inventory_path.read_text())
        pairs = sorted([(item["source"], item["symbol"]) for item in inventory], key=lambda x: (x[0] != "derived_1m", x[1]))
        assert len(pairs) == 24
    else:
        raise RuntimeError("This revision requires the frozen input inventory")
    if args.symbols:
        symbols = {x if x.startswith("^") else "^"+x for x in args.symbols.split(",")}
        pairs = [(s, t) for s,t in pairs if t in symbols]
    tasks = [(s,t,str(root),args.start,args.end) for s,t in pairs]
    results = []
    pending = []
    for task in tasks:
        progress_path = root / task[0] / task[1].lstrip("^") / "progress.json"
        if progress_path.exists() and (prior := json.loads(progress_path.read_text())).get("status") == "done":
            results.append(prior)
        else:
            pending.append(task)
    atomic_json(root / "run_status.json", {"status":"running", "tasks":len(tasks), "resumed_done":len(results)})
    print(f"S16 replay tasks={len(tasks)} pending={len(pending)} workers={args.workers} output={root}", flush=True)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(replay, task): task for task in pending}
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            print(json.dumps(result, default=str), flush=True)
            atomic_json(root / "run_status.json", {"status":"running", "tasks":len(tasks), "finished":results})
            write_report(root, results, "running")
    state = "done" if all(x["status"]=="done" for x in results) else "failed"
    atomic_json(root / "run_status.json", {"status":state,"tasks":len(tasks),"finished":results,"finished_at":pd.Timestamp.now(tz=TZ)})
    write_report(root, results, state)
    print(f"S16 replay {state}", flush=True)


if __name__ == "__main__":
    main()
