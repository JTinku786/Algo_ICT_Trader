import io, os, pandas as pd, psycopg2
APP = r"C:\Users\saite\OneDrive\Documents\Algo_ICT_Trader"
cfg = {}
for line in io.open(os.path.join(APP, ".env.local"), encoding="utf-8"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1); cfg[k.strip()] = v.strip().strip('"').strip("'")
conn = psycopg2.connect(host=cfg["POSTGRES_HOST"], port=cfg.get("POSTGRES_PORT", 5432),
    dbname=cfg["POSTGRES_DATABASE"], user=cfg["POSTGRES_USER"], password=cfg["POSTGRES_PASSWORD"])

df = pd.read_csv(os.path.join(APP, "output", "reject_inference_S03.csv"))
df["entry_ts"] = pd.to_datetime(df.entry_ts, utc=True, format="mixed")
df["year"] = df.entry_ts.dt.year
res = df[df.spec_tp1_1to1_out.isin(["STOP", "TARGET"])].copy()
res["R"] = res.spec_tp1_1to1_r

print("=== by year (spec: stop=parent tp1, target 1:1) ===")
print("%6s %6s %6s %7s %8s" % ("year", "n", "wr%", "netR", "expR"))
for y, g in res.groupby("year"):
    w = (g.spec_tp1_1to1_out == "TARGET").sum()
    print("%6d %6d %6.1f %7.1f %8.3f" % (y, len(g), 100.0 * w / len(g), g.R.sum(), g.R.mean()))

# Regime: SPY 20-day trend at the reverse entry.
spy = pd.read_sql("""SELECT candle_ts::date dt, close_price::float8 cl FROM historical_candles_1d
                     WHERE yahoo_symbol='SPY' ORDER BY 1""", conn)
spy["ma20"] = spy.cl.rolling(20).mean()
spy["regime"] = (spy.cl > spy.ma20).map({True: "SPY above 20d", False: "SPY below 20d"})
res["dt"] = res.entry_ts.dt.tz_localize(None).dt.date
m = res.merge(spy[["dt", "regime"]], on="dt", how="left")

print("\n=== by market regime ===")
print("%16s %6s %6s %7s %8s" % ("regime", "n", "wr%", "netR", "expR"))
for r, g in m.dropna(subset=["regime"]).groupby("regime"):
    w = (g.spec_tp1_1to1_out == "TARGET").sum()
    print("%16s %6d %6.1f %7.1f %8.3f" % (r, len(g), 100.0 * w / len(g), g.R.sum(), g.R.mean()))

print("\n=== hold-time cap sensitivity (bars, 78/session) ===")
for cap in (78, 390, 780, 1170):
    g = res[res.spec_tp1_1to1_bars <= cap]
    w = (g.spec_tp1_1to1_out == "TARGET").sum()
    print("  <=%5d bars (%2d sess)  n=%4d  wr=%5.1f%%  netR=%7.1f  expR=%6.3f"
          % (cap, cap // 78, len(g), 100.0 * w / len(g) if len(g) else 0, g.R.sum(), g.R.mean() if len(g) else 0))

print("\n=== unresolved at 15 sessions ===")
op = df[df.spec_tp1_1to1_out == "OPEN"]
print("  %d of %d (%.0f%%), mean drift %.2fR" % (len(op), len(df), 100.0*len(op)/len(df), op.spec_tp1_1to1_r.mean()))

print("\n=== reverse risk size ===")
print("  median reverse risk = %.2f x parent risk; median %.2f%% of price"
      % ((df.risk_pts / df.parent_risk).median(), df.risk_pct.median()))
conn.close()
