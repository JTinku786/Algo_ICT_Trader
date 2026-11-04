"""Accept only a complete, independently revalidated eight-run research batch.

Preserve old trade rows, mark old runs quarantined and expose guarded research
views. Writes no live orders and does not deploy the website.
"""
import sys,json,hashlib,datetime as dt,warnings
from pathlib import Path
import pandas as pd,psycopg2
warnings.filterwarnings('ignore',category=UserWarning)
sys.path.insert(0,str(Path(__file__).parent))
import amd_engine as ae
root=Path(__file__).resolve().parents[2]; out=root/'reviews'/'amd_causal_v2_2026-10-14'
out.mkdir(parents=True,exist_ok=True)
con=psycopg2.connect(ae.rv.db_uri())
q="""SELECT DISTINCT ON (timeframe,config_name) * FROM amd_runs
 WHERE params->>'spec_version'='amd-local-v2.1' ORDER BY timeframe,config_name,created_at DESC"""
runs=pd.read_sql_query(q,con)
assert len(runs)==8,f'Expected eight corrected runs, found {len(runs)}'
for r in runs.itertuples():
    audit=r.summary['validation']
    assert not audit['failures'],r.run_id
    if r.family=='structural': assert 'raw confirmed swing, new close-through and displacement' in audit['cycle_checks'],f'{r.run_id}: independent raw structure checks not yet completed'
    if r.family=='structural':
        assert r.params.get('source_hash')==ae.SOURCE_HASH,f'{r.run_id}: final structural code not yet rebuilt'
ids=tuple(runs.run_id)
with con.cursor() as cur:
    cur.execute("""SELECT count(*) FROM amd_trades t LEFT JOIN amd_cycles c USING(run_id,cycle_id)
      WHERE t.run_id IN %s AND (c.cycle_id IS NULL OR t.decision_date>=t.entry_date
       OR t.decision_known_at IS NULL OR t.order_active_at IS NULL OR t.entry_not_before IS NULL
       OR t.decision_known_at>t.order_active_at OR t.order_active_at>t.entry_not_before
       OR (t.model LIKE 'MSS%%' AND (t.mss_known_at IS NULL OR t.mss_known_at>t.decision_known_at OR c.mss_date>=t.entry_date))
       OR (t.model LIKE 'MSS_FVG%%' AND (t.fvg_known_at IS NULL OR t.fvg_known_at>t.decision_known_at)))""",(ids,))
    assert cur.fetchone()[0]==0,'Stored prerequisite violations remain'
    cur.execute("select count(*) from amd_trades where run_id not like 'AMD_V2_%'")
    assert cur.fetchone()[0]==521173,'Legacy trade population changed unexpectedly'
    cur.execute("""UPDATE amd_runs SET summary=summary || jsonb_build_object(
       'eligibility','quarantined_legacy_or_intermediate',
       'quarantine_reason','Superseded: invalid V1 timing/data contract or intermediate pre-final V2 spec; not accepted research trades')
       WHERE coalesce(params->>'spec_version','') IN ('','amd-local-v2')""")
    cur.execute("""UPDATE amd_runs SET summary=summary || jsonb_build_object(
       'eligibility','superseded_research_iteration',
       'quarantine_reason','Earlier V2.1 rebuild; superseded by the final independently revalidated batch')
       WHERE params->>'spec_version'='amd-local-v2.1' AND run_id NOT IN %s""",(ids,))
    cur.execute("""CREATE OR REPLACE VIEW amd_causal_v2_current_runs AS
       SELECT DISTINCT ON (timeframe,period,config_name) * FROM amd_runs
       WHERE params->>'spec_version'='amd-local-v2.1' AND summary->'validation'->'failures'='[]'::jsonb
       ORDER BY timeframe,period,config_name,created_at DESC""")
    cur.execute("""CREATE OR REPLACE VIEW amd_causal_v2_current_trades AS
       SELECT t.* FROM amd_trades t JOIN amd_causal_v2_current_runs r USING(run_id)
       JOIN amd_cycles c USING(run_id,cycle_id)
       WHERE t.decision_known_at IS NOT NULL AND t.order_active_at IS NOT NULL AND t.entry_not_before IS NOT NULL
        AND t.decision_date<t.entry_date AND t.decision_known_at<=t.order_active_at AND t.order_active_at<=t.entry_not_before
        AND (t.model NOT LIKE 'MSS%' OR (t.mss_known_at<=t.decision_known_at AND c.mss_date<t.entry_date))
        AND (t.model NOT LIKE 'MSS_FVG%' OR t.fvg_known_at<=t.decision_known_at)""")
con.commit()
runs.to_json(out/'accepted_runs.json',orient='records',date_format='iso',indent=2)
trades=pd.read_sql_query('select * from amd_causal_v2_current_trades',con)
cycles=pd.read_sql_query('select c.* from amd_cycles c join amd_causal_v2_current_runs r using(run_id)',con)
p=trades[trades.risk_ok & trades.outcome.isin(['win','loss','timeout'])].copy()
p['net5']=p.r-.05/p.risk_pct; p['net10']=p.r-.1/p.risk_pct
grid=p.groupby(['run_id','model','target']).agg(n=('r','size'),profitable_pct=('r',lambda s:100*s.gt(0).mean()),avg_r=('r','mean'),net5=('net5','mean'),net10=('net10','mean')).reset_index()
grid.to_csv(out/'corrected_performance_grid.csv',index=False)
cycles.groupby(['run_id','outcome']).size().reset_index(name='n').to_csv(out/'corrected_cycle_waterfall.csv',index=False)
trades.groupby(['run_id','model','target','outcome','risk_ok']).size().reset_index(name='n').to_csv(out/'corrected_trade_waterfall.csv',index=False)
with con.cursor() as cur:
    cur.execute("""SELECT r.timeframe,r.config_name,c.sym,c.acc_start,c.pierce_date,c.return_date,c.mss_date,c.mss_level,
      t.entry_date,t.entry,t.stop,t.tgt,t.outcome,t.r FROM amd_causal_v2_current_runs r
      JOIN amd_cycles c USING(run_id) JOIN amd_trades t USING(run_id,cycle_id)
      WHERE c.mss_date=c.return_date AND t.model='MSS_CLOSE' AND t.target='2R'
      ORDER BY r.timeframe,r.config_name,c.sym,t.entry_date""")
    recovered=pd.DataFrame(cur.fetchall(),columns=[d[0] for d in cur.description])
recovered.to_csv(out/'recovered_reclaim_candle_mss_entries.csv',index=False)
with con.cursor() as cur:
    cur.execute("""SELECT r.timeframe,r.config_name,c.sym,c.acc_start,c.mss_date,c.fvg,e.fvg_formed_at,
      e.decision_date,e.entry_date,e.planned_entry,e.entry,e.stop,e.tgt,e.outcome,e.r
      FROM amd_causal_v2_current_runs r JOIN amd_cycles c USING(run_id)
      JOIN amd_trades e USING(run_id,cycle_id)
      LEFT JOIN amd_trades ce ON ce.run_id=e.run_id AND ce.cycle_id=e.cycle_id AND ce.model='MSS_FVG' AND ce.target='2R'
      WHERE e.model='MSS_FVG_EDGE' AND e.target='2R' AND ce.trade_id IS NULL AND e.fvg_evidence=c.fvg
      ORDER BY r.timeframe,r.config_name,e.entry_date,c.sym""")
    shallow=pd.DataFrame(cur.fetchall(),columns=[d[0] for d in cur.description])
shallow.to_json(out/'shallow_edge_only_examples.json',orient='records',date_format='iso',indent=2)
files=['scripts/amd/amd_engine.py','scripts/amd/amd_data.py','scripts/amd/amd_validation.py','scripts/amd/validate_amd.py','scripts/amd/test_amd_causal.py','src/app/api/amd/route.ts','src/app/api/amd/chart/route.ts','src/app/components/amd-dashboard.tsx','src/app/components/amd-ict-chart.tsx','src/app/data/amd-session-closes.json','reviews/amd_causal_v2_2026-10-14/engine_session_rebuild_snapshot.py']
manifest=dict(completed_at=dt.datetime.now(dt.timezone.utc).isoformat(),runs=len(runs),cycles=len(cycles),trade_rows=len(trades),closed_risk_rows=len(p),causal_prerequisite_failures=0,legacy_trade_rows_preserved=521173,recovered_same_reclaim_mss_trade_rows=len(recovered),source_hashes={f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in files},run_ids=list(runs.run_id),scope='historical completed-candle research; no broker deployment')
(out/'completion_manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(manifest,indent=2),flush=True)
print(grid[(grid.model.eq('MSS_FVG')&grid.target.eq('liq_2R'))|grid.target.eq('EOD')].round(5).to_string(index=False),flush=True)
con.close()
