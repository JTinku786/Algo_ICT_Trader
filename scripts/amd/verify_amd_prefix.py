"""Read-only finite prefix/extension checks on real raw candles, no DB writes."""
import sys,json,warnings,datetime as dt
from pathlib import Path
import numpy as np,pandas as pd,psycopg2
warnings.filterwarnings('ignore',category=UserWarning)
sys.path.insert(0,str(Path(__file__).parent))
import amd_engine as ae
import amd_data as data

out=Path(__file__).resolve().parents[2]/'reviews'/'amd_causal_v2_2026-10-14'
out.mkdir(parents=True,exist_ok=True)
con=psycopg2.connect(ae.rv.db_uri()); con.set_session(readonly=True,isolation_level='REPEATABLE READ')
daily,_=data.load(con,'1d','2017-01-01')
results=[]; examples=[]
fields=['cycle_id','model','target','decision_date','entry_date','entry','stop','tgt','planned_entry']
def decisions(rows,cut):
    return sorted([tuple(str(t[k]) for k in fields) for t in rows if pd.Timestamp(t['entry_date'])<=cut])
for tf in ['1d','1h','30m']:
    raw,_=(daily,[]) if tf=='1d' else data.load(con,tf,'2017-01-01')
    for sym in ['UNH','MSFT','JPM']:
        chunks=[g for s,g in data.groups(raw[raw.sym.eq(sym)]) if len(g)>100]
        if not chunks: continue
        g=max(chunks,key=len)
        dg=daily[daily.sym.eq(sym)]
        bias=ae.rv.htf_bias(ae.rv.weekly(dg) if tf=='1d' else dg.set_index('d'))
        start=pd.Timestamp('2017-01-01'); rid=f'PREFIX_{tf}_{sym}'
        C,T=ae.structural(sym,g,ae.CONFIGS[1],tf,start,bias,rid)
        for cycle in C:
            if cycle['mss_date'] is not None and cycle['mss_date']==cycle['return_date']:
                trades=[t for t in T if t['cycle_id']==cycle['cycle_id'] and t['model']=='MSS_CLOSE' and t['target']=='2R']
                if trades:
                    trade=trades[0]
                    bar=g[g.d.eq(cycle['return_date'])].iloc[0]
                    examples.append(dict(tf=tf,sym=sym,reason='MSS on raid/reclaim candle (old loop started one candle later)',cycle=cycle,trade=trade,confirmation_bar={k:str(bar[k]) for k in ['d',*'ohlc']}))
                    break
        entry_indices=sorted({g.index[g.d.eq(t['entry_date'])][0] for t in T})
        if not entry_indices: continue
        selected=[entry_indices[i] for i in np.unique(np.linspace(0,len(entry_indices)-1,min(5,len(entry_indices))).astype(int))]
        for index in selected:
            cut=pd.Timestamp(g.d.iloc[index])
            _,prefix=ae.structural(sym,g.iloc[:index+1].copy(),ae.CONFIGS[1],tf,start,bias,rid)
            expected=decisions(T,cut); actual=decisions(prefix,cut)
            results.append(dict(tf=tf,sym=sym,cut=str(cut),kind='truncate_future',pass_=expected==actual,trades=len(expected)))
            if expected!=actual:
                raise AssertionError(f'Prefix changed historical entries: {tf} {sym} {cut}')
        # Alter every OHLC after a real decision; earlier decisions must survive.
        index=selected[len(selected)//2]; cut=pd.Timestamp(g.d.iloc[index]); mutated=g.copy()
        mutated.loc[index+1:,'o']=mutated.loc[index+1:,'o']*1.2
        mutated.loc[index+1:,'h']=mutated.loc[index+1:,'h']*1.3
        mutated.loc[index+1:,'l']=mutated.loc[index+1:,'l']*.8
        mutated.loc[index+1:,'c']=mutated.loc[index+1:,'c']*1.1
        _,changed=ae.structural(sym,mutated,ae.CONFIGS[1],tf,start,bias,rid)
        ok=decisions(T,cut)==decisions(changed,cut)
        results.append(dict(tf=tf,sym=sym,cut=str(cut),kind='mutate_future',pass_=ok))
        if not ok: raise AssertionError(f'Future mutation changed past decisions: {tf} {sym} {cut}')
        print(tf,sym,'prefix checks pass',len(selected)+1,flush=True)
payload=dict(checked_at=dt.datetime.now(dt.timezone.utc).isoformat(),scope='finite real-candle structural decision invariance; not live first-discovery certification',results=results,examples=examples)
(out/'prefix_checks_and_recovered_examples.json').write_text(json.dumps(payload,default=str,indent=2),encoding='utf-8')
con.rollback();con.close()
print('PASS',len(results),'real-candle prefix/mutation checks;',len(examples),'same-bar examples',flush=True)
