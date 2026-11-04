"""Read-only GE FULL OTE62/2R/original-hard-cohort entry-range audit."""
import csv,json,sys
from pathlib import Path
from psycopg2.extras import RealDictCursor
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(Path.home()/'Desktop/ICT_Automation/realtime_execution'))
from mss_reversal_data import connect
with connect() as con,con.cursor(cursor_factory=RealDictCursor) as cur:
    cur.execute("""WITH raw AS (
        SELECT candle_ts,low_price,high_price FROM historical_candles_5m WHERE market='us' AND base_symbol='GE'
        UNION ALL SELECT candle_ts,low_price,high_price FROM candles_5m WHERE market='us' AND base_symbol='GE'),
      dr AS (SELECT (candle_ts AT TIME ZONE 'America/New_York')::date session_date,
        min(low_price) raw_low,max(high_price) raw_high FROM raw
        WHERE (candle_ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '15:55' GROUP BY 1)
      SELECT t.run_id,t.trade_id,r.timeframe,t.entry_date::text,t.side,t.entry,t.stop,t.tgt,
        t.outcome,t.r,t.exit_verified,t.exit_evidence->>'reason' current_reason,
        dr.raw_low,dr.raw_high,
        (t.entry<dr.raw_low-0.0001 OR t.entry>dr.raw_high+0.0001) entry_outside_entire_session
      FROM reversal_trades t JOIN reversal_runs r USING(run_id)
      LEFT JOIN dr ON dr.session_date=t.entry_date::date
      WHERE t.sym='GE' AND r.period='FULL' AND r.config_name='k1_reclaim3'
        AND t.model='OTE62_limit' AND t.target='2R' AND t.stop_mode='hard'
        AND t.is_primary AND coalesce(t.risk_ok,true)
      ORDER BY r.timeframe,t.entry_date""")
    rows=[dict(row) for row in cur.fetchall()]
summary={}
for row in rows:
    s=summary.setdefault(row['timeframe'],dict(selected=0,outside_session=0,unverified=0))
    s['selected']+=1;s['outside_session']+=int(bool(row['entry_outside_entire_session']))
    s['unverified']+=int(row['outcome']=='unverified')
report=dict(scope='GE 2017-2026 FULL; k1_reclaim3; OTE62_limit;2R;hard;primary;risk filter',
    database_changes=False,summary=summary,
    limit='Entry inside day range alone does not prove a causal executable fill or source compatibility.',
    findings=['Daily setup source and 5m execution history have incompatible historical price scales.',
      'Replay tests a one-sided limit condition against the saved price without reconciling the source price basis.',
      'Exact floating-point equality also incorrectly rejects equivalent overlapping vendor candles.',
      'Intraday detector clips highs/lows and synthesizes tails from Daily data; source compatibility must be audited there too.'],
    rows=rows)
dest=ROOT/'public/reports';dest.mkdir(parents=True,exist_ok=True)
(dest/'ge-reversal-entry-audit.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
with (dest/'ge-reversal-entry-audit.csv').open('w',newline='',encoding='utf-8-sig') as out:
    writer=csv.DictWriter(out,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
print(json.dumps(summary))
