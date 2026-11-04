"""Implementable time-stop test for reject inference.

The earlier hold-time table conditioned on when a trade HAPPENED to resolve,
which you only know afterwards. This replays a hard rule you can actually run:
exit at the close of bar N if neither stop nor target has been touched.
"""
import io, os, sys
from datetime import timedelta
import pandas as pd, psycopg2

APP = r"C:\Users\saite\OneDrive\Documents\Algo_ICT_Trader"
cfg = {}
for line in io.open(os.path.join(APP, ".env.local"), encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); cfg[k.strip()] = v.strip().strip('"').strip("'")
conn = psycopg2.connect(host=cfg["POSTGRES_HOST"], port=cfg.get("POSTGRES_PORT", 5432),
    dbname=cfg["POSTGRES_DATABASE"], user=cfg["POSTGRES_USER"], password=cfg["POSTGRES_PASSWORD"])

parents = pd.read_sql("""
SELECT o.order_id::text, o.symbol, o.direction, o.entry_price::float8 ep, o.stoploss::float8 sl,
       o.tp1::float8 tp1, o.tp2::float8 tp2, t.close_ts, t.close_price::float8 exit_px
FROM historical_ict_orders o
JOIN historical_ict_strategy_met_execution s ON s.signal_hash = o.signal_id
JOIN historical_ict_order_target_outcomes t ON t.order_id=o.order_id AND t.target_no=1
WHERE s.strategy_id=%s AND t.close_reason='stoploss_hit' ORDER BY t.close_ts""",
    conn, params=(sys.argv[1] if len(sys.argv) > 1 else "S03",))

CAPS = [78, 156, 234, 390, 780, 1170]        # 1,2,3,5,10,15 sessions
TMULT = [1.0, 1.5, 2.0]
grid = {(c, t): [] for c in CAPS for t in TMULT}

for n, p in enumerate(parents.itertuples(), 1):
    if n % 400 == 0: print("  %d/%d" % (n, len(parents)), flush=True)
    short = p.direction == "BUY"
    entry, stop = p.exit_px, p.tp1
    risk = abs(entry - stop)
    if risk <= 0 or entry <= 0: continue
    sgn = -1 if short else 1
    bars = pd.read_sql("""SELECT high_price::float8 hi, low_price::float8 lo, close_price::float8 cl
        FROM historical_candles_5m WHERE yahoo_symbol=%s AND candle_ts>%s AND candle_ts<=%s
        ORDER BY candle_ts""", conn, params=(p.symbol, p.close_ts, p.close_ts + timedelta(days=28)))
    if bars.empty: continue
    hi, lo, cl = bars.hi.values, bars.lo.values, bars.cl.values

    for tm in TMULT:
        tgt = entry + sgn * tm * risk
        # first touch of stop / target, scanning once
        s_i = t_i = None
        for i in range(len(hi)):
            if (hi[i] >= stop) if short else (lo[i] <= stop):
                s_i = i; break
            if (lo[i] <= tgt) if short else (hi[i] >= tgt):
                t_i = i; break
        for cap in CAPS:
            if s_i is not None and s_i < cap:
                grid[(cap, tm)].append((-1.0, "STOP"))
            elif t_i is not None and t_i < cap:
                grid[(cap, tm)].append((tm, "TARGET"))
            else:
                j = min(cap, len(cl)) - 1
                r = ((entry - cl[j]) if short else (cl[j] - entry)) / risk
                grid[(cap, tm)].append((float(r), "TIME"))

print("\n=== HARD TIME-STOP (exit at market on bar N) ===")
print("%8s %6s %6s %6s %6s %7s %8s %8s" % ("sessions", "targ", "n", "win", "time", "netR", "expR", "PF"))
for cap in CAPS:
    for tm in TMULT:
        rs = grid[(cap, tm)]
        if not rs: continue
        R = pd.Series([r for r, _ in rs]); lab = pd.Series([l for _, l in rs])
        gw = R[R > 0].sum(); gl = -R[R < 0].sum()
        print("%8d %6.1f %6d %6d %6d %7.1f %8.3f %8.2f" %
              (cap // 78, tm, len(R), (lab == "TARGET").sum(), (lab == "TIME").sum(),
               R.sum(), R.mean(), gw / gl if gl else float("inf")))
conn.close()
