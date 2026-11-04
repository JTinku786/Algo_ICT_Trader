import sys, warnings, pandas as pd, psycopg2
warnings.filterwarnings("ignore")
sys.path.insert(0, r"C:\Users\saite\Desktop\ICT_Automation\trend_reversal_2026")
import reversal_engine as rv
con = psycopg2.connect(rv.db_uri()); pd.set_option("display.width", 220)
runs = pd.read_sql("select distinct on (timeframe, config_name) run_id, timeframe, config_name from amd_runs where family='structural' order by timeframe, config_name, created_at desc", con)
for rid in runs.run_id:
    T = pd.read_sql("select sym, entry_date, r, risk_pct from amd_trades where run_id=%s and model='MSS_FVG' and target='liq_2R' and risk_ok and outcome in ('win','loss','timeout')", con, params=(rid,))
    if T.empty: continue
    T["rc"] = T.r - 0.05 / T.risk_pct; T["rc10"] = T.r - 0.10 / T.risk_pct; T["y"] = pd.to_datetime(T.entry_date).dt.year
    bys = T.groupby("sym").r.sum().sort_values(ascending=False)
    byy = T.groupby("y").r.mean()
    ex_top = T[~T.sym.isin(bys.index[:3])].r.mean()
    eq = T.sort_values("entry_date").r.cumsum(); dd = (eq - eq.cummax()).min()
    print(f"{rid}: n={len(T)} avgR={T.r.mean():.3f} 5bp={T.rc.mean():.3f} 10bp={T.rc10.mean():.3f} medRisk%={T.risk_pct.median():.2f} "
          f"syms+={int((T.groupby('sym').r.mean()>0).sum())}/{T.sym.nunique()} top3 share={bys.iloc[:3].sum()/T.r.sum()*100:.0f}% ex-top3 avgR={ex_top:.3f} "
          f"years+={int((byy>0).sum())}/{len(byy)} maxDD={dd:.1f}R sumR={T.r.sum():.1f}")
