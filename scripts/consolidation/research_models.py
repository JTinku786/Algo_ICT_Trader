"""Isolated causal consolidation experiments on canonical complete raw 5m candles.
No production table writes. Fixed hypotheses, costs sensitivities and yearly train-only selection.
"""
import sys,json,csv,hashlib,math,time,argparse
from pathlib import Path
from datetime import datetime,timezone
from collections import Counter
from concurrent.futures import ProcessPoolExecutor,as_completed
from functools import lru_cache
import numpy as np,pandas as pd,psycopg2
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(Path.home()/"Desktop/ICT_Automation/realtime_execution"))
sys.path.insert(0,str(Path.home()/"Desktop/ICT_Automation/trend_reversal_2026"))
from reversal_candle_source import load_candles,rollup_candles,session_bounds,ZONE,SOURCE_VERSION
from reversal_exit_policy import expected_grid
from rebuild_canonical_reversals import frames_from_bars
import consolidation_engine as ce
VERSION="CONSOLIDATION_EXPERIMENTS_RAW5M_V2"
ce.TF_SPEC['15m']=dict(min_bars=12,max_active=52,atr_n=20,fwd=39,max_hold=78)
ce.MIN_RISK['15m']=0.2
START=datetime(2017,1,1,tzinfo=timezone.utc)
MODELS=('RAID_FADE','CLOSE_BREAK_FADE','RECLAIM_FADE','MSS5_MARKET','MSS15_MARKET','MSS5_FVG_CE','EXPANSION_OB_RETEST')
TARGETS=('CE','OPPOSITE','2R')


def causal_bias(frame):
 available=[];values=[]
 for _,seg in frame.groupby('segment'):
  _,v=ce.rv.htf_bias(seg.set_index('d'))
  available.extend(np.datetime64(datetime.fromtimestamp(int(t)/1000,timezone.utc).astimezone(ZONE).replace(tzinfo=None)) for t in seg.knownAt)
  values.extend(v)
 return np.array(available,dtype='datetime64[ns]'),np.array(values,dtype=int)


def last_pivot(bs,i,side):
 for q in range(i-1,max(0,i-25),-1):
  if q<1:continue
  if side==1 and bs[q]['h']>bs[q-1]['h'] and bs[q]['h']>=bs[q+1]['h']:return bs[q]['h']
  if side==-1 and bs[q]['l']<bs[q-1]['l'] and bs[q]['l']<=bs[q+1]['l']:return bs[q]['l']
 return None


def exit_loop(bs,e,side,entry,stop,tgt,policy,gaps,is_limit=False):
 risk=abs(entry-stop);begin=e
 if is_limit and abs(entry-bs[e]['o'])>bs[e]['price_epsilon']:
  b=bs[e];tp=b['h']>=tgt-b['price_epsilon'] if side==1 else b['l']<=tgt+b['price_epsilon']
  sl=(b['l']<=stop if side==1 else b['h']>=stop) if policy=='HARD5' else (b['c']<stop-b['price_epsilon'] if side==1 else b['c']>stop+b['price_epsilon'])
  if tp:return dict(outcome='unverified',reason='limit_fill_bar_target_sequence_ambiguous',exit_at=None,r=None)
  if sl:
   px=stop if policy=='HARD5' else b['c']
   return dict(outcome='loss',exit_at=b['knownAt'],exit_price=px,r=(px-entry)*side/risk,same_bar_both=False)
  begin=e+1
 for j in range(begin,len(bs)):
  if j>e and abs(bs[j]['o']/bs[j-1]['c']-1)>0.3:return dict(outcome='unverified',reason='large_discontinuity_requires_corporate_action_review',exit_at=None,r=None)
  if j>e and gaps[j]:return dict(outcome='unverified',reason='missing_exit_path',exit_at=None,r=None)
  b=bs[j];eps=b['price_epsilon'];tp=b['h']>=tgt-eps if side==1 else b['l']<=tgt+eps
  sl=(b['l']<=stop if side==1 else b['h']>=stop) if policy=='HARD5' else (b['c']<stop-eps if side==1 else b['c']>stop+eps)
  if policy=='HARD5' and sl:
   px=min(b['o'],stop) if side==1 else max(b['o'],stop);out='loss'
  elif tp:px=tgt;out='win'
  elif sl:px=b['c'];out='loss'
  else:continue
  return dict(outcome=out,exit_at=b['knownAt'],exit_price=px,r=(px-entry)*side/risk,same_bar_both=bool(tp and sl))
 return dict(outcome='open',r=None,exit_at=None)


def worker(task):
 sym,asof_iso=task;t0=time.time();asof=datetime.fromisoformat(asof_iso);since=datetime(2015,7,1,tzinfo=timezone.utc)
 with psycopg2.connect(ce.rv.db_uri()) as con:bs,audit=load_candles(con,'us',sym,since,asof)
 if not bs:return {'sym':sym,'trades':[],'audit':audit,'counts':{},'boxes':0}
 frames=frames_from_bars(bs,'us',sym,since,asof);times=np.array([b['t'] for b in bs]);known=np.array([b['knownAt'] for b in bs]);grid=expected_grid('us',since,asof);pos=np.searchsorted(grid,times);gaps=np.concatenate([[False],np.diff(pos)!=1])
 daily=frames['1d'];bias=causal_bias(daily) if len(daily) else (np.array([],dtype='datetime64[ns]'),np.array([],dtype=int))
 # Completed 4H session-anchored rollups; daily/4H bias is a causal swing-break proxy, not the entire ICT PD matrix.
 bounds=session_bounds('us',datetime.fromtimestamp(times[0]/1000,timezone.utc).astimezone(ZONE).date(),asof.astimezone(ZONE).date());groups={}
 for b in bs:
  begin,end=bounds[b['day']];bucket=begin+((b['t']-begin)//14400000)*14400000;finish=min(bucket+14400000,end);groups.setdefault((bucket,finish),[]).append(b)
 four=[]
 for (begin,end),group in sorted(groups.items()):
  if len(group)==(end-begin)//300000 and all(b['t']==begin+i*300000 for i,b in enumerate(group)):
   four.append(dict(d=pd.Timestamp(datetime.fromtimestamp(begin/1000,timezone.utc).astimezone(ZONE).replace(tzinfo=None)),o=group[0]['o'],h=max(b['h'] for b in group),l=min(b['l'] for b in group),c=group[-1]['c'],knownAt=end))
 expected4=np.array([t for begin,end in bounds.values() for t in range(begin,end,14400000)]);f4=pd.DataFrame(four);four_pos=np.searchsorted(expected4,[int(r.d.to_pydatetime().replace(tzinfo=ZONE).timestamp()*1000) for r in f4.itertuples()]);f4['segment']=np.cumsum(np.concatenate([[False],np.diff(four_pos)!=1]));b4=causal_bias(f4)
 ltf15=rollup_candles(bs,'us','15m');expected15=np.array([t for begin,end in bounds.values() for t in range(begin,end,900000)]);p15=np.searchsorted(expected15,[b['t'] for b in ltf15]);seg15=np.cumsum(np.concatenate([[False],np.diff(p15)!=1]));frames['15m']=pd.DataFrame([dict(sym=sym,d=pd.Timestamp(datetime.fromtimestamp(b['t']/1000,timezone.utc).astimezone(ZONE).replace(tzinfo=None)),knownAt=b['knownAt'],segment=int(seg15[i]),**{k:b[k] for k in 'ohlc'}) for i,b in enumerate(ltf15)]);kt15=np.array([b['knownAt'] for b in ltf15]);trades=[];counts=Counter();box_count=0;prefix_samples=[]
 for tf in ('1d','1h','30m','15m'):
  for cfg0 in ce.CONFIGS:
   cfg={**cfg0,'run_id':VERSION+'_'+tf+'_'+cfg0['name']}
   for _,seg in frames[tf].groupby('segment'):
    if len(seg)<30:continue
    boxes,_=ce.run_sym(sym,seg,cfg,tf,pd.Timestamp('2017-01-01'),bias,cfg['run_id'])
    keys={r.d:int(r.knownAt) for r in seg.itertuples()}
    for box in boxes:
     box_count+=1;conf=keys[pd.Timestamp(box['confirm_date'])];a=int(np.searchsorted(times,conf));window=int(np.searchsorted(times,keys.get(pd.Timestamp(box['end_date']),int(known[-1]))+300000));hi,lo,cepx=box['box_hi'],box['box_lo'],box['ce'];tol=ce.TOL_REL*cepx
     # fixed opportunity window independent of final fate (parent-bar active window).
     confpos=seg.index[seg.d==pd.Timestamp(box['confirm_date'])][0];si=list(seg.index).index(confpos);endknown=int(seg.iloc[min(len(seg)-1,si+ce.TF_SPEC[tf]['max_active'])].knownAt);window=int(np.searchsorted(times,endknown+1));raid=None
     for i in range(a,window):
      if gaps[i]:counts['missing_pre_entry_path']+=1;break
      up=bs[i]['h']>hi+tol;dn=bs[i]['l']<lo-tol
      if up and dn:counts['two_sided_raid_ambiguous']+=1;break
      if up or dn:raid=(i,-1 if up else 1);break
     if raid is None:counts['no_raid']+=1;continue
     ri,side=raid;stop0=bs[ri]['h'] if side==-1 else bs[ri]['l'];decisions={};ext=stop0
     decisions['RAID_FADE']=(ri,side,ext,None,known[ri])
     body=(bs[ri]['c']>hi+tol if side==-1 else bs[ri]['c']<lo-tol)
     if body:decisions['CLOSE_BREAK_FADE']=(ri,side,ext,None,known[ri])
     # Reclaim/MSS discovery scans at most three parent bars after the raid.
     scan_end=min(window,ri+(234 if tf=='1d' else 36 if tf=='1h' else 18 if tf=='30m' else 9)+1)
     level=last_pivot(bs,ri,side);mss=None
     for j in range(ri,scan_end):
      if j>ri and gaps[j]:break
      ext=max(ext,bs[j]['h']) if side==-1 else min(ext,bs[j]['l'])
      if lo-tol<=bs[j]['c']<=hi+tol and 'RECLAIM_FADE' not in decisions:decisions['RECLAIM_FADE']=(j,side,ext,None,known[j])
      if mss is None and level is not None and j>ri and ((side==1 and bs[j]['c']>level+tol) or (side==-1 and bs[j]['c']<level-tol)) and abs(bs[j]['c']-bs[j]['o'])>=0.6*(bs[j]['h']-bs[j]['l']):
       mss=j;decisions['MSS5_MARKET']=(j,side,ext,None,known[j])
     if mss is not None:
      for k in range(mss,min(scan_end,mss+7)):
       if k<2 or any(gaps[m] for m in range(max(ri+1,k-2),k+1)):break
       if side==1 and bs[k]['l']>bs[k-2]['h']:zone=(bs[k-2]['h']+bs[k]['l'])/2
       elif side==-1 and bs[k]['h']<bs[k-2]['l']:zone=(bs[k]['h']+bs[k-2]['l'])/2
       else:continue
       ext=max(b['h'] for b in bs[ri:k+1]) if side==-1 else min(b['l'] for b in bs[ri:k+1]);decisions['MSS5_FVG_CE']=(k,side,ext,zone,known[k]);break
     li=int(np.searchsorted(kt15,known[ri],side='right'))-1;lev15=last_pivot(ltf15,li,side) if li>=2 else None
     if lev15 is not None:
      for k in range(li+1,min(len(ltf15),li+13)):
       b=ltf15[k]
       if b['knownAt']>endknown or b['knownAt']>known[scan_end-1]:break
       j=int(np.searchsorted(known,b['knownAt']))
       if j>=len(bs) or any(gaps[ri+1:j+1]):break
       if ((side==1 and b['c']>lev15+tol) or (side==-1 and b['c']<lev15-tol)) and abs(b['c']-b['o'])>=0.6*(b['h']-b['l']):
        ext=max(z['h'] for z in bs[ri:j+1]) if side==-1 else min(z['l'] for z in bs[ri:j+1]);decisions['MSS15_MARKET']=(j,side,ext,None,b['knownAt']);break
     # Expansion away from equilibrium: close beyond edge, retest the last opposite 5m candle's open.
     if body:
      exp_side=-side
      for q in range(ri-1,max(0,ri-12),-1):
       if (exp_side==1 and bs[q]['c']<bs[q]['o']) or (exp_side==-1 and bs[q]['c']>bs[q]['o']):
        st=bs[q]['l'] if exp_side==1 else bs[q]['h'];decisions['EXPANSION_OB_RETEST']=(ri,exp_side,st,bs[q]['o'],known[ri]);break
     for model in MODELS:
      if model not in decisions:counts[model+':no_confirmation']+=1;continue
      dec,sg,stop,limit,dknown=decisions[model];e=int(np.searchsorted(times,dknown));entry=None
      if e>=len(bs) or gaps[e]:counts[model+':missing_fill_bar']+=1;continue
      if limit is None:entry=bs[e]['o']
      else:
       for k in range(e,min(len(bs),e+24)):
        if k>e and gaps[k]:break
        if (sg==1 and bs[k]['o']<=stop) or (sg==-1 and bs[k]['o']>=stop):break
        if (sg==1 and bs[k]['l']<=limit) or (sg==-1 and bs[k]['h']>=limit):e=k;entry=min(bs[k]['o'],limit) if sg==1 else max(bs[k]['o'],limit);break
       if entry is None:counts[model+':missed_limit']+=1;continue
      risk=(entry-stop)*sg
      if risk<=0 or entry<=0 or stop<=0 or risk/entry<0.002:counts[model+':invalid_or_tiny_risk']+=1;continue
      nowlabel=pd.Timestamp(datetime.fromtimestamp(int(dknown)/1000,timezone.utc).astimezone(ZONE).replace(tzinfo=None));bval=ce.rv.bias_at(bias,nowlabel);four_bias=ce.rv.bias_at(b4,nowlabel);aligned=bval==sg
      for target in TARGETS:
       tgt=cepx if target=='CE' else hi if target=='OPPOSITE' and sg==1 else lo if target=='OPPOSITE' else entry+sg*2*risk
       if tgt<=0 or (tgt-entry)*sg<=0:counts[model+':target_already_passed:'+target]+=1;continue
       if model!='EXPANSION_OB_RETEST' and target in ('CE','OPPOSITE') and any((b['h']>=tgt if sg==1 else b['l']<=tgt) for b in bs[ri+1:e]):counts[model+':objective_reached_before_entry:'+target]+=1;continue
       for policy in ('HARD5','CLOSE5'):
        result=exit_loop(bs,e,sg,entry,stop,tgt,policy,gaps,limit is not None)
        assert times[e]>=dknown and bs[e]['l']-0.0001<=entry<=bs[e]['h']+0.0001
        row=dict(sym=sym,box_hi=hi,box_lo=lo,box_ce=cepx,fill_o=bs[e]['o'],fill_h=bs[e]['h'],fill_l=bs[e]['l'],fill_c=bs[e]['c'],source_fingerprint=audit['fingerprint'],box_id=box['box_id'],box_tf=tf,config=cfg['name'],model=model,target=target,policy=policy,side=sg,confirm_at=conf,raid_at=known[ri],decision_known_at=int(dknown),entry_at=int(times[e]),filled_observed_at=bs[e]['knownAt'],entry=entry,stop=stop,tgt=tgt,plan_r=abs(tgt-entry)/risk,htf_bias=bval,with_bias=aligned,with_4h_bias=four_bias==sg,with_both_bias=aligned and four_bias==sg,bias_4h=four_bias,risk_pct=risk/entry*100,year=datetime.fromtimestamp(times[e]/1000,timezone.utc).astimezone(ZONE).year,**result)
        if result['r'] is not None:
         assert abs((result['exit_price']-entry)*sg/risk-result['r'])<1e-9
         row['net_5bps_r']=result['r']-entry*0.0005/risk;row['net_10bps_r']=result['r']-entry*0.001/risk
        trades.append(row)
 return dict(sym=sym,trades=trades,audit=audit,counts=dict(counts),boxes=box_count,seconds=time.time()-t0)


def main():
 p=argparse.ArgumentParser();p.add_argument('--symbols',nargs='*');p.add_argument('--workers',type=int,default=4);p.add_argument('--asof');a=p.parse_args();asof=a.asof or datetime.now(timezone.utc).isoformat()
 with psycopg2.connect(ce.rv.db_uri()) as con,con.cursor() as cur:cur.execute("SELECT DISTINCT sym FROM consolidation_boxes ORDER BY sym");symbols=a.symbols or [r[0] for r in cur]
 outdir=ROOT/'tmp/consolidation-research';outdir.mkdir(parents=True,exist_ok=True);results=[]
 with ProcessPoolExecutor(max_workers=a.workers) as pool:
  futures={pool.submit(worker,(s,asof)):s for s in symbols}
  for f in as_completed(futures):
   r=f.result();results.append(r);(outdir/(r['sym']+'.json')).write_text(json.dumps(r,default=str),encoding='utf-8');print(r['sym'],'boxes',r['boxes'],'variants',len(r['trades']),'seconds',round(r['seconds']),flush=True)
 allrows=[t for r in results for t in r['trades']];df=pd.DataFrame(allrows);df.to_csv(ROOT/'public/reports/consolidation-research-trades.csv',index=False)
 report=dict(version=VERSION,source=SOURCE_VERSION,asof=asof,universe=symbols,box_parameters='existing standard/tight ATR/swing detector; reconstructed from complete raw5m rolls, segment gaps',entry_models=list(MODELS),targets=list(TARGETS),exit_policies={'HARD5':'hard5m wick SL; stop first; favorable target gaps capped at target','CLOSE5':'strict5m close SL; wick TP first; full close loss'},limits='24 five-minute bars; limit fill bars touching either exit are unverified due intrabar sequence ambiguity',risk_floor_pct=0.2,bias_proxy='completed 2-bar fractal swing-break order flow; Daily and4H available at exact completed bucket close, reset across missing higher-timeframe bins; not full ICT PD matrix',costs='5bps and10bps round-trip sensitivity, not observed broker fees',structural_objectives='CE/opposite fades cancelled if objective already traded after raid but before fill;2R is a synthetic comparison',large_discontinuity='entry/exit paths with over30% opening discontinuity require corporate-action review',samples=[{k:v for k,v in r.items() if k!='trades'} for r in results],rows=len(df),metrics=[],walk_forward=[])
 for bias_filter in ('all','daily','4h','both'):
  sub=df if bias_filter=='all' else df[df[{'daily':'with_bias','4h':'with_4h_bias','both':'with_both_bias'}[bias_filter]]]
  for keys,g in sub.groupby(['box_tf','config','model','target','policy']):
   scored=g[g.outcome.isin(['win','loss'])];r=scored.r;net=scored.net_5bps_r
   years=[]
   for y,yg in scored.groupby('year'):years.append(dict(year=int(y),n=len(yg),net_r=float(yg.net_5bps_r.sum()),avg_r=float(yg.net_5bps_r.mean())))
   report['metrics'].append(dict(zip(['box_tf','config','model','target','policy'],keys),bias_filter=bias_filter,n=len(g),closed=len(scored),wins=int((scored.outcome=='win').sum()),win_pct=float((scored.outcome=='win').mean()*100) if len(scored) else None,avg_r=float(r.mean()) if len(scored) else None,net_r=float(r.sum()),net_5bps_r=float(net.sum()),avg_net_5bps_r=float(net.mean()) if len(scored) else None,net_10bps_r=float(scored.net_10bps_r.sum()),open=int((g.outcome=='open').sum()),unverified=int((g.outcome=='unverified').sum()),worst_r=float(r.min()) if len(scored) else None,years=years))
 # Annual expanding walk-forward winner selected only from entries AND exits before test-year start.
 for policy in ('HARD5','CLOSE5'):
  for tf in ('1d','1h','30m','15m'):
   for year in range(2022,2027):
    bound=int(datetime(year,1,1,tzinfo=ZONE).timestamp()*1000);train=df[(df.policy==policy)&(df.box_tf==tf)&(df.year<year)&(df.exit_at<bound)&df.outcome.isin(['win','loss'])]
    groups=train.groupby(['config','model','target']).net_5bps_r.agg(['count','mean']);groups=groups[groups['count']>=100]
    if not len(groups):continue
    winner=groups['mean'].idxmax();test=df[(df.policy==policy)&(df.box_tf==tf)&(df.year==year)&(df.config==winner[0])&(df.model==winner[1])&(df.target==winner[2])&df.outcome.isin(['win','loss'])]
    report['walk_forward'].append(dict(policy=policy,box_tf=tf,year=year,selected=list(winner),train_n=int(groups.loc[winner,'count']),train_avg_net_r=float(groups.loc[winner,'mean']),test_n=len(test),test_net_r=float(test.net_5bps_r.sum()),test_avg_net_r=float(test.net_5bps_r.mean()) if len(test) else None))
 report['code_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest();(ROOT/'public/reports/consolidation-research-results.json').write_text(json.dumps(report,default=str,indent=2),encoding='utf-8');print('COMPLETE',len(df),flush=True)
if __name__=='__main__':main()
