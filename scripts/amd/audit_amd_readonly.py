"""Read-only AMD audit. Writes review artifacts only; never regenerates AMD tables."""
import sys, json, hashlib, warnings
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
import pandas as pd
import psycopg2

warnings.filterwarnings('ignore', category=UserWarning)
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import amd_engine as ae

OUT = ROOT / 'reviews' / 'amd_2026-10-14'
OUT.mkdir(parents=True, exist_ok=True)
con = psycopg2.connect(ae.rv.db_uri())
con.set_session(readonly=True, isolation_level='REPEATABLE READ')
def query(sql):
    return pd.read_sql_query(sql, con)
def save(name, df):
    df.to_csv(OUT / (name + '.csv'), index=False)

runs = query('select * from amd_runs order by run_id')
t = query('select t.*,c.mss_date,c.return_date,c.acc_confirm,c.acc_start,c.end_date,c.fvg from amd_trades t join amd_cycles c using(run_id,cycle_id) order by t.run_id,t.trade_id')
c = query('select * from amd_cycles order by run_id,cycle_id')
save('runs', runs)
save('cycle_waterfall', c.groupby(['run_id','outcome']).size().reset_index(name='n'))
save('trade_waterfall', t.groupby(['run_id','model','target','outcome','risk_ok']).size().reset_index(name='n'))
t['early_mss_fill'] = t.model.eq('MSS_FVG') & (t.entry_date <= t.mss_date)
t['early_mss_decision'] = t.model.eq('MSS_FVG') & (t.decision_date < t.mss_date)
save('fvg_timing_violations', t[t.early_mss_fill])
save('timing_counts', t[t.model.eq('MSS_FVG')].groupby('run_id').agg(rows=('trade_id','size'),early_decisions=('early_mss_decision','sum'),early_fills=('early_mss_fill','sum')).reset_index())
p = t[t.outcome.isin(['win','loss','timeout']) & t.risk_ok].copy()
p['net5'] = p.r - .05 / p.risk_pct
p['net10'] = p.r - .10 / p.risk_pct
p['year'] = p.entry_date.dt.year
def stats(g):
    eq = g.groupby('exit_date').net5.sum().sort_index().cumsum()
    dd = (eq - eq.cummax().clip(lower=0)).min() if len(eq) else None
    sy = g.groupby('sym').net5.sum().sort_values(ascending=False)
    byyear = g.groupby('year').net5.mean()
    loss = -g.loc[g.r < 0,'r'].sum()
    late = g[g.entry_date >= '2022-01-01']
    early = g[g.entry_date < '2022-01-01']
    no3 = g[~g.sym.isin(sy.index[:3])]
    return dict(n=len(g),cycles=g.cycle_id.nunique(),win_pct=100*g.outcome.eq('win').mean(),avg_r=g.r.mean(),net5=g.net5.mean(),net10=g.net10.mean(),sum_r=g.r.sum(),pf=g.loc[g.r>0,'r'].sum()/loss if loss else None,median_r=g.r.median(),is_n=len(early),is_r=early.r.mean(),oos_n=len(late),oos_r=late.r.mean(),oos_net5=late.net5.mean(),early_mss_rows=int(g.early_mss_fill.sum()),symbols=g.sym.nunique(),positive_symbols=int((g.groupby('sym').net5.mean()>0).sum()),positive_years=int((byyear>0).sum()),years=len(byyear),ex_top3_net5=no3.net5.mean(),max_realized_sequence_dd_r=dd,median_risk_pct=g.risk_pct.median(),first=str(g.entry_date.min()),last=str(g.entry_date.max()))
grid=[]
for key,g in p.groupby(['run_id','model','target']): grid.append(dict(zip(['run_id','model','target'],key),**stats(g)))
grid=pd.DataFrame(grid); save('performance_grid',grid)
for dim in ['year','sym','side','with_bias']:
    rows=[]
    for key,g in p.groupby(['run_id','model','target',dim],dropna=False):
        rows.append(dict(zip(['run_id','model','target',dim],key),n=len(g),avg_r=g.r.mean(),net5=g.net5.mean()))
    save('performance_by_'+dim,pd.DataFrame(rows))
save('fvg_excluding_known_early_fills_diagnostic_only',p[p.model.eq('MSS_FVG') & ~p.early_mss_fill].groupby(['run_id','target']).agg(n=('r','size'),avg_r=('r','mean'),net5=('net5','mean')) .reset_index())
print('GRID: default structural liq_2R and session EOD',flush=True)
print(grid[((grid.model=='MSS_FVG') & (grid.target=='liq_2R')) | (grid.target=='EOD')].round(4).to_string(index=False),flush=True)

# Raw daily-bar evidence for early FVG fills. No loader corrections are used here.
examples=t[t.early_mss_fill & t.risk_ok & t.run_id.str.contains('_1d_') & t.target.eq('liq_2R')].head(4)
raw=[]
for _,r in examples.iterrows():
    with con.cursor() as cur:
        cur.execute("""select base_symbol sym, (candle_ts at time zone 'America/New_York')::date d,
          open_price o,high_price h,low_price l,close_price c from candles_1d
          where market='us' and base_symbol=%s and (candle_ts at time zone 'America/New_York')::date between %s and %s
          union all select base_symbol,(candle_ts at time zone 'America/New_York')::date,open_price,high_price,low_price,close_price
          from historical_candles_1d where market='us' and base_symbol=%s and base_symbol in ('SPY','QQQ')
          and (candle_ts at time zone 'America/New_York')::date between %s and %s order by d""",
          (r.sym,r.decision_date.date(),r.mss_date.date(),r.sym,r.decision_date.date(),r.mss_date.date()))
        cols=[d[0] for d in cur.description]
        raw.append(dict(trade=r.to_dict(),raw_bars=[dict(zip(cols,row)) for row in cur.fetchall()]))
(OUT/'raw_daily_examples.json').write_text(json.dumps(raw,default=str,indent=2),encoding='utf-8')

# Re-run existing validator in memory, deliberately bypass its main() DB UPDATE.
validation=[]
for tf in ['1d','1h','30m']:
    print('Raw replay audit',tf,flush=True)
    ae.rv.MARKET='us'; ae.rv.START=pd.Timestamp('2017-01-01'); ae.rv.LOAD_FROM='2015-06-30'; ae.rv.DQ.clear()
    df=ae.rv.clean(ae.rv.load_db(con) if tf=='1d' else ae.rv.load_intraday(con,tf)[0])
    import validate_amd as va
    G={}; IDX={}
    for sym,g in df.groupby('sym'):
        g=g.reset_index(drop=True)
        G[sym]={k:g[k].to_numpy(dtype=float) for k in 'ohlc'}
        G[sym]['d']=list(pd.to_datetime(g.d)); IDX[sym]={d:i for i,d in enumerate(G[sym]['d'])}
    DG=None
    if tf!='1d':
        dc=ae.rv.clean(ae.rv.load_db(con)); DG={s:g.assign(d=pd.to_datetime(g.d)).set_index('d').sort_index() for s,g in dc.groupby('sym')}
    for _,run in runs[runs.timeframe.eq(tf)].iterrows():
        ctx={'con':con,'run_id':run.run_id}
        if run.family=='structural': cb,tb,nc,NC,nt,NT=va.check_structural(ctx,run.params,G,IDX,1500)
        else: cb,tb,nc,NC,nt,NT=va.check_session(ctx,run.params,G,IDX,DG,1500)
        validation.append(dict(run_id=run.run_id,cycles_checked=nc,cycles_total=NC,trades_checked=nt,trades_total=NT,checks={**cb.out(),**tb.out()},failures=cb.fails+tb.fails,data_quality=list(ae.rv.DQ)))
        print(run.run_id,'existing checks failed',len(cb.fails+tb.fails),flush=True)

files=[ROOT/'scripts/amd/amd_engine.py',ROOT/'scripts/amd/validate_amd.py',Path(ae.rv.__file__),ROOT/'src/app/api/amd/route.ts',ROOT/'src/app/components/amd-dashboard.tsx',ROOT/'src/app/api/reversal/chart/route.ts']
manifest=dict(audited_at_utc=datetime.now(timezone.utc).isoformat(),transaction='REPEATABLE READ, READ ONLY',runs=len(runs),cycles=len(c),trade_rows=len(t),closed_risk_rows=len(p),early_mss_rows=int(t.early_mss_fill.sum()),early_mss_cycles=t[t.early_mss_fill].groupby('run_id').cycle_id.nunique().sum(),source_hashes={str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in files},replay_validation=validation)
(OUT/'audit_manifest.json').write_text(json.dumps(manifest,default=str,indent=2),encoding='utf-8')
con.rollback(); con.close()
print('Artifacts:',OUT,flush=True)
