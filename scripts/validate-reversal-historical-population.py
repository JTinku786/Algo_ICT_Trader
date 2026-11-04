"""Independent population invariants after canonical rebuild; read-only."""
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from psycopg2.extras import RealDictCursor
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(Path.home()/'Desktop/ICT_Automation/realtime_execution'))
from mss_reversal_data import connect

with connect() as con,con.cursor(cursor_factory=RealDictCursor) as q:
    q.execute("""SELECT count(*) total,count(DISTINCT t.run_id) runs,
        count(*) FILTER(WHERE r.params->>'native_source'='CANONICAL_RAW_5M_V1') canonical,
        count(*) FILTER(WHERE t.setup_valid IS NULL) unaudited,
        count(*) FILTER(WHERE t.setup_valid) valid,
        count(*) FILTER(WHERE t.setup_valid IS FALSE) rejected,
        count(*) FILTER(WHERE t.setup_valid AND (t.filled_at IS NULL OR t.decision_known_at IS NULL OR t.filled_at<=t.decision_known_at)) invalid_clock,
        count(*) FILTER(WHERE t.setup_valid AND NOT(CASE WHEN t.side='bull' THEN t.stop<t.entry AND t.entry<t.tgt ELSE t.tgt<t.entry AND t.entry<t.stop END)) invalid_geometry,
        count(*) FILTER(WHERE t.setup_valid AND (t.entry<(t.exit_evidence->'fill_ohlc'->>'l')::double precision-CASE WHEN coalesce(r.params->>'market','us')='us' THEN 1e-4 ELSE greatest(1e-7,abs(t.entry)*1e-7) END OR t.entry>(t.exit_evidence->'fill_ohlc'->>'h')::double precision+CASE WHEN coalesce(r.params->>'market','us')='us' THEN 1e-4 ELSE greatest(1e-7,abs(t.entry)*1e-7) END)) unattainable_entry,
        count(*) FILTER(WHERE t.outcome='unverified' AND (t.r IS NOT NULL OR t.exit_date IS NOT NULL)) scored_unverified,
        count(*) FILTER(WHERE t.exit_verified AND t.outcome IN('win','loss') AND NOT t.setup_valid) scored_invalid,
        count(*) FILTER(WHERE t.setup_valid AND t.exit_verified AND t.outcome IN('win','loss') AND abs(t.r-CASE WHEN t.side='bull' THEN 1 ELSE -1 END*(t.exit_price-t.entry)/abs(t.entry-t.stop))>1e-8) wrong_r
        FROM reversal_trades t JOIN reversal_runs r USING(run_id)""")
    population=dict(q.fetchone())
    q.execute("""SELECT count(*) total,
        count(*) FILTER(WHERE event_known_at IS NULL OR decision_known_at IS NULL) missing_clock,
        count(*) FILTER(WHERE event_known_at>decision_known_at OR fvg_known_at>decision_known_at) lookahead
        FROM reversal_signals""")
    signals=dict(q.fetchone())
    q.execute("""SELECT run_id,sym,entry_date,entry,stop,tgt,outcome,r,exit_date,exit_price,setup_valid,exit_verified
        FROM reversal_trades WHERE run_id='REV_FULL_k1_reclaim3_20260929' AND sym IN('GE','XOM')
        AND model='OTE62_limit' AND target='2R' AND stop_mode='hard' AND is_primary
        ORDER BY sym,entry_date""")
    regressions=[dict(r) for r in q.fetchall()]
failures={k:v for k,v in population.items() if k in ('unaudited','invalid_clock','invalid_geometry','unattainable_entry','scored_unverified','scored_invalid','wrong_r') and v}
failures.update({k:v for k,v in signals.items() if k in ('missing_clock','lookahead') and v})
if population['canonical']!=population['total']:failures['noncanonical']=population['total']-population['canonical']
report={'asof':datetime.now(timezone.utc).isoformat(),'population':population,'signals':signals,'failures':failures,
        'Verdict':'PASS' if not failures else 'FAIL','rule_source':'LOCAL_ADAPTATION',
        'steps':[{'Step':'Full population causal execution and return invariants','Evidence':population,
                  'Verification':'Every row canonical; valid fills observed after decision; valid geometry; unresolved outcomes unscored; actual exit R agrees.',
                  'Verdict':'PASS' if not failures else 'FAIL'},
                 {'Step':'Signal and FVG clocks','Evidence':signals,'Verification':'No FVG/event known later than decision.','Verdict':'PASS' if not signals['missing_clock'] and not signals['lookahead'] else 'FAIL'}],
        'GE_XOM_regressions':regressions}
out=ROOT/'public/reports/reversal-historical-validation.json';out.write_text(json.dumps(report,default=str,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k!='GE_XOM_regressions'},default=str))
raise SystemExit(bool(failures))
