"""Reconcile the actual Reversal API population and raw R with Postgres."""
import json,sys
from pathlib import Path
from datetime import datetime,timezone
import requests
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(Path.home()/'Desktop/ICT_Automation/realtime_execution'))
from mss_reversal_data import connect
result=[]
for tf,period in [('1d','FULL'),('1h','FULL'),('30m','FULL'),('1d','2026'),('1d','FX_FULL')]:
 response=requests.get('http://localhost:3000/api/reversal',params={'tf':tf,'period':period},timeout=180)
 response.raise_for_status();data=response.json();assert data['ok'],data
 run=data['runId'];trades=data['trades']
 with connect() as con,con.cursor() as q:
  q.execute("""SELECT count(*),count(*) FILTER(WHERE setup_valid AND exit_verified AND outcome IN('win','loss','timeout')),
      sum(r) FILTER(WHERE setup_valid AND exit_verified AND outcome IN('win','loss','timeout'))
      FROM reversal_trades WHERE run_id=%s AND outcome IS NOT NULL AND is_primary AND coalesce(risk_ok,true)
      AND model='OTE62_limit' AND target='2R' AND stop_mode='hard'""",(run,))
  population,scored,net_r=q.fetchone()
 assert len(trades)==population,(tf,period,len(trades),population)
 api_scored=[t for t in trades if t['setup_valid'] is True and t['exit_verified'] is True and t['outcome'] in ('win','loss','timeout')]
 assert len(api_scored)==scored
 assert abs(sum(t['r'] for t in api_scored)-(net_r or 0))<1e-7
 grid=next((g for g in data['grid'] if g['model']=='OTE62_limit' and g['target']=='2R' and g['stop_mode']=='hard'),None)
 assert (grid['n'] if grid else 0)==scored
 if grid:assert abs(grid['sum_r']-(net_r or 0))<1e-7
 for trade in trades:
  if trade['outcome']=='unverified':assert trade['r'] is None and trade['exit_date'] is None
 result.append({'timeframe':tf,'period':period,'run_id':run,'api_rows':len(trades),'stored_rows':population,'scored_rows':scored,'raw_net_r':net_r,'Verdict':'PASS'})
report={'asof':datetime.now(timezone.utc).isoformat(),'Verdict':'PASS','checks':result}
(ROOT/'public/reports/reversal-dashboard-verification.json').write_text(json.dumps(report,default=str,indent=2),encoding='utf-8')
print(json.dumps(report,default=str))
