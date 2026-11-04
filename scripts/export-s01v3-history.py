"""Read-only export of completed, disjoint historical S01 V3 cohorts."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import sys,json,csv
from pathlib import Path
sys.path.insert(0,r'C:/Users/saite/Desktop/ICT_Automation/Backtesting_ICT_2017')
from db import connect
FULL='s01v3-us-2018-01-16-2025-12-31-10608eb5-37ff0e6c-c52b799c'
ROOT=REPORTS
def main():
 with connect() as c,c.cursor() as q:
  q.execute('select code_hash from s01v3_runs where run_id=%s',(FULL,));code=q.fetchone()[0]
  q.execute("select row_to_json(r) from s01v3_runs r where market='us' and code_hash=%s and start_date>='2018-01-16' and end_date<='2025-12-31' order by start_date,end_date",(code,));runs=[x[0] for x in q.fetchall()]
  q.execute('select code_manifest,published from s01v3_runs where run_id=%s',('s01v3-us-2026-01-01-2026-06-03-10608eb5-768004a5-a12cdd43',));original_manifest,original_published=q.fetchone()
  assert original_published,'2026 publication must be preserved'
  assert all(all(r['code_manifest'].get(k)==v for k,v in original_manifest.items()) for r in runs),'Original strategy files changed'
  if any(x['status']!='complete' for x in runs):raise SystemExit('Historical cohorts not complete')
  ids=[r['run_id'] for r in runs]
  requested=set(next(r for r in runs if r['run_id']==FULL)['universe'])|{s for s in next(r for r in runs if r['run_id']==FULL)['excluded'] if not s.startswith('_')}
  coverage={}
  for year in range(2018,2026):
   included=set().union(*(set(r['universe']) for r in runs if int(r['start_date'][:4])<=year<=int(r['end_date'][:4])))
   coverage[str(year)]={'included':sorted(included),'excluded':sorted(requested-included)}
  q.execute('select state,count(*) from s01v3_setups where run_id=ANY(%s) group by 1 order by 1',(ids,));setup_states=q.fetchall()
  q.execute('select state,count(*) from s01v3_orders where run_id=ANY(%s) group by 1 order by 1',(ids,));order_states=q.fetchall()
  q.execute("select count(*) from s01v3_orders o join s01v3_setups s using(run_id,setup_id) where o.run_id=ANY(%s) and o.state='FILLED' and (o.fill_ts<=s.decision_known_at or not ((o.direction='BUY' and o.stop<o.fill_price and o.tp1>o.fill_price) or (o.direction='SELL' and o.stop>o.fill_price and o.tp1<o.fill_price)))",(ids,));assert q.fetchone()[0]==0,'Causal timing or geometry violation'
  q.execute("select count(*) from s01v3_bias_sessions where run_id=ANY(%s) and exists(select 1 from jsonb_array_elements(payload->'daily_structure') e where (e->>'known_at')::bigint>(payload->>'as_of')::bigint)",(ids,));assert q.fetchone()[0]==0,'Future Daily structure evidence'
  q.execute('select run_id,symbol,status,n_setups,n_orders,n_outcomes from s01v3_progress where run_id=ANY(%s) order by run_id,symbol',(ids,));progress=q.fetchall()
  q.execute("select count(*) from (select symbol,fill_ts,direction,count(DISTINCT run_id) n from s01v3_orders where run_id=ANY(%s) and state='FILLED' group by 1,2,3 having count(DISTINCT run_id)>1) x",(ids,));assert q.fetchone()[0]==0,'Overlapping cohorts double count entries'
  q.execute("select extract(year from o.fill_ts at time zone 'America/New_York')::int,count(*),count(t.setup_id),count(*) filter(where t.r_plan>0),sum(t.r_plan) from s01v3_orders o left join s01v3_outcomes t on t.run_id=o.run_id and t.setup_id=o.setup_id and t.target_no=1 where o.run_id=ANY(%s) and o.state='FILLED' group by 1 order by 1",(ids,));yearly=q.fetchall()
  report={'runs':runs,'progress':progress,'setup_states':setup_states,'order_states':order_states,'coverage_by_year':coverage,'yearly_gross_target1':yearly,'scope':'Unchanged Daily-only S01 V3; 2018-01-16 through 2025-12-31; 8 workers; exchange-scheduled closes. Full-span eligible symbols plus disjoint yearly cohorts for excluded symbols. Zero gap tolerance. Annual boundaries can leave unresolved trades; no later-year exits fabricated. Existing published 2026 run preserved.'}
  (ROOT/'s01-v3-2018-2025-manifest.json').write_text(json.dumps(report,indent=2,default=str),encoding='utf-8')
  exports={'setups':"select row_to_json(s) from s01v3_setups s where run_id=ANY(%s) order by symbol,setup_id",'orders':"select row_to_json(x) from (select o.*,s.payload as strategy_json,(select jsonb_agg(to_jsonb(t) order by target_no) from s01v3_outcomes t where t.run_id=o.run_id and t.setup_id=o.setup_id) as outcomes from s01v3_orders o join s01v3_setups s using(run_id,setup_id) where o.run_id=ANY(%s) order by o.symbol,o.fill_ts,o.setup_id) x"}
  for name,sql in exports.items():
   cur=c.cursor(name=f'export_{name}');cur.itersize=500;cur.execute(sql,(ids,))
   n=0
   with (ROOT/f's01-v3-2018-2025-{name}.jsonl').open('w',encoding='utf-8') as f,(ROOT/f's01-v3-2018-2025-{name}.csv').open('w',newline='',encoding='utf-8') as cf:
    writer=None
    for (row,) in cur:
     f.write(json.dumps(row,default=str)+'\n');n+=1
     if writer is None:
      fields=[k for k in row if k!='strategy_json']+(['strategy_json'] if 'strategy_json' in row else [])
      writer=csv.DictWriter(cf,fieldnames=fields);writer.writeheader()
     writer.writerow({k:json.dumps(v,default=str) if isinstance(v,(dict,list)) else v for k,v in row.items()})
   cur.close();print(name,n)
  text=['# S01 V3 historical signals','',report['scope'],'','| Entry year | Fills | Resolved TP1 | Positive gross TP1 | Gross R |','|---|---:|---:|---:|---:|']
  for y,fills,closed,wins,gross in yearly:text.append(f'| {y} | {fills} | {closed} | {wins} | {gross or 0:+.2f} |')
  text+=['','Gross results above exclude dashboard commissions/slippage and must not be presented as net performance.','', '## Coverage','']
  text+=['The requested universe is the same 31 source tickers, not a reconstruction of historical index membership. Exclusions include incomplete warm-up history as well as gaps inside the report year.','', '| Year | Eligible symbols | Excluded |','|---|---:|---|']
  for year,cov in coverage.items():text.append(f"| {year} | {len(cov['included'])} / {len(requested)} | {', '.join(cov['excluded']) or 'None'} |")
  text+=['','## Cohorts','']
  for r in runs:
   text += [f"- {r['start_date']}–{r['end_date']}: {len(r['universe'])} eligible symbols: {', '.join(r['universe'])}.",f"  Run `{r['run_id']}`; excluded symbols and exact problems recorded in the manifest."]
  (ROOT/'s01-v3-2018-2025-summary.md').write_text('\n'.join(text),encoding='utf-8')
  print(json.dumps(yearly,default=str));print('Completed cohorts',len(runs))
if __name__=='__main__':main()
