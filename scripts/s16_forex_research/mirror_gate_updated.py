"""Blind detector tests: no target outcomes, trade CSVs, or realized P&L are read."""
from dataclasses import asdict
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

import detector_updated as detector

BASELINE = Path(r"C:\Users\saite\Desktop\ICT_Automation\artifacts\s16_forex_live_replay_20261020_v2")
OUT = Path(__file__).resolve().parents[2] / "artifacts/s16_forex_r1_blind"


def transform(frame, *, anchor=None, scale=None):
    f = frame.copy()
    if anchor is not None:
        f["open"] = anchor-frame.open
        f["close"] = anchor-frame.close
        f["high"] = anchor-frame.low
        f["low"] = anchor-frame.high
    else:
        f[["open", "high", "low", "close"]] *= scale
    return f


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    checks, failures, positive = [], [], 0
    # A breakout beyond the pool must fail; a later completed reclaim must qualify.
    for pip in (.0001, .01):
        token = detector._pip.set(pip)
        try:
            ts = pd.date_range("2026-01-05 02:00", periods=3, freq="5min", tz="America/New_York")
            level = pip*12000
            f = pd.DataFrame({"open":[level]*3,"high":[level+pip]*3,"low":[level-3*pip]*3,"close":[level-2*pip,level+pip,level+pip],"volume":[1]*3},index=ts)
            pool = detector.LiquidityPool(pool_id="fixture", pool_side="sellside", price=level, created_at=(ts[0]-pd.Timedelta(minutes=5)).isoformat())
            rejected = detector.reclaimed_sweep(f.iloc[:1],pool,"BUY",ts[0],pip)
            accepted = detector.reclaimed_sweep(f,pool,"BUY",ts[-1],pip)
            assert not rejected.passed and accepted.passed and accepted.sweep_ts==ts[1].isoformat()
            mirror = transform(f,anchor=2*level)
            mirrored_pool = detector.LiquidityPool(**{**asdict(pool),"pool_side":"buyside"})
            other = detector.reclaimed_sweep(mirror,mirrored_pool,"SELL",ts[-1],pip)
            assert other.passed and other.sweep_ts==accepted.sweep_ts
            assert abs(other.sweep_price-(2*level-accepted.sweep_price))<1e-6
            assert detector.price_buffer(level)==2*pip
            checks.append(f"strict-reclaim and mirrored sweep at pip {pip}")
        finally:
            detector._pip.reset(token)
    # Session clock and completed-bias availability are direction-independent.
    import replay_updated as replay
    for stamp, expected in [("2026-03-08 23:55","2026-03-08 17:00"),("2026-03-09 02:00","2026-03-08 17:00"),("2026-11-02 02:00","2026-11-01 17:00")]:
        t=pd.Timestamp(stamp,tz=replay.TZ)
        start=((t.tz_localize(None)-pd.Timedelta(hours=17)).normalize()+pd.Timedelta(hours=17)).tz_localize(replay.TZ)
        assert start==pd.Timestamp(expected,tz=replay.TZ)
    checks.append("17:00 trading-day clock across both DST transitions")
    assert 'searchsorted(all5.index, side="right")' in Path(replay.__file__).read_text(encoding="utf-8")
    checks.append("bias uses current completed-candle availability, not midnight cache")
    bias_closes = pd.DatetimeIndex([pd.Timestamp("2026-03-09 17:00", tz=replay.TZ)])
    assert bias_closes.searchsorted(pd.Timestamp("2026-03-09 16:55", tz=replay.TZ), side="right") == 0
    assert bias_closes.searchsorted(pd.Timestamp("2026-03-09 17:00", tz=replay.TZ), side="right") == 1
    # Test the shared execution rule in both directions, without reading real outcomes.
    cfg = replay.build_config("forex", start_date="2026-01-05", end_date="2026-01-06", workers=1, dry_run=True)
    index = pd.date_range("2026-01-05 02:00", periods=3, freq="5min", tz=replay.TZ)
    for closes, highs, lows, opens in [
        ([1.201,1.201,1.201],[1.203]*3,[1.1995]*3,[1.2]*3),
        ([1.1985,1.198,1.198],[1.201]*3,[1.198]*3,[1.2,1.198,1.198]),
        ([1.1985]*3,[1.203]*3,[1.198]*3,[1.2]*3),
    ]:
        bars = pd.DataFrame(dict(open=opens, high=highs, low=lows, close=closes, volume=[1]*3), index=index)
        order=dict(filled_at=index[0], direction="BUY", stoploss=1.199, target_price=1.202, strategy_id="S16")
        result=replay._first_exit_from_candles(cfg,order,bars)
        mirror_order={**order,"direction":"SELL","stoploss":4-order["stoploss"],"target_price":4-order["target_price"]}
        mirrored=replay._first_exit_from_candles(cfg,mirror_order,transform(bars,anchor=4))
        scaled_order={**order,"stoploss":100*order["stoploss"],"target_price":100*order["target_price"]}
        scaled=replay._first_exit_from_candles(cfg,scaled_order,transform(bars,scale=100))
        assert result and mirrored and scaled
        assert result["state"]==mirrored["state"]==scaled["state"]
        assert result["close_ts"]==mirrored["close_ts"]==scaled["close_ts"]
        assert abs(mirrored["close_price"]-(4-result["close_price"]))<1e-6
        assert abs(scaled["close_price"]/100-result["close_price"])<1e-6
    checks.append("shared target-touch / close-stop / same-bar policy: mirrored direction and quote scale")
    # Decision-only samples from the old detector, plus adjacent scans. This is
    # an invariance test corpus, not a selected profitability sample.
    count=0
    for source,symbol in [("barchart","EURUSD"),("barchart","AUDJPY"),("derived_1m","USDJPY"),("barchart","GBPUSD")]:
        folder=BASELINE/source/symbol
        frames={tf:pd.read_parquet(folder/f"reconstructed_{tf}.parquet") for tf in ("5m","15m","1h","daily","weekly")}
        signals=[json.loads(line) for line in (folder/"signals.jsonl").read_text().splitlines() if line]
        # At most 40 evenly spaced decisions per instrument, chosen without outcomes.
        positions=np.unique(np.linspace(0,len(signals)-1,min(40,len(signals)),dtype=int)) if signals else []
        for index in positions:
            original=signals[index]
            for offset in (0,15):
                at=pd.Timestamp(original["replay_provenance"]["detected_at"])+pd.Timedelta(minutes=offset)
                start=((at.tz_localize(None)-pd.Timedelta(hours=17)).normalize()+pd.Timedelta(hours=17)).tz_localize(replay.TZ)
                sliced={}
                for tf,f in frames.items():
                    view=f.loc[f.index<=at]
                    if tf in ("5m","15m"):view=view.loc[view.index>start]
                    sliced[tf]=view.iloc[-replay.LOOKBACK[tf]:]
                bias=original["strategy_json"]["bias"]
                kwargs=dict(symbol="^"+symbol,market="forex",source_market="forex",run_date=str(at.date()),as_of_ts=at,weekly_bias=bias["weekly_bias"],daily_bias=bias["daily_bias"],conflict_mode="strict")
                a=detector.build_s16_signal(frames=sliced,**kwargs)
                anchor=400 if symbol.endswith("JPY") else 4
                mirrored={tf:transform(f,anchor=anchor) for tf,f in sliced.items()}
                flip=lambda b:{"bullish":"bearish","bearish":"bullish"}.get(b,b)
                b=detector.build_s16_signal(frames=mirrored,**{**kwargs,"weekly_bias":flip(kwargs["weekly_bias"]),"daily_bias":flip(kwargs["daily_bias"])})
                scaled={tf:transform(f,scale=100) for tf,f in sliced.items()}
                c=detector.build_s16_signal(frames=scaled,pip_override=100*detector.pip_size(symbol),**kwargs)
                count+=1
                if (a is None)!=(b is None) or (a is None)!=(c is None):
                    failures.append(dict(source=source,symbol=symbol,at=str(at),issue="qualifying decision is not mirror/scale invariant",base=a is not None,mirror=b is not None,scaled=c is not None))
                    continue
                if a is None:continue
                positive+=1
                if a["direction"]==b["direction"] or a["entry_datetime"]!=b["entry_datetime"] or a["entry_datetime"]!=c["entry_datetime"]:
                    failures.append(dict(source=source,symbol=symbol,at=str(at),issue="direction/event time mismatch"))
                for field in ("entry_price","stoploss","target_1","target_2","target_3"):
                    if abs(b[field]-(anchor-a[field]))>2e-6 or abs(c[field]/100-a[field])>2e-6:
                        failures.append(dict(source=source,symbol=symbol,at=str(at),issue="geometry mismatch",field=field,base=a[field],mirror=b[field],scaled=c[field]))
    checks.append(f"{count} full-detector decisions mirrored and quote-scaled; {positive} qualifying base decisions")
    result=dict(status="passed" if not failures and positive>=10 else "failed",detector_sha256=hashlib.sha256(Path(detector.__file__).read_bytes()).hexdigest(),replay_sha256=hashlib.sha256(Path(replay.__file__).read_bytes()).hexdigest(),decisions=count,qualifying_decisions=positive,checks=checks,failures=failures,outcomes_read=False)
    (OUT/"mirror_gate.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
    print(json.dumps(result,indent=2))
    return result


if __name__=="__main__":
    result=run()
    raise SystemExit(0 if result["status"]=="passed" else 1)
