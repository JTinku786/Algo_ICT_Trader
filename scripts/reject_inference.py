"""Reject-inference engine.

A parent ICT trade that hits its stoploss is a FAILED setup. The failure itself
is the signal: reverse into the opposite direction at the stop.

Spec (Reddy, 2026-09-21):
    reverse entry = parent stop (filled at the parent's actual stop close)
    reverse stop  = parent tp1          -- the level the parent was reaching for
    reverse tp1   = 1:1 of that risk
    reverse tp2   = parent's (tp2 - entry)/entry percentage, projected from the
                    reverse entry in the reverse direction

Strategy-agnostic: pass --strategy S15 / S16 / S-CH08 to run the same study.
A bar that spans both stop and target counts as the STOP (worst case).
"""
import argparse, io, os, sys
from datetime import timedelta

import pandas as pd
import psycopg2
import psycopg2.extras

APP = r"C:\Users\saite\OneDrive\Documents\Algo_ICT_Trader"


def dsn():
    cfg = {}
    for line in io.open(os.path.join(APP, ".env.local"), encoding="utf-8"):
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    return dict(
        host=cfg["POSTGRES_HOST"], port=cfg.get("POSTGRES_PORT", 5432),
        dbname=cfg["POSTGRES_DATABASE"], user=cfg["POSTGRES_USER"],
        password=cfg["POSTGRES_PASSWORD"],
    )


PARENTS_SQL = """
SELECT o.order_id::text, o.symbol, o.direction,
       o.entry_price::float8 ep, o.stoploss::float8 sl,
       o.tp1::float8 tp1, o.tp2::float8 tp2, o.tp3::float8 tp3,
       t.close_ts, t.close_price::float8 exit_px
FROM historical_ict_orders o
JOIN historical_ict_strategy_met_execution s ON s.signal_hash = o.signal_id
JOIN historical_ict_order_target_outcomes t ON t.order_id = o.order_id AND t.target_no = 1
WHERE s.strategy_id = %s AND t.close_reason = 'stoploss_hit'
ORDER BY t.close_ts
"""

CANDLES_SQL = """
SELECT candle_ts, high_price::float8 hi, low_price::float8 lo, close_price::float8 cl
FROM historical_candles_5m
WHERE yahoo_symbol = %s AND candle_ts > %s AND candle_ts <= %s
ORDER BY candle_ts
"""


def resolve(bars, entry, stop, targets, short):
    """Walk bars once; return (label, r_multiple, bars_held) for each target level.

    `targets` is an ordered list of (name, price). Risk is |entry - stop|.
    """
    risk = abs(entry - stop)
    if risk <= 0 or bars.empty:
        return None
    out = {}
    for name, tgt in targets:
        hit_i = stop_i = None
        for i, (hi, lo) in enumerate(zip(bars.hi.values, bars.lo.values)):
            if short:
                stopped = hi >= stop
                hit = lo <= tgt
            else:
                stopped = lo <= stop
                hit = hi >= tgt
            if stopped:
                stop_i = i
                break
            if hit:
                hit_i = i
                break
        if stop_i is not None:
            out[name] = ("STOP", -1.0, stop_i + 1)
        elif hit_i is not None:
            r = abs(tgt - entry) / risk
            out[name] = ("TARGET", r, hit_i + 1)
        else:
            last = bars.cl.values[-1]
            r = ((entry - last) if short else (last - entry)) / risk
            out[name] = ("OPEN", float(r), len(bars))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", default="S03")
    ap.add_argument("--hold-sessions", type=int, default=15)
    ap.add_argument("--persist", action="store_true")
    args = ap.parse_args()

    conn = psycopg2.connect(**dsn())
    parents = pd.read_sql(PARENTS_SQL, conn, params=(args.strategy,))
    print("parent stop-outs: %d  (%s .. %s)"
          % (len(parents), parents.close_ts.min(), parents.close_ts.max()), flush=True)

    horizon = timedelta(days=args.hold_sessions * 7 / 5 + 3)
    rows, cache = [], {}

    for n, p in enumerate(parents.itertuples(), 1):
        if n % 250 == 0:
            print("  %d/%d" % (n, len(parents)), flush=True)
        short = p.direction == "BUY"          # parent long failed -> we go short
        entry = p.exit_px                      # honest fill: the parent's real stop print
        stop = p.tp1
        risk = abs(entry - stop)
        if risk <= 0 or entry <= 0:
            continue

        sgn = -1 if short else 1
        pct2 = (p.tp2 - p.ep) / p.ep if p.ep else 0.0
        targets = [
            ("spec_tp1_1to1", entry + sgn * risk),
            ("spec_tp2_pct", entry * (1 + sgn * abs(pct2))),
            ("fixed_1R", entry + sgn * risk),
            ("fixed_1_5R", entry + sgn * 1.5 * risk),
            ("fixed_2R", entry + sgn * 2.0 * risk),
            ("fixed_3R", entry + sgn * 3.0 * risk),
        ]

        key = (p.symbol, p.close_ts)
        if key not in cache:
            cache[key] = pd.read_sql(CANDLES_SQL, conn,
                                     params=(p.symbol, p.close_ts, p.close_ts + horizon))
        bars = cache.pop(key)
        if bars.empty:
            continue
        bars = bars.head(args.hold_sessions * 78)

        res = resolve(bars, entry, stop, targets, short)
        if not res:
            continue
        rec = dict(parent_order_id=p.order_id, symbol=p.symbol, strategy_id=args.strategy,
                   parent_direction=p.direction, reverse_direction="SELL" if short else "BUY",
                   entry_ts=p.close_ts, entry=entry, stop=stop,
                   risk_pts=risk, risk_pct=100.0 * risk / entry,
                   parent_risk=abs(p.ep - p.sl), pct2=100.0 * abs(pct2))
        for name, (label, r, held) in res.items():
            rec[name + "_out"] = label
            rec[name + "_r"] = r
            rec[name + "_bars"] = held
        rows.append(rec)

    df = pd.DataFrame(rows)
    print("\nreverse trades resolved: %d" % len(df), flush=True)
    df.to_csv(os.path.join(APP, "output", "reject_inference_%s.csv" % args.strategy), index=False)

    print("\n%-16s %6s %6s %6s %7s %8s %8s %7s" %
          ("target", "n", "win", "wr%", "netR", "expR", "PF", "bars"))
    for name, _ in targets:
        lab, r, bars_c = name + "_out", name + "_r", name + "_bars"
        d = df[df[lab].isin(["STOP", "TARGET"])]
        if d.empty:
            continue
        w = (d[lab] == "TARGET").sum()
        l = (d[lab] == "STOP").sum()
        gross_w = d.loc[d[lab] == "TARGET", r].sum()
        print("%-16s %6d %6d %6.1f %7.1f %8.3f %8.2f %7.1f" %
              (name, len(d), w, 100.0 * w / len(d), d[r].sum(), d[r].mean(),
               gross_w / l if l else float("inf"), d[bars_c].mean()))

    if args.persist:
        cols = list(df.columns)
        with conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS reject_inference_orders_%s" % args.strategy.replace("-", "_").lower())
        conn.commit()
        df.to_csv(os.path.join(APP, "output", "reject_inference_%s.csv" % args.strategy), index=False)
    conn.close()


if __name__ == "__main__":
    main()
