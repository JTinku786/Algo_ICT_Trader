import sys, os, pandas as pd, psycopg2, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, r"C:\Users\saite\Desktop\ICT_Automation\trend_reversal_2026")
import reversal_engine as rv
con = psycopg2.connect(rv.db_uri())
pd.set_option("display.width", 220); pd.set_option("display.max_rows", 300)
pat = sys.argv[1] if len(sys.argv) > 1 else "%"
runs = pd.read_sql(f"select run_id from consolidation_runs where run_id like '{pat}' order by run_id", con).run_id
for run in runs:
    T = pd.read_sql("select * from consolidation_trades where run_id=%s", con, params=(run,))
    B = pd.read_sql("select * from consolidation_boxes where run_id=%s", con, params=(run,))
    print(f"\n######## {run}  boxes={len(B)}  trades={len(T)}")
    print("fates:", B.fate.value_counts().to_dict())
    print("fate x with-bias (break dir vs htf bias):")
    B["bias_rel"] = B.apply(lambda r: "neutral" if r.htf_bias == 0 or r.break_dir is None else ("with" if (r.htf_bias == 1) == (r.break_dir == "up") else "against"), axis=1)
    print(pd.crosstab(B.fate, B.bias_rel))
    P = T[T.outcome.isin(["win", "loss", "timeout"]) & T.risk_ok]
    P = P.assign(yr_oos=P.entry_date >= "2022-01-01")
    g = P.groupby(["model", "target"]).agg(n=("r", "size"), wr=("outcome", lambda x: (x == "win").mean() * 100),
                                            avgR=("r", "mean"), medR=("r", "median"), risk=("risk_pct", "median"))
    g["oosR"] = P[P.yr_oos].groupby(["model", "target"]).r.mean()
    g["isR"] = P[~P.yr_oos].groupby(["model", "target"]).r.mean()
    print(g.round(3))
    w = P[P.with_bias.notna()]
    g2 = w.groupby(["model", "target", "with_bias"]).agg(n=("r", "size"), wr=("outcome", lambda x: (x == "win").mean() * 100), avgR=("r", "mean")).round(3)
    print(g2.unstack("with_bias"))
