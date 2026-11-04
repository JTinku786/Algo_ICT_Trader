import sys, warnings, pandas as pd, psycopg2
warnings.filterwarnings("ignore")
import expansion_engine as ee
con = psycopg2.connect(ee.rv.db_uri())
pd.set_option("display.width", 220); pd.set_option("display.max_rows", 300)
pat = sys.argv[1] if len(sys.argv) > 1 else "%"
for run in pd.read_sql(f"select run_id from expansion_runs where run_id like '{pat}' order by run_id", con).run_id:
    L = pd.read_sql("select * from expansion_legs where run_id=%s", con, params=(run,))
    T = pd.read_sql("select * from expansion_trades where run_id=%s", con, params=(run,))
    print(f"\n######## {run} legs={len(L)} trades={len(T)}")
    print("outcomes:", L.outcome.value_counts().to_dict(), "| touched 50%:", round(L.touched_eq.mean() * 100, 1), "| touched OTE:", round(L.touched_ote.mean() * 100, 1))
    print("retrace depth quantiles (% of leg):", L.retrace_pct.quantile([.25, .5, .75]).round(1).to_dict())
    P = T[T.outcome.isin(["win", "loss", "timeout"]) & T.risk_ok]
    P = P.assign(oos=P.entry_date >= "2022-01-01")
    g = P.groupby(["model", "target"]).agg(n=("r", "size"), wr=("outcome", lambda x: (x == "win").mean() * 100), avgR=("r", "mean"), risk=("risk_pct", "median"))
    g["isR"] = P[~P.oos].groupby(["model", "target"]).r.mean(); g["oosR"] = P[P.oos].groupby(["model", "target"]).r.mean()
    print(g.round(3))
    w = P[P.with_bias.notna()]
    print(w.groupby(["model", "target", "with_bias"]).r.mean().unstack().round(3))
