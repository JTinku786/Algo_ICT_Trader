"""Read-only closed-trade selection audit. No portfolio allocation or live promotion."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import json,math,statistics
from pathlib import Path
from collections import defaultdict
from datetime import datetime,timezone
from zoneinfo import ZoneInfo
import numpy as np

BUCKETS=['0-1','1-2','2-3','3-4','4+']
def economic_key(r):
 return (r['symbol'],r['market'],r['side'],r['entryAt'],r['entry'],r['stop'],r['target'],r['rrBucket'])
def realized(r,bps=0):
 if r.get('result') not in ('WIN','LOSS'):return None
 risk=abs(r['entry']-r['stop']);return float(r['r'])-(abs(r['entry'])*bps/10000/risk if risk else 0)
def stamp(year):return int(datetime(year,1,1,tzinfo=ZoneInfo('America/New_York')).timestamp()*1000)
def stats(rows,bps=0):
 closed=sorted([r for r in rows if r.get('result') in ('WIN','LOSS')],key=lambda r:(r['exitAt'],r['id']))
 v=[realized(r,bps) for r in closed];pos=sum(x for x in v if x>0);neg=-sum(x for x in v if x<0);equity=peak=dd=0
 settlements=defaultdict(float);year_returns=defaultdict(float)
 for r,x in zip(closed,v):settlements[r['exitAt']]+=x;year_returns[datetime.fromtimestamp(r['entryAt']/1000,timezone.utc).year]+=x
 for x in settlements.values():equity+=x;peak=max(peak,equity);dd=max(dd,peak-equity)
 return {'closed':len(v),'open':sum(r.get('result')=='OPEN' for r in rows),'winRate':sum(x>0 for x in v)/len(v) if v else None,'netR':sum(v),'expectancyR':statistics.mean(v) if v else None,'profitFactor':pos/neg if neg else None,'maxDrawdownR':dd,'positiveYears':sum(v>0 for v in year_returns.values())}
def monthly_ci(rows):
 blocks=defaultdict(lambda:[0,0])
 for r in rows:
  value=realized(r)
  if value is None:continue
  key=datetime.fromtimestamp(r['entryAt']/1000,timezone.utc).strftime('%Y-%m');blocks[key][0]+=value;blocks[key][1]+=1
 if len(blocks)<6:return None
 a=np.array(list(blocks.values()),dtype=float);rng=np.random.default_rng(1701);means=[]
 for _ in range(300):
  b=a[rng.integers(0,len(a),len(a))];means.append(b[:,0].sum()/b[:,1].sum())
 return {'low':float(np.percentile(means,2.5)),'high':float(np.percentile(means,97.5)),'method':'300 calendar-month block resamples; gross expectancy, not multiple-testing-adjusted','blocks':len(a)}
def pair_keys(r):
 attrs=r.get('attributions') or [{'tf1Kind':r.get('tf1Kind'),'tf2Kind':r.get('tf2Kind'),'confirmation':r.get('confirmation')}]
 return {(r['market'],a['tf1Kind'],a['tf2Kind'],a['confirmation'],r['rrBucket']) for a in attrs}
def analyze_json(root):
 root=Path(root);manifest=json.loads((root/'summary.json').read_text(encoding='utf-8'));rows={}
 files=manifest.get('files') or manifest.get('tradeFiles') or [str(p.relative_to(root)) for p in root.glob('*/trades.ndjson')]
 for file in files:
  path=root/(file['path'] if isinstance(file,dict) else file)
  with path.open(encoding='utf-8') as f:
   for line in f:
    if line.strip():
     r=json.loads(line);key=economic_key(r)
     if key not in rows:rows[key]=r
     else:
      existing=rows[key];existing['attributions']=(existing.get('attributions') or [{'tf1Kind':existing['tf1Kind'],'tf2Kind':existing['tf2Kind'],'confirmation':existing['confirmation']}])+(r.get('attributions') or [{'tf1Kind':r['tf1Kind'],'tf2Kind':r['tf2Kind'],'confirmation':r['confirmation']}])
 groups=defaultdict(list)
 for r in rows.values():
  for key in pair_keys(r):groups[key].append(r)
 cutoff=stamp(2024);rank=[]
 for key,group in groups.items():
  train=[r for r in group if r['entryAt']<cutoff and r.get('exitAt') is not None and r['exitAt']<cutoff]
  test=[r for r in group if r['entryAt']>=cutoff];tr=stats(train);te=stats(test)
  rank.append({'market':key[0],'tf1Kind':key[1],'tf2Kind':key[2],'confirmation':key[3],'rrBucket':key[4],'train':tr,'holdout':te,'all':stats(group),'holdoutCostSensitivity':{str(b):stats(test,b) for b in (0,1,2,5)},'holdoutExpectancyCI':monthly_ci(test),'selectionEligible':tr['closed']>=30})
 recommendations=[]
 for market in sorted({k[0] for k in groups}):
  eligible=[r for r in rank if r['market']==market and r['selectionEligible']]
  best=max(eligible,key=lambda r:(r['train']['expectancyR'],r['train']['netR'])) if eligible else None
  recommendations.append({'market':market,'selectedOn':'2017–2023 trades closed before 2024; maximum gross training expectancy with at least 30 closed trades','choice':best,'verdict':'INSUFFICIENT_SAMPLE' if not best else 'HOLDOUT_POSITIVE' if best['holdout']['closed']>=30 and best['holdout']['netR']>0 and best['holdoutCostSensitivity']['2']['netR']>0 else 'NOT_CONFIRMED_IN_HOLDOUT','lockedForEvaluationOnly':True})
 walk=[]
 for year in range(2020,2027):
  boundary=stamp(year);next_=stamp(year+1)
  for market in sorted({k[0] for k in groups}):
   options=[]
   for key,group in groups.items():
    if key[0]!=market:continue
    training=[r for r in group if r['entryAt']<boundary and r.get('exitAt') is not None and r['exitAt']<boundary];st=stats(training)
    if st['closed']>=30:options.append((st['expectancyR'],st['netR'],key,group,st))
   if not options:continue
   _,_,key,group,training=max(options,key=lambda x:(x[0],x[1]))
   held=[r for r in group if boundary<=r['entryAt']<next_]
   walk.append({'year':year,'market':market,'selectedPair':{'tf1Kind':key[1],'tf2Kind':key[2],'confirmation':key[3],'rrBucket':key[4]},'training':training,'test':stats(held),'testCostSensitivity':{str(b):stats(held,b) for b in (1,2,5)}})
 report={'generatedAt':datetime.now(timezone.utc).isoformat(),'status':manifest.get('status'),'holdoutStart':'2024-01-01','selectionPolicy':'No full-period optimum promoted. Each market choice selected using pre-2024 closed outcomes only; assessed on 2024 onward and separate expanding-year walk-forward. Descriptive pair metrics overlap and must not be added as portfolio profit.','costPolicy':'Gross completed-OHLC returns in R; round-trip 1/2/5 basis point sensitivity. No bid/ask, commission, actual spread or live execution claim. Entry candle skipped as dashboard contract; same later candle touching stop and target is a loss.','recommendationsByMarket':recommendations,'walkForward':walk,'rankings':rank,'uniqueEconomicScenarios':len(rows)}
 (root/'validation.json').write_text(json.dumps(report,allow_nan=False,indent=2),encoding='utf-8');return report
def analyze_index(root):
 import sqlite3
 from scalping_backtest_sqlite import blank,merge
 root=Path(root);manifest_path=root/'summary.json' if (root/'summary.json').exists() else root/'manifest.json';manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
 db=sqlite3.connect(f"file:{(root/'results.sqlite').as_posix()}?mode=ro",uri=True)
 db.execute('BEGIN')
 groups=defaultdict(list)
 for market,year,month,tf1,tf2,confirmation,bucket,payload in db.execute('SELECT market,entryYear,exitMonth,tf1Kind,tf2Kind,confirmation,rrBucket,metrics FROM pair_period_stats'):
  groups[(market,tf1,tf2,confirmation,bucket)].append((year,month,json.loads(payload)))
 def aggregate(records,bps='0'):
  total=blank();monthly=defaultdict(float);years=defaultdict(float)
  for year,month,m in records:
   value=m if bps=='0' else m['costs'][bps];merge(total,value)
   if month:monthly[month]+=value['grossR'];years[year]+=value['grossR']
  equity=peak=dd=0
  for month in sorted(monthly):equity+=monthly[month];peak=max(peak,equity);dd=max(dd,peak-equity)
  n=total['closed'];return {'closed':n,'open':total['open'],'winRate':total['wins']/n if n else None,'netR':total['grossR'],'expectancyR':total['grossR']/n if n else None,'profitFactor':total['positiveR']/total['negativeR'] if total['negativeR'] else None,'maxDrawdownR':dd,'drawdownFrequency':'calendar-month realized settlements','positiveYears':sum(v>0 for v in years.values()),'activeYears':len(years)}
 def ci(records):
  months=defaultdict(lambda:[0,0])
  for _,month,m in records:
   if month and m['closed']:months[month][0]+=m['grossR'];months[month][1]+=m['closed']
  if len(months)<6:return None
  a=np.array(list(months.values()),dtype=float);rng=np.random.default_rng(1701);means=[]
  for _ in range(300):
   b=a[rng.integers(0,len(a),len(a))];means.append(b[:,0].sum()/b[:,1].sum())
  return {'low':float(np.percentile(means,2.5)),'high':float(np.percentile(means,97.5)),'method':'300 exit-calendar-month block resamples; gross expectancy; not multiple-testing-adjusted','blocks':len(a)}
 rankings=[]
 for key,records in groups.items():
  train=[x for x in records if x[0]<2024 and x[1] and x[1]<'2024-01'];test=[x for x in records if x[0]>=2024];tr=aggregate(train);te=aggregate(test)
  rankings.append({'market':key[0],'tf1Kind':key[1],'tf2Kind':key[2],'confirmation':key[3],'rrBucket':key[4],'train':tr,'holdout':te,'all':aggregate(records),'trainCostSensitivity':{str(b):aggregate(train,str(b)) for b in (1,2,5)},'holdoutCostSensitivity':{str(b):aggregate(test,str(b)) for b in (1,2,5)},'holdoutExpectancyCI':ci(test),'selectionEligible':tr['closed']>=100 and tr['activeYears']>=3})
 done=manifest.get('status')=='COMPLETE';recommendations=[];markets=sorted({k[0] for k in groups})
 for market in markets:
  eligible=[r for r in rankings if r['market']==market and r['selectionEligible']]
  best=max(eligible,key=lambda r:(r['trainCostSensitivity']['2']['netR'],r['train']['netR'])) if eligible and done else None
  recommendations.append({'market':market,'selectedOn':'2017–2023 trades closed before 2024; maximum training R after assumed 2bps round-trip friction, with at least100closedtrades across3trainingyears','choice':best,'verdict':'RUN_INCOMPLETE' if not done else 'INSUFFICIENT_SAMPLE' if not best else 'HOLDOUT_POSITIVE' if best['holdout']['closed']>=100 and best['holdoutCostSensitivity']['2']['netR']>0 else 'NOT_CONFIRMED_IN_HOLDOUT','lockedForEvaluationOnly':True})
 walk=[]
 if done:
  for year in range(2020,2027):
   for market in markets:
    options=[]
    for key,records in groups.items():
     if key[0]!=market:continue
     train=[x for x in records if x[0]<year and x[1] and x[1]<f'{year}-01'];s=aggregate(train,'2')
     if s['closed']>=100 and s['activeYears']>=3:options.append((s['netR'],key,records,s))
    if not options:continue
    _,key,records,training=max(options,key=lambda x:x[0]);held=[x for x in records if x[0]==year]
    walk.append({'year':year,'market':market,'selectedPair':{'tf1Kind':key[1],'tf2Kind':key[2],'confirmation':key[3],'rrBucket':key[4]},'training':training,'test':aggregate(held),'testCostSensitivity':{str(b):aggregate(held,str(b)) for b in (1,2,5)}})
 unique=db.execute('SELECT COUNT(*) FROM trades').fetchone()[0];db.close()
 report={'generatedAt':datetime.now(timezone.utc).isoformat(),'status':manifest.get('status'),'holdoutStart':'2024-01-01','calendarTimezone':'America/New_York','selectionPolicy':'Independent market choices selected using pre-2024 closed outcomes at assumed2bps cost; assessed on2024onward and expanding-year walk-forward.100closedtrades/3trainingyears required. No full-period optimum promoted. Pair attribution groups and all R:R scenarios overlap; do not sum into portfolio profit.','costPolicy':'Gross completed-OHLC R plus assumed round-trip1/2/5bps sensitivity. No bid/ask, actual spread, commission or live execution claim. Entry candle skipped; later same-candle stop+target loses. Monthly settlement drawdown is coarser than trade drawdown.','recommendationsByMarket':recommendations,'walkForward':walk,'rankings':rankings,'uniqueEconomicScenarios':unique}
 (root/'validation.json').write_text(json.dumps(report,allow_nan=False,indent=2),encoding='utf-8');return report

def analyze(root):
 return analyze_index(root) if (Path(root)/'results.sqlite').exists() else analyze_json(root)

if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--root',default=str(SCALPING_BACKTEST));a=p.parse_args();r=analyze(a.root);print(json.dumps({'uniqueEconomicScenarios':r['uniqueEconomicScenarios'],'groups':len(r['rankings']),'choices':[(x['market'],x['verdict']) for x in r['recommendationsByMarket']]}))
