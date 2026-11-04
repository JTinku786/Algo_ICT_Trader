"""Predeclared range-edge limit fades: no future raid extreme used for stop placement."""
import sys,json,time,argparse
from pathlib import Path
from datetime import datetime,timezone
from collections import Counter
from concurrent.futures import ProcessPoolExecutor,as_completed
import numpy as np,pandas as pd,psycopg2
from research_models import ce,load_candles,rollup_candles,session_bounds,frames_from_bars,expected_grid,causal_bias,exit_loop,ZONE,ROOT

def worker(task):
 sym,asof_iso=task;t0=time.time();asof=datetime.fromisoformat(asof_iso);since=datetime(2015,7,1,tzinfo=timezone.utc)
 with psycopg2.connect(ce.rv.db_uri()) as con:bs,audit=load_candles(con,'us',sym,since,asof)
 if not bs:return dict(sym=sym,trades=[],counts={},boxes=0,audit=audit)
 frames=frames_from_bars(bs,'us',sym,since,asof);times=np.array([b['t'] for b in bs]);grid=expected_grid('us',since,asof);pos=np.searchsorted(grid,times);gaps=np.concatenate([[False],np.diff(pos)!=1]);bias=causal_bias(frames['1d'])
 bounds=session_bounds('us',since.astimezone(ZONE).date(),asof.astimezone(ZONE).date());f15=rollup_candles(bs,'us','15m');expected15=np.array([t for begin,end in bounds.values() for t in range(begin,end,900000)]);p15=np.searchsorted(expected15,[b['t'] for b in f15]);segs=np.cumsum(np.concatenate([[False],np.diff(p15)!=1]));frames['15m']=pd.DataFrame([dict(sym=sym,d=pd.Timestamp(datetime.fromtimestamp(b['t']/1000,timezone.utc).astimezone(ZONE).replace(tzinfo=None)),knownAt=b['knownAt'],segment=int(segs[i]),**{k:b[k] for k in 'ohlc'}) for i,b in enumerate(f15)])
 groups={}
 for b in bs:
  begin,end=bounds[b['day']];bucket=begin+((b['t']-begin)//14400000)*14400000;finish=min(bucket+14400000,end);groups.setdefault((bucket,finish),[]).append(b)
 four=[]
 for (begin,end),group in sorted(groups.items()):
  if len(group)==(end-begin)//300000 and all(b['t']==begin+i*300000 for i,b in enumerate(group)):
   four.append(dict(d=pd.Timestamp(datetime.fromtimestamp(begin/1000,timezone.utc).astimezone(ZONE).replace(tzinfo=None)),o=group[0]['o'],h=max(b['h'] for b in group),l=min(b['l'] for b in group),c=group[-1]['c'],knownAt=end,t=begin))
 expected4=np.array([t for begin,end in bounds.values() for t in range(begin,end,14400000)]);f4=pd.DataFrame(four);p4=np.searchsorted(expected4,f4.t);f4['segment']=np.cumsum(np.concatenate([[False],np.diff(p4)!=1]));b4=causal_bias(f4)
 counts=Counter();rows=[];boxcount=0
 for tf in ('1d','1h','30m','15m'):
  for cfg0 in ce.CONFIGS:
   cfg={**cfg0,'run_id':'CONSOLIDATION_EXPERIMENTS_RAW5M_V2_'+tf+'_'+cfg0['name']}
   for _,seg in frames[tf].groupby('segment'):
    if len(seg)<30:continue
    boxes,_=ce.run_sym(sym,seg,cfg,tf,pd.Timestamp('2017-01-01'),bias,cfg['run_id'])
    keys={r.d:int(r.knownAt) for r in seg.itertuples()}
    for box in boxes:
     boxcount+=1;conf=keys[pd.Timestamp(box['confirm_date'])];ci=list(seg.d).index(pd.Timestamp(box['confirm_date']));endknown=int(seg.iloc[min(len(seg)-1,ci+10)].knownAt);a=int(np.searchsorted(times,conf));z=int(np.searchsorted(times,endknown+1));H=box['box_hi']-box['box_lo']
     label=pd.Timestamp(datetime.fromtimestamp(conf/1000,timezone.utc).astimezone(ZONE).replace(tzinfo=None));dv=ce.rv.bias_at(bias,label);hv=ce.rv.bias_at(b4,label)
     for name,offset,stop_offset in (('PREARMED_EDGE_TOUCH',0,0.25),('PREARMED_RAID_10PCT',0.1,0.35)):
      buy=box['box_lo']-offset*H;sell=box['box_hi']+offset*H;found=None
      for e in range(a,z):
       if gaps[e]:counts[name+':missing_pre_entry_path']+=1;break
       up=bs[e]['h']>=sell;dn=bs[e]['l']<=buy
       if up and dn:counts[name+':two_sided_fill_ambiguous']+=1;break
       if up or dn:found=(e,-1 if up else 1);break
      if found is None:counts[name+':no_fill']+=1;continue
      e,sg=found;entry=max(bs[e]['o'],sell) if sg==-1 else min(bs[e]['o'],buy);stop=box['box_hi']+stop_offset*H if sg==-1 else box['box_lo']-stop_offset*H;risk=(entry-stop)*sg
      if entry<=0 or stop<=0 or risk<=0 or risk/entry<0.002:counts[name+':invalid_or_tiny_risk']+=1;continue
      for target in ('CE','OPPOSITE','2R'):
       tgt=box['ce'] if target=='CE' else box['box_hi'] if target=='OPPOSITE' and sg==1 else box['box_lo'] if target=='OPPOSITE' else entry+sg*2*risk
       if tgt<=0 or (tgt-entry)*sg<=0:counts[name+':invalid_target']+=1;continue
       for policy in ('HARD5','CLOSE5'):
        result=exit_loop(bs,e,sg,entry,stop,tgt,policy,gaps,True)
        row=dict(sym=sym,box_id=box['box_id'],box_tf=tf,config=cfg['name'],model=name,target=target,policy=policy,side=sg,confirm_at=conf,raid_at=bs[e]['knownAt'],decision_known_at=conf,entry_at=int(times[e]),filled_observed_at=bs[e]['knownAt'],entry=entry,stop=stop,tgt=tgt,plan_r=abs(tgt-entry)/risk,box_hi=box['box_hi'],box_lo=box['box_lo'],box_ce=box['ce'],fill_o=bs[e]['o'],fill_h=bs[e]['h'],fill_l=bs[e]['l'],fill_c=bs[e]['c'],source_fingerprint=audit['fingerprint'],htf_bias=dv,bias_4h=hv,with_bias=dv==sg,with_4h_bias=hv==sg,with_both_bias=dv==sg and hv==sg,risk_pct=risk/entry*100,year=datetime.fromtimestamp(times[e]/1000,timezone.utc).astimezone(ZONE).year,**result)
        if result['r'] is not None:row['net_5bps_r']=result['r']-entry*0.0005/risk;row['net_10bps_r']=result['r']-entry*0.001/risk
        rows.append(row)
 return dict(sym=sym,trades=rows,counts=dict(counts),boxes=boxcount,audit=audit,seconds=time.time()-t0)

def main():
 report=json.loads((ROOT/'public/reports/consolidation-research-results.json').read_text(encoding='utf-8'));outdir=ROOT/'tmp/consolidation-prearmed';outdir.mkdir(parents=True,exist_ok=True);results=[]
 with ProcessPoolExecutor(max_workers=4) as pool:
  futures=[pool.submit(worker,(s,report['asof'])) for s in report['universe']]
  for f in as_completed(futures):
   r=f.result();results.append(r);(outdir/(r['sym']+'.json')).write_text(json.dumps(r,default=str),encoding='utf-8');print(r['sym'],'variants',len(r['trades']),flush=True)
 pd.DataFrame([r for s in results for r in s['trades']]).to_csv(ROOT/'public/reports/consolidation-prearmed-trades.csv',index=False)
 (ROOT/'public/reports/consolidation-prearmed-results.json').write_text(json.dumps({k:[{z:v for z,v in r.items() if z!='trades'} for r in results] for k in ['symbols']},default=str,indent=2),encoding='utf-8');print('COMPLETE',flush=True)
if __name__=='__main__':main()
