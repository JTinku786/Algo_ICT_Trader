import sys, warnings, pandas as pd, psycopg2
warnings.filterwarnings("ignore")
import amd_engine as ae
con = psycopg2.connect(ae.rv.db_uri())
pd.set_option("display.width", 220); pd.set_option("display.max_rows", 400)
pat = sys.argv[1] if len(sys.argv) > 1 else "%"
for run in pd.read_sql(f"select run_id from amd_runs where run_id like '{pat}' order by run_id", con).run_id:
    C = pd.read_sql("select * from amd_cycles where run_id=%s", con, params=(run,))
    T = pd.read_sql("select * from amd_trades where run_id=%s", con, params=(run,))
    print(f"\n######## {run} cycles={len(C)} trades={len(T)}")
    print(C.outcome.value_counts().to_dict())
    if "with_bias" in C and C.with_bias.notna().any():
        print(pd.crosstab(C.outcome, C.with_bias.map({True: "with", False: "against"}).fillna("neutral")))
    P = T[T.outcome.isin(["win", "loss", "timeout"]) & T.risk_ok]
    P = P.assign(oos=P.entry_date >= "2022-01-01")
    g = P.groupby(["model", "target"]).agg(n=("r", "size"), wr=("outcome", lambda x: (x == "win").mean() * 100), avgR=("r", "mean"), risk=("risk_pct", "median"))
    g["isR"] = P[~P.oos].groupby(["model", "target"]).r.mean(); g["oosR"] = P[P.oos].groupby(["model", "target"]).r.mean()
    w = P[P.with_bias.notna()].groupby(["model", "target", "with_bias"]).r.mean().unstack()
    g = g.join(w.rename(columns={True: "withR", False: "againstR"}))
    print(g.round(3))
