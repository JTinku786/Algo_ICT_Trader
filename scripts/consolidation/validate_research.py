"""Independent raw candle reconciliation and fail-closed coverage audit of research CSVs."""
import sys,json,time,csv
from pathlib import Path
from datetime import datetime,timezone
from collections import Counter
from concurrent.futures import ProcessPoolExecutor,as_completed
import numpy as np,pandas as pd,psycopg2
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(Path.home()/"Desktop/ICT_Automation/realtime_execution"));sys.path.insert(0,str(Path.home()/"Desktop/ICT_Automation/trend_reversal_2026"))
from reversal_candle_source import load_candles,session_bounds,ZONE
from reversal_exit_policy import expected_grid
import reversal_engine as rv

def worker(task):
 sym,asof_iso,paths=task;t0=time.time();frames=[]
 for folder in ('consolidation-research','consolidation-prearmed'):
  obj=json.loads((ROOT/'tmp'/folder/(sym+'.json')).read_text(encoding='utf-8'));frames.append(pd.DataFrame(obj['trades']))
 df=pd.concat(frames,ignore_index=True);
 for key in ('entry_at','raid_at','decision_known_at','confirm_at','filled_observed_at','exit_at'):df[key]=pd.to_numeric(df[key],errors='raise')
 asof=datetime.fromisoformat(asof_iso);since=datetime(2015,7,1,tzinfo=timezone.utc)
 with psycopg2.connect(rv.db_uri()) as con:bars,audit=load_candles(con,'us',sym,since,asof)
 t=np.array([b['t'] for b in bars]);known=t+300000;o,h,l,c=(np.array([b[k] for b in bars]) for k in 'ohlc');eps=np.array([b['price_epsilon'] for b in bars]);grid=expected_grid('us',since,asof);pos=np.searchsorted(grid,t);gap=np.concatenate([[False],np.diff(pos)!=1]);gap_prefix=np.cumsum(gap);checks=Counter();corrections=[];examples=[];done_examples=set();day_rows=[];unsafe=np.concatenate([[False],np.abs(o[1:]/c[:-1]-1)>0.3])|gap;bounds=session_bounds('us',since.astimezone(ZONE).date(),asof.astimezone(ZONE).date())
 def resolve_open_fill(r,e):
  for a in range(e,len(t),128):
   z=min(a+128,len(t));tp=(h[a:z]>=r.tgt-eps[a:z]) if r.side==1 else (l[a:z]<=r.tgt+eps[a:z]);sl=((l[a:z]<=r.stop) if r.side==1 else (h[a:z]>=r.stop)) if r.policy=='HARD5' else ((c[a:z]<r.stop-eps[a:z]) if r.side==1 else (c[a:z]>r.stop+eps[a:z]));bad=unsafe[a:z].copy()
   if a==e:bad[0]=False
   events=np.flatnonzero(tp|sl|bad)
   if not len(events):continue
   k=int(events[0]);x=a+k
   if bad[k]:return dict(outcome='unverified',reason='missing_or_discontinuous_exit_path',r=np.nan,exit_at=np.nan,exit_price=np.nan,net_5bps_r=np.nan,net_10bps_r=np.nan)
   if r.policy=='HARD5' and sl[k]:out='loss';px=min(o[x],r.stop) if r.side==1 else max(o[x],r.stop)
   elif tp[k]:out='win';px=r.tgt
   else:out='loss';px=c[x]
   rr=(px-r.entry)*r.side/abs(r.entry-r.stop)
   return dict(outcome=out,reason=None,r=rr,exit_at=int(known[x]),exit_price=float(px),net_5bps_r=rr-r.entry*0.0005/abs(r.entry-r.stop),net_10bps_r=rr-r.entry*0.001/abs(r.entry-r.stop))
  return dict(outcome='open',reason=None,r=np.nan,exit_at=np.nan,exit_price=np.nan,net_5bps_r=np.nan,net_10bps_r=np.nan)

 for ix,r in df.iterrows():
  e=int(np.searchsorted(t,r.entry_at));assert e<len(t) and t[e]==r.entry_at
  if not (r.entry>0 and r.stop>0 and r.tgt>0 and (r.entry-r.stop)*r.side>0 and (r.tgt-r.entry)*r.side>0):
   df.loc[ix,['outcome','reason']]=['invalid_execution','invalid_price_geometry'];df.loc[ix,['r','exit_price','exit_at','net_5bps_r','net_10bps_r']]=np.nan;checks['invalid_geometry_reclassified']+=1;continue
  assert r.entry_at>=r.decision_known_at>=r.confirm_at and r.filled_observed_at==r.entry_at+300000
  assert l[e]-0.0001<=r.entry<=h[e]+0.0001
  assert str(r.source_fingerprint)==audit['fingerprint']
  checks['entry_clock_geometry_source']+=1
  if not r.model.startswith('PREARMED'):
   assert r.decision_known_at>=r.raid_at
   if r.model in ('RAID_FADE','CLOSE_BREAK_FADE','RECLAIM_FADE','MSS5_MARKET','MSS15_MARKET'):assert e==int(np.searchsorted(t,r.decision_known_at)) and abs(o[e]-r.entry)<1e-7
  first=int(np.searchsorted(t,r.confirm_at));missing=gap[e] if first==e else gap_prefix[e]-(gap_prefix[first-1] if first else 0)>0
  if missing:
   if r.outcome in ('win','loss'):corrections.append(dict(index=int(ix),reason='missing_confirm_to_fill_path',prior_outcome=r.outcome,prior_r=float(r.r)))
   df.loc[ix,['outcome','reason']]=['unverified','missing_confirm_to_fill_path'];df.loc[ix,['r','exit_price','exit_at','net_5bps_r','net_10bps_r']]=np.nan;checks['source_gate_reclassified']+=1;continue
  is_limit=r.model in ('MSS5_FVG_CE','EXPANSION_OB_RETEST') or r.model.startswith('PREARMED')
  opening_fill=is_limit and abs(r.entry-o[e])<=eps[e]
  f_tp=(h[e]>=r.tgt-eps[e]) if r.side==1 else (l[e]<=r.tgt+eps[e])
  f_sl=((l[e]<=r.stop) if r.side==1 else (h[e]>=r.stop)) if r.policy=='HARD5' else ((c[e]<r.stop-eps[e]) if r.side==1 else (c[e]>r.stop+eps[e]))
  if is_limit and (opening_fill or (f_sl and not f_tp)):
   update=resolve_open_fill(r,e)
   for k,v in update.items():df.loc[ix,k]=v
   r=df.loc[ix];checks['unambiguous_limit_fill_resolved']+=1
  elif is_limit and f_tp:
   df.loc[ix,['outcome','reason']]=['unverified','limit_fill_bar_target_sequence_ambiguous'];df.loc[ix,['r','exit_price','exit_at','net_5bps_r','net_10bps_r']]=np.nan;r=df.loc[ix]
  # Independent fixed session-close counterpart, including cases whose multiday path later becomes missing.
  end_ms=bounds[bars[e]['day']][1];last=int(np.searchsorted(t,end_ms))-1;start_day=e+1 if is_limit and not opening_fill and not (f_sl and not f_tp) else e
  fresh=r.to_dict();fresh['policy']=r.policy+'_EOD';fresh['reason']=None;fresh['r']=fresh['exit_at']=fresh['exit_price']=fresh['net_5bps_r']=fresh['net_10bps_r']=np.nan;fresh['outcome']='unverified'
  fill_limit=start_day==e+1
  fill_tp=(h[e]>=r.tgt if r.side==1 else l[e]<=r.tgt)
  fill_sl=(l[e]<=r.stop if r.side==1 else h[e]>=r.stop) if r.policy=='HARD5' else (c[e]<r.stop if r.side==1 else c[e]>r.stop)
  if fill_limit and fill_tp:fresh['reason']='limit_fill_bar_exit_ambiguous'
  else:
   dtp=(h[start_day:last+1]>=r.tgt-eps[start_day:last+1]) if r.side==1 else (l[start_day:last+1]<=r.tgt+eps[start_day:last+1])
   dsl=((l[start_day:last+1]<=r.stop) if r.side==1 else (h[start_day:last+1]>=r.stop)) if r.policy=='HARD5' else ((c[start_day:last+1]<r.stop-eps[start_day:last+1]) if r.side==1 else (c[start_day:last+1]>r.stop+eps[start_day:last+1]))
   hits_day=np.flatnonzero(dtp|dsl);xday=start_day+int(hits_day[0]) if len(hits_day) else last
   session_unsafe=gap[e+1:xday+1].any() or (np.abs(o[e+1:xday+1]/c[e:xday]-1)>0.3).any()
   if session_unsafe:fresh['reason']='missing_or_discontinuous_session_path'
   elif not len(hits_day) and (last<e or known[last]!=end_ms):fresh['reason']='missing_session_close'
   else:
    if len(hits_day) and r.policy=='HARD5' and dsl[hits_day[0]]:out='loss';px=min(o[xday],r.stop) if r.side==1 else max(o[xday],r.stop)
    elif len(hits_day) and dtp[hits_day[0]]:out='win';px=r.tgt
    elif len(hits_day):out='loss';px=c[xday]
    else:out='time_exit';px=c[last]
    rr=(px-r.entry)*r.side/abs(r.entry-r.stop);fresh.update(outcome=out,exit_at=int(known[xday]),exit_price=float(px),r=float(rr),net_5bps_r=float(rr-r.entry*0.0005/abs(r.entry-r.stop)),net_10bps_r=float(rr-r.entry*0.001/abs(r.entry-r.stop)))
    checks['independent_session_flat_scored']+=1
  day_rows.append(fresh)
  if r.outcome=='open' and len(grid) and t[-1]<grid[-1]:
   df.loc[ix,['outcome','reason']]=['unverified','missing_trailing_exit_path'];checks['open_with_missing_trailing_path_reclassified']+=1;continue
  if r.outcome not in ('win','loss'):
   assert pd.isna(r.r);checks['unscored_null_r']+=1;continue
  x=int(np.searchsorted(known,r.exit_at));assert x<len(t) and known[x]==r.exit_at
  start=e+1 if is_limit and not opening_fill and not (f_sl and not f_tp) else e
  assert x>=start
  assert not gap[start:x+1].any()
  assert not (np.abs(o[max(e+1,start):x+1]/c[max(e+1,start)-1:x]-1)>0.3).any()
  tp=(h[start:x+1]>=r.tgt-eps[start:x+1]) if r.side==1 else (l[start:x+1]<=r.tgt+eps[start:x+1])
  if r.policy=='HARD5':sl=(l[start:x+1]<=r.stop) if r.side==1 else (h[start:x+1]>=r.stop)
  else:sl=(c[start:x+1]<r.stop-eps[start:x+1]) if r.side==1 else (c[start:x+1]>r.stop+eps[start:x+1])
  hits=np.flatnonzero(tp|sl);assert len(hits) and hits[0]+start==x,(sym,r.model,r.entry_at,r.exit_at)
  if r.policy=='HARD5' and sl[-1]:out='loss';px=min(o[x],r.stop) if r.side==1 else max(o[x],r.stop)
  elif tp[-1]:out='win';px=r.tgt
  else:out='loss';px=c[x]
  rr=(px-r.entry)*r.side/abs(r.entry-r.stop);assert out==r.outcome and abs(px-r.exit_price)<1e-6 and abs(rr-r.r)<1e-7
  assert abs(r.net_5bps_r-(rr-r.entry*0.0005/abs(r.entry-r.stop)))<1e-7
  assert abs(r.net_10bps_r-(rr-r.entry*0.001/abs(r.entry-r.stop)))<1e-7
  checks['independent_first_hit_r_cost']+=1
  key=(r.model,r.outcome)
  if r.box_tf=='1h' and r.config=='tight' and r.target=='CE' and r.policy=='CLOSE5' and key not in done_examples:
   done_examples.add(key);examples.append(dict(sym=sym,model=r.model,outcome=r.outcome,entry_at=int(r.entry_at),decision_known_at=int(r.decision_known_at),entry=float(r.entry),stop=float(r.stop),target=float(r.tgt),r=float(r.r),exit_at=int(r.exit_at),exit_ohlc=bars[x],box_hi=float(r.box_hi),box_lo=float(r.box_lo),box_ce=float(r.box_ce),trace=bars[max(0,e-3):min(x+1,e+30)]))
 merged=pd.concat([df,pd.DataFrame(day_rows)],ignore_index=True);output=ROOT/'tmp/consolidation-research-audited'/(sym+'.csv');merged.to_csv(output,index=False)
 return dict(sym=sym,checks=dict(checks),corrections=corrections,examples=examples,rows=len(merged),output=str(output),seconds=time.time()-t0)

def main():
 r=json.loads((ROOT/'public/reports/consolidation-research-results.json').read_text(encoding='utf-8'));paths=[str(ROOT/'public/reports/consolidation-research-trades.csv'),str(ROOT/'public/reports/consolidation-prearmed-trades.csv')];results=[];outdir=ROOT/'tmp/consolidation-research-audited';outdir.mkdir(parents=True,exist_ok=True)
 with ProcessPoolExecutor(max_workers=4) as pool:
  for f in as_completed([pool.submit(worker,(sym,r['asof'],paths)) for sym in r['universe']]):
   x=f.result();results.append(x);print(x['sym'],x['checks'],flush=True)
 keys=set()
 for x in results:
  with open(x['output'],encoding='utf-8',newline='') as f:keys.update(next(csv.reader(f)))
 keys=sorted(keys);temporary=[Path(path+'.audited.tmp') for path in paths]
 with temporary[0].open('w',encoding='utf-8',newline='') as fa,temporary[1].open('w',encoding='utf-8',newline='') as fb:
  writers=[csv.DictWriter(f,fieldnames=keys) for f in (fa,fb)]
  for w in writers:w.writeheader()
  for x in results:
   with open(x['output'],encoding='utf-8',newline='') as f:
    for row in csv.DictReader(f):writers[int(row['model'].startswith('PREARMED'))].writerow(row)
 for src,dst in zip(temporary,paths):src.replace(dst)
 rows=sum(x['rows'] for x in results)
 checks=Counter()
 for x in results:checks.update(x['checks'])
 report=dict(verdict='PASS_RESEARCH_RECONCILIATION',rows=rows,checks=dict(checks),source_gate_corrections=[{k:v for k,v in x.items() if k in ('sym','corrections')} for x in results if x['corrections']],examples=[e for x in results for e in x['examples']],source_boundary='canonical raw5m fingerprint equality; price basis corporate action economic verification not certified',limits='Coverage gates conservatively reclassify unsupported trades; no claim of broker fills or literal complete ICT strategy')
 (ROOT/'public/reports/consolidation-research-validation.json').write_text(json.dumps(report,default=str,indent=2),encoding='utf-8');print('PASS',rows,dict(checks),flush=True)
if __name__=='__main__':main()
