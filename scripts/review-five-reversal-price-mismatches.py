"""Read-only evidence for five incompatible setup/execution price examples."""
import csv
import json
import sys
from pathlib import Path
from psycopg2.extras import RealDictCursor

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(Path.home()/'Desktop/ICT_Automation/realtime_execution'))
from mss_reversal_data import connect

ids=['6fdb7f3dc17c4746','a8191d4ab833ac47','bcd341587f9651c2',
     '5773ed511524b846','c6d0d5338679d215']
with connect() as con,con.cursor(cursor_factory=RealDictCursor) as cur:
    cur.execute("""SELECT t.run_id,t.trade_id,t.sym,t.side,t.entry_date::date entry_day,
        t.entry,t.stop,t.tgt,t.r,t.exit_price,t.exit_date exit_close_ny,t.exit_verified,
        t.exit_evidence,b.outcome original_outcome,b.r original_r,
        f.candle_ts AT TIME ZONE 'America/New_York' claimed_fill_bar_ny,
        f.open_price fill_open,f.high_price fill_high,f.low_price fill_low,
        f.close_price fill_close,f.source fill_source,
        d.open_price daily_open,d.high_price daily_high,d.low_price daily_low,
        d.close_price daily_close,d.source daily_source
        FROM reversal_trades t JOIN reversal_trades_exit_baseline_v1 b USING(run_id,trade_id)
        JOIN historical_candles_5m f ON f.market='us' AND f.base_symbol=t.sym
          AND f.candle_ts=to_timestamp((t.exit_evidence->>'fill_bar_ts')::double precision/1000)
        JOIN candles_1d d ON d.market='us' AND d.base_symbol=t.sym
          AND (d.candle_ts AT TIME ZONE 'America/New_York')::date=t.entry_date::date
        WHERE t.run_id='REV_FULL_k1_reclaim3_20260929' AND t.trade_id=ANY(%s)
        ORDER BY t.r""",(ids,))
    rows=[dict(r) for r in cur.fetchall()]
    for row in rows:
        cur.execute("""SELECT min(low_price) day_low,max(high_price) day_high,count(*) bars
            FROM historical_candles_5m WHERE market='us' AND base_symbol=%s
            AND candle_ts >= %s::date::timestamp AT TIME ZONE 'America/New_York'
            AND candle_ts < (%s::date+1)::timestamp AT TIME ZONE 'America/New_York'
            AND (candle_ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '15:55'""",
            (row['sym'],row['entry_day'],row['entry_day']))
        row.update(dict(cur.fetchone()))
        row['verdict']='Saved entry price outside entire 5m session range; incompatible source price basis. Current verified label and quoted R unsupported.'
        assert row['entry']<row['day_low'] and row['bars']==78
dest=ROOT/'public/reports'
dest.mkdir(parents=True,exist_ok=True)
report={'scope':'FULL / k1_reclaim3 / Daily / OTE62_limit / 2R / hard / primary / risk filter',
        'timezone':'America/New_York','database_changes':False,
        'corrected_R':'Pending reconciliation of source price basis; no replacement R claimed.',
        'examples':rows}
(dest/'reversal-five-price-mismatches.json').write_text(json.dumps(report,default=str,indent=2),encoding='utf-8')
columns=[k for k in rows[0] if k!='exit_evidence']
with (dest/'reversal-five-price-mismatches.csv').open('w',newline='',encoding='utf-8-sig') as out:
    writer=csv.DictWriter(out,fieldnames=columns,extrasaction='ignore')
    writer.writeheader();writer.writerows(rows)
print(json.dumps(report,default=str))
