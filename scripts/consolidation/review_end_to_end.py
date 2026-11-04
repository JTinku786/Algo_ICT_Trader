"""Read-only full-population, API, export, chart and native-source audit."""
import sys,json,csv,io,math,requests
from pathlib import Path
from datetime import datetime,timezone
from zoneinfo import ZoneInfo
import psycopg2
from psycopg2.extras import RealDictCursor
sys.path.insert(0,str(Path.home()/"Desktop/ICT_Automation/trend_reversal_2026"))
import reversal_engine as rv
sys.path.insert(0,str(Path.home()/"Desktop/ICT_Automation/realtime_execution"))
from reversal_candle_source import load_candles,rollup_candles
ROOT=Path(__file__).resolve().parents[2]
con=psycopg2.connect(rv.db_uri());cur=con.cursor(cursor_factory=RealDictCursor)
cur.execute("SELECT DISTINCT ON(timeframe,period,config_name) * FROM consolidation_runs ORDER BY timeframe,period,config_name,created_at DESC")
runs=list(cur); report={"generated_at":datetime.now(timezone.utc).isoformat(),"rule_lineage":"LOCAL_ADAPTATION","runs":[],"api":[],"source_samples":[]}
for run in runs:
 rid=run['run_id'];cur.execute("""SELECT count(*) n,count(*) FILTER(WHERE entry_date<=trigger_date) bad_clock,
 count(*) FILTER(WHERE entry<=0 OR stop<=0 OR tgt<=0 OR entry=stop OR (side='bull' AND (stop>=entry OR tgt<=entry)) OR (side='bear' AND (stop<=entry OR tgt>=entry))) bad_geometry,
 count(*) FILTER(WHERE exit_date<entry_date) bad_exit_clock,
 count(*) FILTER(WHERE abs(plan_r-abs(tgt-entry)/nullif(abs(entry-stop),0))>1e-6) bad_plan_r,
 count(*) FILTER(WHERE abs(r-pct*entry/100/nullif(abs(entry-stop),0))>1e-6) bad_actual_r
 FROM consolidation_trades WHERE run_id=%s""",(rid,))
 checks=dict(cur.fetchone());report['runs'].append({'run_id':rid,'checks':checks,'stored_validation':run['summary'].get('validation'), 'data_quality':run['params'].get('data_quality',[])})
 for model,target in [(m,t) for m in ('SWEEP_FADE','BREAK_NEXT_OPEN','BREAK_CE_LIMIT') for t in (('CE','opp_edge','1R','2R','3R','measured') if m=='SWEEP_FADE' else ('1R','2R','3R','measured'))]:
  for sym,fate in (('',''),('GE',''),('','manipulation_then_expansion')):
   args={'tf':run['timeframe'],'run':rid,'model':model,'target':target,'sym':sym,'fate':fate}
   res=requests.get('http://localhost:3000/api/consolidation',params=args,timeout=120);res.raise_for_status();p=res.json();assert p['ok'],p
   cur.execute("""SELECT count(*) n,count(*) FILTER(WHERE outcome IN('win','loss','timeout') AND entry>0 AND stop>0 AND tgt>0 AND ((side='bull' AND stop<entry AND tgt>entry) OR (side='bear' AND stop>entry AND tgt<entry))) scored,
 coalesce(sum(r) FILTER(WHERE outcome IN('win','loss','timeout') AND entry>0 AND stop>0 AND tgt>0 AND ((side='bull' AND stop<entry AND tgt>entry) OR (side='bear' AND stop>entry AND tgt<entry))),0) net_r FROM consolidation_trades WHERE run_id=%s AND model=%s AND target=%s AND risk_ok AND (%s='' OR sym=%s) AND (%s='' OR fate=%s)""",(rid,model,target,sym,sym,fate,fate));db=cur.fetchone()
   grid=next((x for x in p['grid'] if x['model']==model and x['target']==target),{'n':0,'sum_r':0})
   assert db['n']==p['totals']['trades'] and db['scored']==grid['n'] and abs(db['net_r']-(grid['sum_r'] or 0))<1e-7,(rid,args,db,grid)
   assert all((not sym or x['sym']==sym) and (not fate or x['fate']==fate) for x in p['trades'])
   if not sym and not fate:
    exp=requests.get('http://localhost:3000/api/consolidation',params={**args,'format':'csv','view':'trades'},timeout=120);exp.raise_for_status();rows=list(csv.DictReader(io.StringIO(exp.text.lstrip('\ufeff'))));assert len(rows)==db['n']==int(exp.headers['X-Export-Row-Count'])
   report['api'].append({'run_id':rid,**args,'n':db['n'],'scored':db['scored'],'net_r':db['net_r'],'verdict':'PASS'})
# Native entry source samples independent of engine preprocessing.
for sym in ('GE','DD','SPY'):
 bars,audit=load_candles(con,'us',sym,datetime(2016,1,1,tzinfo=timezone.utc),datetime.now(timezone.utc))
 for tf in ('1d','1h','30m'):
  native={ (b['day'] if tf=='1d' else datetime.fromtimestamp(b['t']/1000,timezone.utc).astimezone(ZoneInfo('America/New_York')).strftime('%Y-%m-%d %H:%M')):b for b in rollup_candles(bars,'us',tf)}
  cur.execute("""SELECT DISTINCT t.entry_date,t.entry,t.model FROM consolidation_trades t JOIN consolidation_runs r USING(run_id) WHERE t.sym=%s AND r.timeframe=%s ORDER BY t.entry_date""",(sym,tf));trades=list(cur)
  missing=outside=0;examples=[]
  for t in trades:
   k=t['entry_date'].strftime('%Y-%m-%d' if tf=='1d' else '%Y-%m-%d %H:%M');b=native.get(k)
   if b is None:missing+=1;continue
   if t['entry']<b['l']-0.0001 or t['entry']>b['h']+0.0001:
    outside+=1
    if len(examples)<5:examples.append({'entry_date':k,'entry':t['entry'],'model':t['model'],'raw_low':b['l'],'raw_high':b['h']})
  report['source_samples'].append({'sym':sym,'tf':tf,'unique_entries':len(trades),'missing_complete_raw_bucket':missing,'entry_outside_raw_bucket':outside,'examples':examples,'source_audit':audit})
  print(sym,tf,len(trades),missing,outside,flush=True)
report['findings']=[{'severity':'HIGH','issue':'Engine feed clips intraday highs/lows and invents daily-OHLC session tails; sampled conformance is not proof of raw source fidelity.'},{'severity':'HIGH','issue':'FULL 1H engine rolls 30m history into session hours while chart requests original 1h tables; chart and engine lineage differ.'},{'severity':'MEDIUM','issue':'Symbol/fate filters previously changed lists but not performance; fixed and reconciled.'},{'severity':'MEDIUM','issue':'CSV previously exported only capped display rows and corrupted nested JSON; fixed with complete server export.'},{'severity':'MEDIUM','issue':'Final box fate is future information; labelled retrospective, cannot be a prospective entry filter.'},{'severity':'MEDIUM','issue':'Exit dates are native-bar start labels, not exact fill times. Open rows have mark-to-market R; excluded from closed performance.'},{'severity':'MEDIUM','issue':'Walk-forward split is a descriptive chronological partition; no evidence of parameters selected using only pre-2022 data.'}]
(ROOT/'public/reports/consolidation-end-to-end-review.json').write_text(json.dumps(report,default=str,indent=2))
print('REVIEW SAVED',flush=True)
