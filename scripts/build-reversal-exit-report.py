"""Read-only results report for the corrected reversal exit policy."""
import html
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from psycopg2.extras import RealDictCursor

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path.home() / 'Desktop/ICT_Automation/realtime_execution'))
from mss_reversal_data import connect


def query(cur, sql):
    cur.execute(sql)
    return [dict(row) for row in cur.fetchall()]


with connect() as con, con.cursor(cursor_factory=RealDictCursor) as cur:
    realtime = query(cur, """SELECT market,count(*) total,
        count(*) FILTER(WHERE state='CLOSED_TP') wins,
        count(*) FILTER(WHERE state='CLOSED_SL') losses,
        count(*) FILTER(WHERE state='OPEN') open,
        count(*) FILTER(WHERE state='UNVERIFIED') unverified,
        count(*) FILTER(WHERE state='INVALID_EXECUTION') invalid_execution,
        sum(realized_r) FILTER(WHERE state IN('CLOSED_TP','CLOSED_SL')) net_r, min(realized_r) FILTER(WHERE state IN('CLOSED_TP','CLOSED_SL')) worst_r,
        avg(realized_r) FILTER(WHERE state='CLOSED_SL') avg_loss_r,
        sum((strategy_json->'original_exit_outcome'->>'realized_r')::double precision)
          FILTER(WHERE state IN('CLOSED_TP','CLOSED_SL')) original_r_same_closed_rows
        FROM realtime_production_reversal_k1_orders GROUP BY market ORDER BY market""")
    historical = query(cur, """WITH latest AS (
        SELECT DISTINCT ON(coalesce(params->>'market','us'),timeframe,period) *
        FROM reversal_runs WHERE config_name='k1_reclaim3'
        ORDER BY coalesce(params->>'market','us'),timeframe,period,created_at DESC)
        SELECT r.run_id,coalesce(r.params->>'market','us') market,r.timeframe,r.period,
        count(*) total,count(*) FILTER(WHERE t.outcome='win' AND t.exit_verified AND t.setup_valid) wins,
        count(*) FILTER(WHERE t.outcome='loss' AND t.exit_verified AND t.setup_valid) losses,
        count(*) FILTER(WHERE t.outcome='open') open,
        count(*) FILTER(WHERE t.outcome='unverified') unverified,
        count(*) FILTER(WHERE t.setup_valid IS TRUE) validated_setups,
        count(*) FILTER(WHERE t.setup_valid IS FALSE) invalid_setups,
        count(*) FILTER(WHERE t.setup_valid IS NULL) unaudited_setups,
        sum(t.r) FILTER(WHERE t.setup_valid AND t.exit_verified AND t.outcome IN('win','loss')) net_r,min(t.r) FILTER(WHERE t.setup_valid AND t.exit_verified AND t.outcome IN('win','loss')) worst_r,
        count(*) FILTER(WHERE b.trade_id IS NOT NULL) retained_baseline_identities,
        count(*) FILTER(WHERE b.trade_id IS NULL) regenerated_identities,
        sum(b.r) FILTER(WHERE t.outcome IN('win','loss')) original_r_same_closed_rows
        FROM latest r JOIN reversal_trades t USING(run_id)
        LEFT JOIN reversal_trades_exit_baseline_v1 b USING(run_id,trade_id)
        WHERE t.model='OTE62_limit' AND t.target='2R' AND t.stop_mode='hard'
        AND t.is_primary AND coalesce(t.risk_ok,true)
        GROUP BY r.run_id,r.params,r.timeframe,r.period ORDER BY market,r.period,r.timeframe""")
    coverage = query(cur, """SELECT count(*) total,count(DISTINCT run_id) runs,
        count(*) FILTER(WHERE exit_verified IS NOT NULL) replayed,
        count(*) FILTER(WHERE exit_verified) verified,
        count(*) FILTER(WHERE setup_valid IS TRUE) validated_setups,
        count(*) FILTER(WHERE setup_valid IS FALSE) invalid_setups,
        count(*) FILTER(WHERE setup_valid IS NULL) unaudited_setups,
        count(*) FILTER(WHERE outcome='unverified') unverified
        FROM reversal_trades""")[0]
    examples = query(cur, """SELECT ticker,market,timeframe,direction,entry_price,stoploss,tp1,
        close_price,close_ts,realized_r,strategy_json->'exit_evidence' evidence
        FROM realtime_production_reversal_k1_orders WHERE state='CLOSED_SL'
        ORDER BY realized_r LIMIT 3""")
    validation = query(cur, """SELECT
        count(*) FILTER(WHERE t.setup_valid AND t.exit_verified AND t.outcome IN('win','loss')
          AND abs(t.r-(t.exit_price-t.entry)*CASE WHEN t.side='bull' THEN 1 ELSE -1 END/abs(t.entry-t.stop))>1e-8) r_mismatches,
        count(*) FILTER(WHERE t.exit_verified AND t.outcome='loss'
          AND NOT CASE WHEN t.side='bull' THEN t.exit_price<t.stop ELSE t.exit_price>t.stop END) stop_mismatches,
        count(*) FILTER(WHERE t.exit_verified AND t.outcome='win' AND abs(t.exit_price-t.tgt)>1e-8) target_mismatches,
        count(*) FILTER(WHERE t.outcome='unverified' AND (t.r IS NOT NULL OR t.pct IS NOT NULL OR t.exit_date IS NOT NULL)) stale_unverified,
        count(*) FILTER(WHERE (t.entry,t.stop,t.tgt,t.entry_date,t.stop_mode,t.signal_id)
          IS DISTINCT FROM (b.entry,b.stop,b.tgt,b.entry_date,b.stop_mode,b.signal_id)) regenerated_geometry,
        count(*) FILTER(WHERE b.trade_id IS NULL) new_identities
        FROM reversal_trades t LEFT JOIN reversal_trades_exit_baseline_v1 b USING(run_id,trade_id)""")[0]

report = dict(generated_at=datetime.now(timezone.utc).astimezone(ZoneInfo('America/New_York')).isoformat(),
              policy='M5_CLOSE_SL_WICK_TP_V1',realtime=realtime,historical=historical,
              historical_coverage=coverage,loss_examples=examples,validation=validation)
dest = ROOT / 'public/reports'
dest.mkdir(parents=True,exist_ok=True)
(dest/'reversal-exit-rule-results.json').write_text(json.dumps(report,default=str,indent=2),encoding='utf-8')


def fmt(value, key=''):
    if value is None: return '—'
    if isinstance(value,float): return f'{value:,.5f}' if key.endswith('_price') or key=='stoploss' else f'{value:,.2f}'
    return html.escape(str(value))


def table(rows, columns):
    return '<div style="overflow-x:auto"><table><thead><tr>'+''.join('<th>'+label+'</th>' for _,label in columns)+'</tr></thead><tbody>'+''.join(
        '<tr>'+''.join('<td>'+fmt(row.get(key),key)+'</td>' for key,_ in columns)+'</tr>' for row in rows)+'</tbody></table></div>'


page = '''<!doctype html><html><meta charset="utf-8"><title>Reversal exit results</title>
<style>body{font:16px system-ui;background:#0e1726;color:#e6edf7;margin:40px;max-width:1300px}h1,h2{color:#e6bb64}p{line-height:1.6}table{border-collapse:collapse;width:100%;margin:24px 0}td,th{padding:12px;text-align:right;border-bottom:1px solid #334155}th:first-child,td:first-child{text-align:left}small{color:#aab8cc}.rule{padding:20px;background:#1e293b;border-radius:12px}</style>
<h1>Reversal exits · recalculated results</h1><p class="rule">BUY: stop only when a completed 5-minute candle closes below SL. SELL: stop only when it closes above SL. Target exits use the high for BUY and low for SELL. A target touch precedes a same-candle close-stop. Stop losses use the actual close price and may exceed −1R.</p>
<p>Corrected cohorts regenerate setups from validated raw candles; entry geometry and identities may change. Original rows remain in the baseline archive. Exit verification does not certify an ICT setup. No exit timeout. Missing or conflicting source paths are unverified and excluded from performance. These are paper/research results before costs.</p>'''
page += '<h2>Realtime paper trades</h2>'+table(realtime,[('market','Market'),('total','Trades'),('wins','TP'),('losses','SL'),('open','Open'),('unverified','Unverified'),('invalid_execution','Invalid execution'),('net_r','New net R'),('original_r_same_closed_rows','Baseline R matched IDs'),('avg_loss_r','Avg loss R'),('worst_r','Worst R')])
page += '<h2>Current historical dashboard preset</h2><p>Latest k1_reclaim3 runs; OTE62 limit, 2R target, primary entries, risk filter enabled, original hard cohort. Cohorts and periods overlap: do not sum these rows as one portfolio. Historical limit replay starts after the first confirmed 5m fill bar; realtime starts after the confirmed raw 5m fill observation.</p>'
page += table(historical,[('market','Market'),('timeframe','Signal TF'),('period','Period'),('total','Trades'),('wins','TP'),('losses','SL'),('open','Open'),('unverified','Unverified'),('validated_setups','Validated setups'),('invalid_setups','Excluded setups'),('unaudited_setups','Unaudited'),('net_r','New net R'),('original_r_same_closed_rows','Baseline R matched IDs'),('worst_r','Worst R')])
page += '<h2>Full historical coverage</h2><p>'+fmt(coverage['replayed'])+' / '+fmt(coverage['total'])+' saved trade variants replayed across '+fmt(coverage['runs'])+' runs. '+fmt(coverage['unverified'])+' lack sufficient source evidence. Original rows are retained in reversal_trades_exit_baseline_v1.</p>'
page += '<h2>Largest realtime stop losses</h2>'+table(examples,[('ticker','Symbol'),('direction','Direction'),('entry_price','Entry'),('stoploss','SL level'),('close_price','Actual close'),('close_ts','Observed exit'),('realized_r','Actual R')])
execution_checks = {k:v for k,v in validation.items() if k not in ('regenerated_geometry','new_identities')}
page += '<h2>Execution checks</h2><p>Exit-return formula, strict stop-close and target-price checks: '+('passed for stored verified exits.' if not any(execution_checks.values()) else 'review the JSON diagnostics.')+' Regenerated geometry and new identities are expected cohort changes, reported separately. This report queries current stored outcomes; a verified exit is not an ICT setup verdict. Browser/CSV checks must be rerun after the latest rebuild.</p>'
page += '<p>Realtime totals above include all saved rows, including duplicate setup variants. The dashboard default performance excludes duplicates.</p>'
page += '<p><a href="ge-corrected-reversal-results.json">GE corrected trades</a> · <a href="reversal-dashboard-verification.json">Dashboard reconciliation</a> · <a href="reversal-ict-validation.json">ICT step evidence and prefix checks</a> · <a href="reversal-historical-validation.json">Historical population validation</a> · <a href="reversal-k1-realtime.json">Independent realtime reconciliation</a></p>'
page += '<small>Generated '+html.escape(report['generated_at'])+' · Exact values and exit-candle evidence are in reversal-exit-rule-results.json.</small></html>'
(dest/'reversal-exit-rule-results.html').write_text(page,encoding='utf-8')
execution_checks = {k:v for k,v in validation.items() if k not in ('regenerated_geometry','new_identities')}
if coverage['replayed'] == coverage['total'] and coverage['unaudited_setups'] == 0 and not any(execution_checks.values()):
    policy_doc = f'''# Reversal exit policy

Policy: `{report['policy']}`. Generated {report['generated_at']}.

All saved reversal study rows and current realtime k1 paper rows use completed
5-minute candles for exits, independently of their signal timeframe.

- BUY stops only on a close strictly below the configured stop; SELL stops only
  on a close strictly above it. An equal close or wick crossing alone does not stop.
- BUY targets use high >= target; SELL targets use low <= target. A target touch
  precedes a same-candle close-stop. Exit timestamps record completed-bar observation,
  not an invented intrabar touch time.
- Target price is the configured target. Stop exit price is the actual confirming
  candle close. Realized R uses the original entry-to-stop distance, with no loss cap.
- No exit timeout. Missing, invalid or conflicting source paths are unverified;
  their returns and closing fields are null and excluded from performance.

Historical market entries start at native bar open. Historical limits start after
the first validated 5m fill candle; that fill candle is excluded because pre-fill
and post-fill target ordering is unknown. Realtime paper monitoring starts at its
confirmed raw 5m fill observation; native observed_at records later discovery. These entry boundaries must be checked against decision-known-at evidence; exit verification alone does not validate the setup. The boundaries are recorded explicitly
in evidence and are not claims of live broker fills.

Historical replay: {coverage['total']:,} saved variants across {coverage['runs']} runs;
{coverage['unverified']:,} unverified. Original rows are preserved in
`reversal_trades_exit_baseline_v1`. Realtime originals are preserved in each
row's `strategy_json.original_exit_outcome`.

Future persisted reversal engine runs invoke the shared replay; standalone native
CSV diagnostics without a 5m source are unverified. Realtime scheduled scans use the
same stop/target evaluator and retain unresolved source gaps for later rechecking.

Charts retain raw validated source OHLC; isolated supplements fill only timestamps
absent from native/archive feeds. Legacy hard/close cohort labels remain for comparison; regenerated trade IDs can differ from the baseline;
both cohorts now use this exit rule. Old native bars-held/MFE/post-stop metrics are
cleared because they no longer describe the replayed exit path.

These are research/paper returns before fees, spread, slippage and financing.
See [results](../public/reports/reversal-exit-rule-results.html) and
[exact evidence](../public/reports/reversal-exit-rule-results.json).
'''
    (ROOT/'docs/REVERSAL_EXIT_POLICY.md').write_text(policy_doc,encoding='utf-8')
print(json.dumps(report,default=str))
